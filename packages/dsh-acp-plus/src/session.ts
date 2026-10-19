/**
 * Session bridge: owns the ACP session records, drives DSH agents, and turns
 * DSH events into ACP updates plus `_dsh/event` mirrors.
 * @module dsh-acp-plus/session
 */
import { randomUUID } from 'node:crypto';
import { RequestError } from '@agentclientprotocol/sdk';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { parseCommand } from '@deepseek-ai/dsh-commands';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import {
  applyConfigOption,
  buildConfigOptions,
  type ModelSelectionState,
} from './config-options.js';
import { ContentError, promptToDshContent } from './content.js';
import {
  errorMessage,
  isAbsolutePath,
  jsonSafe,
  sameDirectory,
  service,
  type DshContext,
  type DshEvent,
  type Logger,
} from './dsh-types.js';
import {
  EXT_EVENT,
  EXT_FRAME,
  EXT_QUESTIONS,
  dshMeta,
  eventNotification,
  frameNotification,
  updateMeta,
} from './meta.js';
import { mcpPluginConfig, resolveMcpConfigs, type McpServerConfig } from './mcp.js';
import { projectEvent, usageFromEvent } from './projection.js';
import { inferToolKind } from './tool-projection.js';
import { StreamAccumulator } from './stream.js';

export interface ClientLike {
  notify(method: string, params?: unknown): Promise<void>;
  request<Response = any>(method: string, params?: unknown, options?: unknown): Promise<Response>;
}

export interface BridgeDeps {
  ctx: DshContext;
  log: Logger;
  pageSize: number;
  questionTimeoutMs: number;
  replayLimit: number;
  defaultProvider?: string;
  defaultModel?: string;
  getClient(): ClientLike | null;
  imageEnabled(): boolean;
}

export interface SessionRecord {
  id: string;
  cwd: string;
  agent: any;
  handle: any;
  caps: any;
  paseo: Record<string, any>;
  preapproved: Set<string>;
  selectionRef: { current: ModelSelectionState | undefined; assembled: ModelSelectionState | undefined };
  stream: StreamAccumulator;
  streamedSteps: Set<string>;
  pendingTurn: { resolve: (reason: any) => void } | null;
  permissions: Map<string, (outcome: string) => void>;
  questions: Map<string, (answer: any) => void>;
  approvalPolicy?: string;
  sandboxMode?: string;
  state: 'loading' | 'ready' | 'prompting' | 'closed';
  lastUsage?: any;
  lastTurnEnd?: any;
  imageEnabled: boolean;
  createdAt: number;
  title?: string;
  outbound: Promise<void>;
  inFlightRequestId?: string;
}

export function invalidParams(message: string): Error {
  return requestError(-32602, message);
}

function requestError(code: number, message: string, data?: unknown): Error {
  return new RequestError(code, message, data);
}

export function resourceNotFound(message: string): Error {
  return requestError(-32002, message);
}

export function internalError(message: string): Error {
  return requestError(-32603, message);
}

function compactSelection(selection: ModelSelectionState | undefined): Record<string, string> | undefined {
  if (!selection) return undefined;
  const out: Record<string, string> = {};
  if (selection.provider) out.provider = selection.provider;
  if (selection.model) out.model = selection.model;
  if (selection.reasoningEffort) out.reasoningEffort = selection.reasoningEffort;
  return Object.keys(out).length > 0 ? out : undefined;
}

function preapprovedNames(toolPolicy: any): Set<string> {
  const names = new Set<string>();
  const entries = Array.isArray(toolPolicy?.preapproved) ? toolPolicy.preapproved : [];
  for (const entry of entries) {
    if (!entry || entry.kind !== 'mcp') continue;
    const server = String(entry.server ?? '');
    const tool = String(entry.tool ?? '');
    if (!server || !tool) continue;
    names.add(`mcp__${server}__${tool}`);
    names.add(`${server}:${tool}`);
    names.add(`${server}__${tool}`);
    names.add(tool);
  }
  return names;
}

function extractPaseo(meta: unknown): Record<string, any> {
  if (!meta || typeof meta !== 'object') return {};
  const paseo = (meta as Record<string, any>).paseo;
  return paseo && typeof paseo === 'object' ? (paseo as Record<string, any>) : {};
}

function headerCwd(header: any): string | undefined {
  const cwd = header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^offset:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return Number(match[1]);
  } catch {
    throw invalidParams('invalid cursor');
  }
}

export class SessionBridge {
  readonly sessions = new Map<string, SessionRecord>();
  private closed = false;

  constructor(private readonly deps: BridgeDeps) {}

  // ---------------------------------------------------------------- lifecycle

  createRecord(input: {
    id: string;
    cwd: string;
    caps: any;
    paseo: Record<string, any>;
    state: SessionRecord['state'];
  }): SessionRecord {
    return {
      id: input.id,
      cwd: input.cwd,
      agent: null,
      handle: null,
      caps: input.caps ?? {},
      paseo: input.paseo ?? {},
      preapproved: preapprovedNames(input.paseo?.toolPolicy),
      selectionRef: { current: undefined, assembled: undefined },
      stream: new StreamAccumulator(),
      streamedSteps: new Set(),
      pendingTurn: null,
      permissions: new Map(),
      questions: new Map(),
      state: input.state,
      imageEnabled: this.deps.imageEnabled(),
      createdAt: Date.now(),
      outbound: Promise.resolve(),
    };
  }

  private queue(record: SessionRecord, task: () => Promise<void>): void {
    record.outbound = record.outbound.then(task, task).catch((error) => {
      this.deps.log.debug(`acp-plus outbound failed: ${errorMessage(error)}`);
    });
  }

  private async sendUpdate(record: SessionRecord, update: Record<string, unknown>): Promise<void> {
    const client = this.deps.getClient();
    if (!client) return;
    await client.notify('session/update', { sessionId: record.id, update });
  }

  private publishUpdate(record: SessionRecord, update: Record<string, unknown>): void {
    this.queue(record, () => this.sendUpdate(record, update));
  }

  private publishEvent(record: SessionRecord, event: DshEvent): void {
    this.queue(record, async () => {
      const client = this.deps.getClient();
      if (!client) return;
      await client.notify(EXT_EVENT, eventNotification(record.id, event));
    });
  }

  private async sendConfigUpdate(record: SessionRecord): Promise<void> {
    const configOptions = await buildConfigOptions(this.deps.ctx, record);
    await this.sendUpdate(record, {
      sessionUpdate: 'config_option_update',
      configOptions,
      _meta: dshMeta('update.config_option_update', { native: null, reason: 'external-change' }),
    });
  }

  private publishConfigUpdate(record: SessionRecord): void {
    this.queue(record, () => this.sendConfigUpdate(record));
  }

  /** Advertise the agent's slash commands on the standard update channel. */
  private publishCommands(record: SessionRecord): void {
    const commands = service<any>(this.deps.ctx, 'commands');
    if (!commands?.list) return;
    let listed: any[] = [];
    try {
      listed = commands.list(record.agent) ?? [];
    } catch {
      return;
    }
    const availableCommands = listed.map((command: any) => ({
      name: String(command?.name ?? ''),
      description: String(command?.description ?? ''),
      ...(command?.input?.hint ? { input: { hint: String(command.input.hint) } } : {}),
    }));
    if (availableCommands.length === 0) return;
    this.publishUpdate(record, {
      sessionUpdate: 'available_commands_update',
      availableCommands,
      _meta: dshMeta('update.available_commands_update', { native: jsonSafe(listed) }),
    });
  }

  // ------------------------------------------------------------- session open

  async newSession(params: any): Promise<any> {
    const cwd = this.requireCwd(params?.cwd);
    if (Array.isArray(params?.additionalDirectories) && params.additionalDirectories.length > 0) {
      throw invalidParams('additionalDirectories is not supported by this agent');
    }
    const mcpConfigs = resolveMcpConfigs(params?.mcpServers, cwd);
    const paseo = extractPaseo(params?._meta);
    const sessionId = randomUUID();
    const record = this.createRecord({ id: sessionId, cwd, caps: this.currentCaps, paseo, state: 'loading' });
    record.selectionRef.current = this.defaultSelection();
    try {
      const handle = await this.createAgent(record, mcpConfigs);
      record.agent = handle.agent;
      record.handle = handle;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw internalError(`failed to create the session: ${errorMessage(error)}`);
    }
    this.sessions.set(sessionId, record);
    record.state = 'ready';
    this.publishCommands(record);
    const configOptions = await buildConfigOptions(this.deps.ctx, record);
    return {
      sessionId,
      configOptions,
      _meta: dshMeta('session-new', {
        cwd,
        paseo: jsonSafe(paseo),
        mcpServers: mcpConfigs.map((config) => ({ serverName: config.serverName, transport: config.transport })),
      }),
    };
  }

  async loadSession(params: any): Promise<any> {
    const sessionId = String(params?.sessionId ?? '');
    const cwd = this.requireCwd(params?.cwd);
    if (this.sessions.has(sessionId)) throw invalidParams(`session is already open: ${sessionId}`);
    const query = service<any>(this.deps.ctx, 'sessionQuery');
    if (!query?.readSession) throw internalError('session/load is unavailable: sessionQuery is not mounted');
    let snapshot: any;
    try {
      snapshot = await query.readSession(sessionId);
    } catch (error) {
      throw resourceNotFound(`unknown session: ${sessionId} (${errorMessage(error)})`);
    }
    const storedCwd = headerCwd(snapshot?.session);
    if (!storedCwd) throw invalidParams('stored session has no working directory');
    if (!sameDirectory(cwd, storedCwd)) throw invalidParams('cwd does not match the stored session');
    const mcpConfigs = resolveMcpConfigs(params?.mcpServers, cwd);
    const record = this.createRecord({
      id: sessionId,
      cwd: storedCwd,
      caps: this.currentCaps,
      paseo: extractPaseo(params?._meta),
      state: 'loading',
    });
    this.sessions.set(sessionId, record);
    try {
      this.replay(record, snapshot?.events ?? []);
      await record.outbound;
      const handle = await this.createAgent(record, mcpConfigs, { resume: true });
      record.agent = handle.agent;
      record.handle = handle;
      record.state = 'ready';
    } catch (error) {
      this.sessions.delete(sessionId);
      throw internalError(`failed to load the session: ${errorMessage(error)}`);
    }
    this.publishCommands(record);
    const configOptions = await buildConfigOptions(this.deps.ctx, record);
    return {
      configOptions,
      _meta: dshMeta('session-load', {
        cwd: storedCwd,
        inheritedEventCount: snapshot?.inheritedEventCount,
        replayed: Array.isArray(snapshot?.events) ? snapshot.events.length : 0,
      }),
    };
  }

  async resumeSession(params: any): Promise<any> {
    const sessionId = String(params?.sessionId ?? '');
    const cwd = this.requireCwd(params?.cwd);
    if (this.sessions.has(sessionId)) throw invalidParams(`session is already open: ${sessionId}`);
    const persistence = service<any>(this.deps.ctx, 'sessionPersistence');
    const snapshot = persistence?.stat ? await persistence.stat(sessionId).catch(() => undefined) : undefined;
    if (persistence?.stat && !snapshot) throw resourceNotFound(`unknown session: ${sessionId}`);
    const storedCwd = headerCwd(snapshot?.header) ?? cwd;
    if (!sameDirectory(cwd, storedCwd)) throw invalidParams('cwd does not match the stored session');
    const mcpConfigs = resolveMcpConfigs(params?.mcpServers, storedCwd);
    const record = this.createRecord({
      id: sessionId,
      cwd: storedCwd,
      caps: this.currentCaps,
      paseo: extractPaseo(params?._meta),
      state: 'loading',
    });
    this.sessions.set(sessionId, record);
    try {
      const handle = await this.createAgent(record, mcpConfigs, { resume: true });
      record.agent = handle.agent;
      record.handle = handle;
      record.state = 'ready';
    } catch (error) {
      this.sessions.delete(sessionId);
      throw internalError(`failed to resume the session: ${errorMessage(error)}`);
    }
    this.publishCommands(record);
    const configOptions = await buildConfigOptions(this.deps.ctx, record);
    return {
      configOptions,
      _meta: dshMeta('session-resume', { cwd: storedCwd }),
    };
  }

  async listSessions(params: any): Promise<any> {
    const persistence = service<any>(this.deps.ctx, 'sessionPersistence');
    if (!persistence?.list) throw internalError('session/list is unavailable: sessionPersistence is not mounted');
    const query = service<any>(this.deps.ctx, 'sessionQuery');
    const snapshots = (await persistence.list()) ?? [];
    const rows = snapshots
      .map((snapshot: any) => ({ header: snapshot?.header ?? {}, revision: snapshot?.revision }))
      .filter((row: any) => {
        const cwd = headerCwd(row.header);
        return Boolean(cwd) && isAbsolutePath(cwd as string) && !row.header?.parentSession && row.header?.origin !== 'subagent';
      })
      .sort((a: any, b: any) => {
        const left = Number(a.header?.createdAt ?? 0);
        const right = Number(b.header?.createdAt ?? 0);
        if (left !== right) return right - left;
        return String(b.header?.id ?? '').localeCompare(String(a.header?.id ?? ''));
      });
    const requestedCwd = typeof params?.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined;
    const filtered = requestedCwd
      ? rows.filter((row: any) => sameDirectory(headerCwd(row.header)!, requestedCwd as string))
      : rows;
    const start = typeof params?.cursor === 'string' && params.cursor.length > 0 ? decodeCursor(params.cursor) : 0;
    if (start > filtered.length) throw invalidParams('invalid cursor');
    const page = filtered.slice(start, start + this.deps.pageSize);
    const sessions = await Promise.all(
      page.map(async (row: any) => {
        const id = String(row.header.id);
        let title: string | undefined;
        let updatedAt: string | undefined;
        if (query?.readTitle) {
          try {
            const snapshot = await query.readTitle(id);
            if (snapshot?.title) title = String(snapshot.title);
            updatedAt = toIso(snapshot?.updatedAt);
          } catch {
            /* title is optional */
          }
        }
        if (!updatedAt) updatedAt = toIso(row.header?.createdAt);
        return {
          sessionId: id,
          cwd: headerCwd(row.header),
          ...(title ? { title } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          _meta: dshMeta('session-list-item', {
            parentSession: row.header?.parentSession,
            isSeeded: row.header?.isSeeded === true,
            createdAt: toIso(row.header?.createdAt),
          }),
        };
      }),
    );
    const nextOffset = start + page.length;
    return {
      sessions,
      ...(nextOffset < filtered.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      _meta: dshMeta('session-list', { total: filtered.length, offset: start }),
    };
  }

  async closeSession(params: any): Promise<any> {
    const sessionId = String(params?.sessionId ?? '');
    const record = this.sessions.get(sessionId);
    if (!record) return { _meta: dshMeta('session-close', { alreadyClosed: true }) };
    await this.closeRecord(record);
    return { _meta: dshMeta('session-close', {}) };
  }

  async closeRecord(record: SessionRecord): Promise<void> {
    if (record.state === 'closed') return;
    record.state = 'closed';
    for (const resolve of record.permissions.values()) resolve('cancelled');
    record.permissions.clear();
    for (const resolve of record.questions.values()) resolve(new Error('session closed'));
    record.questions.clear();
    if (record.pendingTurn) {
      const pending = record.pendingTurn;
      record.pendingTurn = null;
      pending.resolve({ kind: 'aborted', reason: { kind: 'disposed' } });
    }
    try {
      record.agent?.cancel?.({ kind: 'disposed' });
    } catch {
      /* ignore */
    }
    try {
      await record.handle?.dispose?.();
    } catch (error) {
      this.deps.log.warn(`acp-plus: disposing session ${record.id} failed: ${errorMessage(error)}`);
    }
    this.sessions.delete(record.id);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    for (const record of [...this.sessions.values()]) {
      await this.closeRecord(record);
    }
  }

  // ---------------------------------------------------------------- prompting

  async prompt(params: any): Promise<any> {
    const record = this.requireSession(params?.sessionId);
    if (record.state === 'prompting') throw invalidParams('a prompt is already in flight for this session');
    if (record.state !== 'ready') throw invalidParams('session is not ready');
    const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
    const commandLine = commandLineOf(blocks);
    if (commandLine) {
      const parsed = parseCommand(commandLine);
      const commands = service<any>(this.deps.ctx, 'commands');
      if (parsed && commands?.find?.(record.agent, parsed.name)) {
        return this.runCommand(record, commandLine);
      }
    }
    const attachments = service<any>(this.deps.ctx, 'attachments');
    let content: any[];
    try {
      const converted = await promptToDshContent(blocks, attachments, record.imageEnabled);
      content = converted.content;
    } catch (error) {
      throw invalidParams(errorMessage(error));
    }
    record.state = 'prompting';
    record.stream = new StreamAccumulator();
    record.streamedSteps.clear();
    const done = new Promise<any>((resolve) => {
      record.pendingTurn = { resolve };
    });
    try {
      record.agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'user' },
      });
      const reason = await done;
      return this.promptResponse(record, reason);
    } finally {
      restoreReady(record);
    }
  }

  private async runCommand(record: SessionRecord, line: string): Promise<any> {
    const commands = service<any>(this.deps.ctx, 'commands');
    record.state = 'prompting';
    try {
      const controller = new AbortController();
      const execution = await commands.execute(record.agent, line, [], controller.signal);
      if (!execution) throw invalidParams(`unknown command: ${line}`);
      return {
        stopReason: 'end_turn',
        _meta: dshMeta('prompt-result', {
          command: {
            commandId: execution.commandId,
            kind: execution.result?.kind,
            text: execution.result?.text,
            sourceEventSeq: execution.result?.sourceEventSeq,
          },
        }),
      };
    } finally {
      restoreReady(record);
    }
  }

  private promptResponse(record: SessionRecord, reason: any): any {
    return {
      stopReason: stopReasonOf(reason),
      ...(record.lastUsage ? { usage: acpUsage(record.lastUsage) } : {}),
      _meta: dshMeta('prompt-result', {
        turnEnd: jsonSafe(reason),
        usage: jsonSafe(record.lastUsage),
        messageId: record.stream.messageId(),
      }),
    };
  }

  cancel(sessionId: string): void {
    const record = this.sessions.get(String(sessionId));
    if (!record) return;
    try {
      record.agent?.cancel?.({ kind: 'user' });
    } catch (error) {
      this.deps.log.debug(`acp-plus: cancel failed: ${errorMessage(error)}`);
    }
  }

  async setConfigOption(params: any): Promise<any> {
    const record = this.requireSession(params?.sessionId);
    try {
      applyConfigOption(this.deps.ctx, record, String(params?.configId ?? ''), params?.value);
    } catch (error) {
      throw invalidParams(errorMessage(error));
    }
    const configOptions = await buildConfigOptions(this.deps.ctx, record);
    return {
      configOptions,
      _meta: dshMeta('session-config', { configId: params?.configId, value: params?.value }),
    };
  }

  // -------------------------------------------------------------------- fork

  async fork(params: any): Promise<any> {
    const sourceId = String(params?.sessionId ?? '');
    const query = service<any>(this.deps.ctx, 'sessionQuery');
    if (!query?.readSession) throw internalError('session/fork is unavailable: sessionQuery is not mounted');
    let snapshot: any;
    try {
      snapshot = await query.readSession(sourceId);
    } catch (error) {
      throw resourceNotFound(`unknown session: ${sourceId} (${errorMessage(error)})`);
    }
    const cwd = headerCwd(snapshot?.session);
    if (!cwd) throw invalidParams('stored session has no working directory');
    if (typeof params?.cwd === 'string' && params.cwd.length > 0 && !sameDirectory(params.cwd, cwd)) {
      throw invalidParams('fork must keep the source working directory');
    }
    const events: DshEvent[] = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const boundary = resolveBoundary(events, params?.atSeq);
    const prefix = events.filter((event) => event.seq <= boundary);
    const seed = buildForkSeed(prefix as any, boundary as any);
    const newId = randomUUID();
    const record = this.createRecord({ id: newId, cwd, caps: this.currentCaps, paseo: {}, state: 'loading' });
    record.selectionRef.current = this.defaultSelection();
    try {
      const handle = await this.deps.ctx.agents.create({
        sessionId: newId,
        seed,
        inheritedEventCount: boundary + 1,
        meta: { cwd, parentSession: sourceId, isSeeded: true },
        agentOptions: compactSelection(record.selectionRef.current),
        setup: this.setupFor(record),
      });
      record.agent = handle.agent;
      record.handle = handle;
    } catch (error) {
      this.sessions.delete(newId);
      throw internalError(`failed to fork the session: ${errorMessage(error)}`);
    }
    this.sessions.set(newId, record);
    record.state = 'ready';
    this.publishCommands(record);
    const configOptions = await buildConfigOptions(this.deps.ctx, record);
    const lineage = {
      parentSessionId: sourceId,
      inheritedEventCount: boundary + 1,
      isSeeded: true,
      cwd,
    };
    return {
      sessionId: newId,
      configOptions,
      lineage,
      _meta: dshMeta('session-fork', { lineage }),
    };
  }

  // ----------------------------------------------------------- agent plumbing

  private setupFor(record: SessionRecord) {
    return async (agentCtx: any, agent: any) => {
      record.agent = agent;
      if (agentCtx?.systemPrompt?.section && typeof record.paseo?.systemPrompt === 'string' && record.paseo.systemPrompt.length > 0) {
        agentCtx.systemPrompt.section({
          name: 'acp-plus/paseo-system-prompt',
          order: 250,
          text: record.paseo.systemPrompt,
        });
      }
      try {
        installModelSelection(agentCtx, record.selectionRef as any);
      } catch (error) {
        this.deps.log.debug(`acp-plus: model selection install failed: ${errorMessage(error)}`);
      }
      agentCtx.on('session/event', (_session: any, event: any) => {
        void this.onEvent(record, event);
      });
      agentCtx.on('approval/request', (request: any, next: any) => this.onApproval(record, request, next));
      agentCtx.on('user-questions/request', (request: any, next: any) => this.onQuestion(record, request, next));
      agentCtx.on('agent/assistant-stream', (payload: any) => this.onFrame(record, payload?.frame));
    };
  }

  private async createAgent(
    record: SessionRecord,
    mcpConfigs: readonly McpServerConfig[],
    options: { resume?: boolean } = {},
  ): Promise<any> {
    const agentOptions = compactSelection(record.selectionRef.current);
    const setup = async (agentCtx: any, agent: any) => {
      record.agent = agent;
      await this.setupFor(record)(agentCtx, agent);
      for (const config of mcpConfigs) {
        await agentCtx.plugin(McpClient, mcpPluginConfig(config));
      }
    };
    if (options.resume) {
      return this.deps.ctx.agents.resume({
        resumeSessionId: record.id,
        ...(agentOptions ? { agentOptions } : {}),
        setup,
      });
    }
    return this.deps.ctx.agents.create({
      sessionId: record.id,
      meta: { cwd: record.cwd },
      ...(agentOptions ? { agentOptions } : {}),
      setup,
    });
  }

  // ------------------------------------------------------------------ events

  private async onEvent(record: SessionRecord, event: DshEvent): Promise<void> {
    if (!event || record.state === 'closed') return;
    this.publishEvent(record, event);
    const updates = projectEvent(event, { replay: false, streamedSteps: record.streamedSteps });
    for (const update of updates) this.publishUpdate(record, update);
    const usage = usageFromEvent(event);
    if (usage) {
      record.lastUsage = usage;
      this.publishUsage(record, usage);
    }
    switch (event.type) {
      case 'turn/end': {
        record.lastTurnEnd = (event.data as any)?.reason;
        const pending = record.pendingTurn;
        record.pendingTurn = null;
        if (pending) pending.resolve((event.data as any)?.reason);
        break;
      }
      case 'approval/policy':
        record.approvalPolicy = (event.data as any)?.policy;
        this.publishConfigUpdate(record);
        break;
      case 'sandbox/mode':
        record.sandboxMode = (event.data as any)?.mode;
        this.publishConfigUpdate(record);
        break;
      case 'plan/mode':
      case 'model/selection':
        this.publishConfigUpdate(record);
        break;
      case 'session/title':
        record.title = (event.data as any)?.title;
        break;
      default:
        break;
    }
  }

  private onFrame(record: SessionRecord, frame: any): void {
    if (!frame || record.state === 'closed') return;
    this.queue(record, async () => {
      const client = this.deps.getClient();
      if (client) await client.notify(EXT_FRAME, frameNotification(record.id, frame));
    });
    if (frame.type === 'start' && typeof frame.turn === 'number' && typeof frame.step === 'number') {
      record.streamedSteps.add(`${frame.turn}:${frame.step}`);
    }
    const deltas = record.stream.push(frame);
    for (const delta of deltas) {
      this.publishUpdate(record, {
        sessionUpdate: delta.kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
        content: { type: 'text', text: delta.text },
        messageId: delta.messageId,
        _meta: updateMeta(delta.kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', frame, {
          attemptId: frame.attemptId,
          revision: frame.revision,
          turn: frame.turn,
          step: frame.step,
        }),
      });
    }
  }

  private publishUsage(record: SessionRecord, usage: any): void {
    this.queue(record, async () => {
      const ctx = this.deps.ctx;
      let used: number | undefined;
      let size: number | undefined;
      try {
        const meter = service<any>(ctx, 'tokenMeter');
        const measurement = meter?.measure?.(record.agent?.session);
        if (measurement && Number.isFinite(measurement.totalTokens)) used = Number(measurement.totalTokens);
      } catch {
        /* measurement is best-effort */
      }
      try {
        const context = record.agent?.session?.requestContext?.();
        if (context && Number.isFinite(context.contextWindow)) size = Number(context.contextWindow);
      } catch {
        /* context window is optional */
      }
      if (used === undefined || size === undefined) return;
      const client = this.deps.getClient();
      if (!client) return;
      await client.notify('session/update', {
        sessionId: record.id,
        update: {
          sessionUpdate: 'usage_update',
          used,
          size,
          _meta: updateMeta('usage_update', usage, { turnUsage: jsonSafe(usage) }),
        },
      });
    });
  }

  // -------------------------------------------------------------- approvals

  private isPreapproved(record: SessionRecord, toolName: string): boolean {
    return record.preapproved.has(toolName);
  }

  private async onApproval(record: SessionRecord, request: any, next: () => Promise<any>): Promise<any> {
    const toolName = String(request?.toolName ?? 'tool');
    if (this.isPreapproved(record, toolName)) return 'allowed-once';
    const client = this.deps.getClient();
    if (!client) return next();
    const toolCallId = request?.callId ? String(request.callId) : `approval:${randomUUID()}`;
    try {
      const response = await client.request('session/request_permission', {
        sessionId: record.id,
        toolCall: {
          toolCallId,
          title: toolName,
          kind: inferToolKind(toolName),
          status: 'pending',
          ...(request?.reason ? { rawInput: { reason: String(request.reason) } } : {}),
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
        _meta: dshMeta('permission-request', {
          native: jsonSafe(request),
          toolName,
          callId: request?.callId,
          reason: request?.reason,
          displayReason: request?.displayReason,
        }),
      });
      const outcome = response?.outcome;
      if (outcome?.outcome === 'selected') {
        return outcome.optionId === 'allow_once' ? 'allowed-once' : 'rejected';
      }
      return 'cancelled';
    } catch (error) {
      this.deps.log.warn(`acp-plus: permission request failed: ${errorMessage(error)}`);
      return 'unavailable';
    }
  }

  // -------------------------------------------------------------- questions

  private async onQuestion(record: SessionRecord, request: any, next: () => Promise<any>): Promise<any> {
    const client = this.deps.getClient();
    if (!client) {
      throw internalError('the connected client does not support interactive questions');
    }
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (questions.length === 0) return next();
    const headers = new Map<string, string>();
    const payload = questions.map((question: any, index: number) => {
      const id = String(question?.id ?? `q${index + 1}`);
      let header = typeof question?.header === 'string' && question.header.length > 0 ? question.header : `Question ${index + 1}`;
      while (headers.has(header)) header = `${header} (${index + 1})`;
      headers.set(header, id);
      return {
        id,
        header,
        question: String(question?.question ?? ''),
        ...(question?.detail ? { detail: String(question.detail) } : {}),
        options: Array.isArray(question?.options)
          ? question.options.map((option: any) => ({
              label: String(option?.label ?? ''),
              ...(option?.description ? { description: String(option.description) } : {}),
            }))
          : [],
        multiSelect: question?.multiSelect === true,
      };
    });
    let response: any;
    try {
      response = await client.request(
        EXT_QUESTIONS,
        {
          v: 1,
          requestId: String(request?.wait?.callId ?? randomUUID()),
          sessionId: record.id,
          timeoutMs: this.deps.questionTimeoutMs,
          questions: payload,
        },
        request?.signal ? { signal: request.signal } : undefined,
      );
    } catch (error) {
      throw internalError(`interactive questions are unavailable: ${errorMessage(error)}`);
    }
    const answers = Array.isArray(response?.answers) ? response.answers : [];
    const byId = new Map<string, any>();
    for (const answer of answers) {
      if (answer && typeof answer === 'object' && answer.id !== undefined) byId.set(String(answer.id), answer);
    }
    const items: any[] = [];
    for (const question of questions) {
      const id = String(question?.id ?? '');
      const answer = byId.get(id);
      if (!answer) throw internalError(`client did not answer question ${id}`);
      const selected = Array.isArray(answer.selected) ? answer.selected.map((value: unknown) => String(value)) : [];
      const custom = typeof answer.custom === 'string' && answer.custom.length > 0 ? answer.custom : undefined;
      if (selected.length === 0 && custom === undefined) {
        throw internalError(`client returned an empty answer for question ${id}`);
      }
      items.push({ id, selected, ...(custom !== undefined ? { custom } : {}) });
    }
    return { answers: items };
  }

  // ------------------------------------------------------------------ replay

  private replay(record: SessionRecord, events: readonly DshEvent[]): void {
    const limit = this.deps.replayLimit;
    const selected = limit > 0 && events.length > limit ? events.slice(events.length - limit) : events;
    for (const event of selected) {
      this.publishEvent(record, event);
      const updates = projectEvent(event, { replay: true, streamedSteps: record.streamedSteps });
      for (const update of updates) this.publishUpdate(record, update);
    }
  }

  // ------------------------------------------------------------------ helpers

  private currentCaps: any = {};

  setClientCapabilities(caps: any): void {
    this.currentCaps = caps ?? {};
  }

  getClientCapabilities(): any {
    return this.currentCaps;
  }

  private defaultSelection(): ModelSelectionState {
    const selection: ModelSelectionState = {};
    if (this.deps.defaultProvider) selection.provider = this.deps.defaultProvider;
    if (this.deps.defaultModel) selection.model = this.deps.defaultModel;
    return selection;
  }

  private requireCwd(value: unknown): string {
    const cwd = typeof value === 'string' ? value : '';
    if (!isAbsolutePath(cwd)) throw invalidParams('cwd must be an absolute path');
    return cwd;
  }

  requireSession(sessionId: unknown): SessionRecord {
    const record = this.sessions.get(String(sessionId ?? ''));
    if (!record) throw resourceNotFound(`unknown session: ${String(sessionId ?? '')}`);
    return record;
  }
}

function restoreReady(record: SessionRecord): void {
  if (record.state !== 'closed') record.state = 'ready';
}

function commandLineOf(blocks: readonly any[]): string | undefined {  const textParts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') break;
    if (block.type !== 'text' || typeof block.text !== 'string') break;
    textParts.push(block.text);
    if (parseCommand(textParts.join(''))) break;
  }
  const line = textParts.join('');
  return line.length > 0 ? line : undefined;
}

function stopReasonOf(reason: any): string {
  const kind = reason?.kind;
  if (kind === 'aborted') return 'cancelled';
  if (kind === 'max-tokens') return 'max_tokens';
  return 'end_turn';
}

function acpUsage(usage: any): Record<string, unknown> {
  const input = Number(usage?.inputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  return {
    totalTokens: Number(usage?.totalTokens ?? input + output),
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    ...(usage?.reasoningTokens !== undefined ? { thoughtTokens: Number(usage.reasoningTokens) } : {}),
    ...(usage?.cacheReadTokens !== undefined ? { cachedReadTokens: Number(usage.cacheReadTokens) } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cachedWriteTokens: Number(usage.cacheWriteTokens) } : {}),
  };
}

function resolveBoundary(events: readonly DshEvent[], atSeq: unknown): number {
  if (atSeq !== undefined && atSeq !== null) {
    const value = Number(atSeq);
    if (!Number.isInteger(value) || value < 0) throw invalidParams('atSeq must be a non-negative integer');
    if (!events.some((event) => event.seq === value)) throw invalidParams(`atSeq ${value} is not a session event`);
    return value;
  }
  let boundary = -1;
  for (const event of events) {
    if (event.type === 'turn/end' && event.seq > boundary) boundary = event.seq;
  }
  if (boundary < 0) throw invalidParams('session has no completed turn to fork at');
  return boundary;
}
