/**
 * Paseo provider connection: one connection per daemon handshake, one ACP
 * client per session, and the full provider input/event grammar.
 * @module paseo-provider/connection
 */
import { randomUUID } from 'node:crypto';
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderConnectRequest,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionResponse,
  type ProviderPersistence,
  type ProviderSessionConfig,
  type ProviderSessionSummary,
} from '@getpaseo/plugin/server/provider';
import { AcpSessionClient, type AcpClientHooks } from './acp-client.js';
import {
  answersFromPaseo,
  configStateFromAcp,
  permissionRequestFromAcp,
  questionRequestFromDsh,
  todoItem,
  toolCallItem,
  toolCallItemUpdated,
  usageFromAcp,
  usageFromPromptResponse,
} from './mapping.js';
import { DEFAULT_MAX_BYTES, MetaStore, metaLogPath, resolvePaseoHome } from './meta-store.js';
import type { ProviderLaunch } from './types.js';

export interface ConnectionOverrides {
  createClient?: (sessionId: string, config: ProviderSessionConfig, hooks: AcpClientHooks) => AcpSessionClient;
  paseoHome?: string;
  maxMetaBytes?: number;
}

export interface ConnectionOptions {
  request: ProviderConnectRequest;
  capabilities: readonly string[];
  overrides?: ConnectionOverrides;
}

interface MessageState {
  id: string;
  text: string;
}

interface SessionState {
  sessionId: string;
  config: ProviderSessionConfig;
  client: AcpSessionClient;
  acpSessionId: string;
  persistence: ProviderPersistence;
  metaStore: MetaStore;
  timeline: Map<string, any>;
  tools: Map<string, any>;
  messages: Map<string, MessageState>;
  permissions: Map<string, (response: ProviderPermissionResponse) => void>;
  questions: Map<string, (response: ProviderPermissionResponse) => void>;
  commands: Set<string>;
  closed: boolean;
  activeTurn?: { turnId: string; clientMessageId: string };
  lastConfig?: any;
}

function launchCommand(request: ProviderConnectRequest, overrides?: ConnectionOverrides): [string, ...string[]] | undefined {
  const launch: ProviderLaunch | undefined = request.launch;
  if (launch?.command) return [launch.command, ...(launch.args ?? [])];
  return undefined;
}

function mcpServersFromConfig(config: ProviderSessionConfig): any[] {
  const out: any[] = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (!server || typeof server !== 'object') continue;
    const value = server as any;
    if (value.type === 'stdio') {
      out.push({
        type: 'stdio',
        name,
        command: String(value.command ?? ''),
        args: Array.isArray(value.args) ? value.args.map(String) : [],
        env: Object.entries(value.env ?? {}).map(([key, entry]) => ({ name: key, value: String(entry) })),
      });
      continue;
    }
    out.push({
      type: value.type === 'sse' ? 'sse' : 'http',
      name,
      url: String(value.url ?? ''),
      headers: Object.entries(value.headers ?? {}).map(([key, entry]) => ({ name: key, value: String(entry) })),
    });
  }
  return out;
}

function paseoMeta(config: ProviderSessionConfig): Record<string, unknown> {
  return {
    paseo: {
      systemPrompt: config.systemPrompt,
      providerOptions: config.providerOptions,
      toolPolicy: config.toolPolicy,
      persist: config.persist,
      title: config.title,
      model: config.model,
      thinkingOption: config.thinkingOption,
      settings: config.settings,
    },
  };
}

function promptContent(parts: readonly any[]): any[] {
  const out: any[] = [];
  for (const part of parts ?? []) {
    switch (part?.type) {
      case 'text':
        if (typeof part.text === 'string' && part.text.length > 0) out.push({ type: 'text', text: part.text });
        break;
      case 'image':
        out.push({ type: 'image', data: String(part.data ?? ''), mimeType: String(part.mimeType ?? 'image/png') });
        break;
      case 'uploaded_file':
        out.push({ type: 'text', text: `[file ${String(part.fileName ?? part.id ?? 'file')}] ${String(part.path ?? '')}`.trim() });
        break;
      default:
        out.push({
          type: 'text',
          text: `[${String(part?.type ?? 'attachment')}] ${JSON.stringify({
            title: part?.title,
            url: part?.url,
            number: part?.number,
          })}`,
        });
        break;
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

function errorOf(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as any).code;
    return { message: error.message, ...(typeof code === 'string' ? { code } : {}) };
  }
  return { message: String(error) };
}

export function createConnection(options: ConnectionOptions): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, SessionState>();
  const capabilities = options.capabilities;
  const paseoHome = resolvePaseoHome(options.overrides?.paseoHome);
  const maxMetaBytes = options.overrides?.maxMetaBytes ?? DEFAULT_MAX_BYTES;
  const command = launchCommand(options.request, options.overrides);
  let closed = false;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const spawnClient = (sessionId: string, config: ProviderSessionConfig, hooks: AcpClientHooks): AcpSessionClient => {
    if (options.overrides?.createClient) return options.overrides.createClient(sessionId, config, hooks);
    const client = new AcpSessionClient(hooks);
    const resolved = command ?? ['dsh', '--profile', 'acp-plus'];
    client.connectToProcess({
      command: resolved as [string, ...string[]],
      env: options.request.launch?.env ?? { ...process.env, ...config.env } as Record<string, string>,
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
    return client;
  };

  const hooksFor = (session: SessionState): AcpClientHooks => ({
    onLog: () => undefined,
    onUpdate: (params) => handleUpdate(session, params),
    onPermission: (params) => handlePermission(session, params),
    onQuestions: (params, signal) => handleQuestions(session, params, signal),
    onEvent: (params) => {
      void session.metaStore.append('event', params);
    },
    onFrame: (params) => {
      void session.metaStore.append('frame', params);
    },
  });

  const emitItem = (session: SessionState, item: any) => {
    session.timeline.set(item.id, item);
    emit({ type: 'timeline.item', sessionId: session.sessionId, item });
  };

  const messageItem = (session: SessionState, key: string, type: 'assistant_message' | 'reasoning' | 'user_message', delta: string, messageId?: string) => {
    const id = `${key}:${messageId ?? 'default'}`;
    const current = session.messages.get(id) ?? { id, text: '' };
    current.text += delta;
    session.messages.set(id, current);
    emitItem(session, { id, type, text: current.text });
  };

  const handleUpdate = (session: SessionState, notification: any) => {
    const update = notification?.update;
    if (!update || typeof update !== 'object') return;
    const meta = update._meta?.dsh;
    if (meta) {
      void session.metaStore.append('update', {
        sessionUpdate: update.sessionUpdate,
        messageId: update.messageId,
        meta: { v: meta.v, kind: meta.kind, seq: meta.seq, turn: meta.turn, step: meta.step },
      });
    } else {
      void session.metaStore.append('update', update);
    }
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        if (typeof update.content?.text === 'string') messageItem(session, 'user', 'user_message', update.content.text, update.messageId);
        return;
      case 'agent_message_chunk':
        if (typeof update.content?.text === 'string') messageItem(session, 'message', 'assistant_message', update.content.text, update.messageId);
        return;
      case 'agent_thought_chunk':
        if (typeof update.content?.text === 'string') messageItem(session, 'reasoning', 'reasoning', update.content.text, update.messageId);
        return;
      case 'tool_call':
        session.tools.set(String(update.toolCallId ?? ''), update);
        emitItem(session, toolCallItem(update));
        return;
      case 'tool_call_update': {
        const callId = String(update.toolCallId ?? '');
        const previous = session.timeline.get(`tool:${callId}`);
        const previousRaw = session.tools.get(callId);
        session.tools.set(callId, { ...(previousRaw ?? {}), ...update });
        emitItem(session, toolCallItemUpdated(previous, update, previousRaw));
        return;
      }
      case 'plan':
        emitItem(session, todoItem(update));
        return;
      case 'available_commands_update': {
        const commands = (Array.isArray(update.availableCommands) ? update.availableCommands : []).map((command: any) => ({
          name: String(command?.name ?? ''),
          description: String(command?.description ?? ''),
          ...(command?.input?.hint ? { argumentHint: String(command.input.hint) } : {}),
        }));
        session.commands = new Set(commands.map((entry: any) => entry.name));
        emit({ type: 'session.commands', sessionId: session.sessionId, commands });
        return;
      }
      case 'config_option_update': {
        session.lastConfig = configStateFromAcp(update.configOptions);
        emit({ type: 'session.config', sessionId: session.sessionId, config: session.lastConfig });
        return;
      }
      case 'usage_update':
        emit({ type: 'session.usage', sessionId: session.sessionId, ...(session.activeTurn ? { turnId: session.activeTurn.turnId } : {}), usage: usageFromAcp(update) });
        return;
      case 'compaction_update':
        emitItem(session, {
          id: `compaction:${String(update.compactionId ?? 'compaction')}`,
          type: 'compaction',
          status: update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'running',
          summary: Array.isArray(update.summary) ? update.summary.map((block: any) => String(block?.text ?? '')).join('\n') : undefined,
        });
        return;
      default:
        // Unknown or `_meta`-only updates are stored above and never rendered.
        return;
    }
  };

  const handlePermission = async (session: SessionState, params: any): Promise<any> => {
    const request = permissionRequestFromAcp(params);
    const response = await new Promise<ProviderPermissionResponse>((resolve) => {
      session.permissions.set(request.id, resolve);
      emit({ type: 'session.permission', sessionId: session.sessionId, request });
    });
    emit({ type: 'session.permission_resolved', sessionId: session.sessionId, permissionId: request.id });
    if (response.behavior === 'allow') {
      const optionId = response.selectedActionId ?? request.actions?.find((action) => action.behavior === 'allow')?.id ?? 'allow_once';
      return { outcome: { outcome: 'selected', optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  };

  const handleQuestions = async (session: SessionState, params: any, signal?: AbortSignal): Promise<any> => {
    const requestId = String(params?.requestId ?? randomUUID());
    const { request, questions } = questionRequestFromDsh(params, requestId);
    const timeoutMs = Number(params?.timeoutMs ?? 600_000);
    const response = await new Promise<ProviderPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        session.questions.delete(request.id);
        resolve({ behavior: 'deny', message: 'question timed out' });
      }, Math.max(1_000, timeoutMs));
      const settle = (value: ProviderPermissionResponse) => {
        clearTimeout(timer);
        resolve(value);
      };
      session.questions.set(request.id, settle);
      signal?.addEventListener('abort', () => {
        session.questions.delete(request.id);
        settle({ behavior: 'deny', message: 'question cancelled' });
      });
      emit({ type: 'session.permission', sessionId: session.sessionId, request });
    });
    emit({ type: 'session.permission_resolved', sessionId: session.sessionId, permissionId: request.id });
    if (response.behavior !== 'allow') throw new Error(response.message ?? 'question dismissed by the user');
    return { answers: answersFromPaseo(response.updatedInput?.answers, questions) };
  };

  const openSession = async (input: Extract<ProviderInput, { type: 'session.open' }>): Promise<void> => {
    const sessionId = input.sessionId;
    const config = input.config;
    const metaStore = new MetaStore(metaLogPath(paseoHome, sessionId), maxMetaBytes);
    const session: SessionState = {
      sessionId,
      config,
      client: null as unknown as AcpSessionClient,
      acpSessionId: '',
      persistence: input.persistence ?? { version: 1, data: { nativeSessionId: null } },
      metaStore,
      timeline: new Map(),
      tools: new Map(),
      messages: new Map(),
      permissions: new Map(),
      questions: new Map(),
      commands: new Set(),
      closed: false,
    };
    const client = spawnClient(sessionId, config, hooksFor(session));
    session.client = client;
    const initialize = await client.initialize();
    const persistedData = (input.persistence?.data ?? {}) as Record<string, unknown>;
    const nativeSessionId = typeof persistedData.nativeSessionId === 'string' ? persistedData.nativeSessionId : undefined;

    emit({
      type: 'session.opened',
      requestId: input.requestId,
      sessionId,
      capabilities,
      restoration: 'core',
      persistence: session.persistence,
      ...(config.title ? { title: config.title } : {}),
      cwd: config.cwd,
    });

    const mcpServers = mcpServersFromConfig(config);
    const meta = paseoMeta(config);
    let openResponse: any;
    try {
      if (nativeSessionId && input.history === 'replay' && initialize?.agentCapabilities?.loadSession !== false) {
        openResponse = await client.loadSession({ sessionId: nativeSessionId, cwd: config.cwd, mcpServers, meta });
        session.acpSessionId = nativeSessionId;
      } else if (nativeSessionId) {
        openResponse = await client.resumeSession({ sessionId: nativeSessionId, cwd: config.cwd, mcpServers, meta });
        session.acpSessionId = nativeSessionId;
      } else {
        openResponse = await client.newSession({ cwd: config.cwd, mcpServers, meta });
        session.acpSessionId = String(openResponse?.sessionId ?? '');
      }
    } catch (error) {
      await client.close();
      throw error;
    }

    session.persistence = {
      version: 1,
      data: {
        nativeSessionId: session.acpSessionId,
        dshCwd: config.cwd,
        metaLog: metaStore.pointer(),
        createdAt: new Date().toISOString(),
      },
    };
    emit({ type: 'session.persistence', sessionId, persistence: session.persistence });
    if (Array.isArray(openResponse?.configOptions) && openResponse.configOptions.length > 0) {
      session.lastConfig = configStateFromAcp(openResponse.configOptions);
      emit({ type: 'session.config', sessionId, config: session.lastConfig });
    }
    sessions.set(sessionId, session);
    emit({ type: 'session.ready', requestId: input.requestId, sessionId });
  };

  const runPrompt = async (session: SessionState, prompt: any): Promise<void> => {
    const turnId = randomUUID();
    session.activeTurn = { turnId, clientMessageId: prompt.clientMessageId };
    const isCommand = prompt.input?.type === 'command';
    const content: any[] = isCommand
      ? [{ type: 'text', text: `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ''}` }]
      : promptContent(prompt.input?.content ?? []);
    emit({ type: 'session.prompt_result', sessionId: session.sessionId, clientMessageId: prompt.clientMessageId, result: { type: 'turn', turnId } });
    emit({ type: 'session.turn', sessionId: session.sessionId, turnId, state: 'started' });
    if (!isCommand) {
      const plain = content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
      if (plain.trim().length > 0) {
        messageItem(session, 'user', 'user_message', plain, turnId);
      }
    }
    try {
      const response = await session.client.prompt({ sessionId: session.acpSessionId, prompt: content });
      const usage = usageFromPromptResponse(response);
      if (usage) emit({ type: 'session.usage', sessionId: session.sessionId, turnId, usage });
      emit({
        type: 'session.turn',
        sessionId: session.sessionId,
        turnId,
        state: response?.stopReason === 'cancelled' ? 'canceled' : 'completed',
      });
    } catch (error) {
      const failure = errorOf(error);
      emit({ type: 'session.turn', sessionId: session.sessionId, turnId, state: 'failed', error: failure });
      emit({ type: 'session.runtime_failed', sessionId: session.sessionId, error: failure });
    } finally {
      session.activeTurn = undefined;
    }
  };

  const configureSession = async (input: Extract<ProviderInput, { type: 'session.configure' }>): Promise<void> => {
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
    const changes = input.changes ?? {};
    const apply = async (configId: string, value: string) => {
      const response = await session.client.setConfigOption({ sessionId: session.acpSessionId, configId, value });
      if (Array.isArray(response?.configOptions)) {
        session.lastConfig = configStateFromAcp(response.configOptions);
      }
    };
    if (changes.model !== undefined && changes.model !== null) await apply('model', changes.model);
    if (changes.thinkingOption !== undefined && changes.thinkingOption !== null) await apply('reasoning_effort', changes.thinkingOption);
    if (changes.settings) {
      for (const [id, value] of Object.entries(changes.settings)) {
        await apply(id, String(value));
      }
    }
    emit({ type: 'session.config', sessionId: session.sessionId, config: session.lastConfig ?? configStateFromAcp([]) });
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    for (const resolve of session.permissions.values()) resolve({ behavior: 'deny', message: 'session closed' });
    session.permissions.clear();
    for (const resolve of session.questions.values()) resolve({ behavior: 'deny', message: 'session closed' });
    session.questions.clear();
    try {
      await session.client.closeSession(session.acpSessionId);
    } catch {
      /* the agent may already be gone */
    }
    await session.client.close();
    session.persistence = {
      version: 1,
      data: {
        ...(session.persistence.data as Record<string, unknown>),
        metaLog: session.metaStore.pointer(),
      } as any,
    };
    emit({ type: 'session.persistence', sessionId, persistence: session.persistence });
    sessions.delete(sessionId);
    emit({ type: 'session.closed', sessionId });
  };

  const handleCatalog = async (input: Extract<ProviderInput, { type: 'catalog' }>): Promise<void> => {
    const client = spawnClient(`catalog-${randomUUID()}`, { cwd: input.cwd ?? process.cwd() } as ProviderSessionConfig, {
      onLog: () => undefined,
      onUpdate: () => undefined,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onQuestions: async () => ({ answers: [] }),
    });
    try {
      await client.initialize();
      const response = await client.newSession({ cwd: input.cwd ?? process.cwd(), mcpServers: [] });
      const config = configStateFromAcp(response?.configOptions ?? []);
      emit({
        type: 'catalog',
        requestId: input.requestId,
        catalog: {
          models: config.models,
          modes: [],
          thinkingOptions: config.thinkingOptions,
          ...(config.model ? { defaultModel: config.model } : {}),
        },
      });
      await client.closeSession(String(response?.sessionId ?? ''));
    } catch {
      emit({ type: 'catalog', requestId: input.requestId, catalog: { models: [], modes: [] } });
    } finally {
      await client.close();
    }
  };

  const handleSessions = async (input: Extract<ProviderInput, { type: 'sessions' }>): Promise<void> => {
    const client = spawnClient(`sessions-${randomUUID()}`, { cwd: input.cwd ?? process.cwd() } as ProviderSessionConfig, {
      onLog: () => undefined,
      onUpdate: () => undefined,
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onQuestions: async () => ({ answers: [] }),
    });
    try {
      await client.initialize();
      const response = await client.listSessions({ ...(input.cwd ? { cwd: input.cwd } : {}) });
      const sessions: ProviderSessionSummary[] = (Array.isArray(response?.sessions) ? response.sessions : []).map((entry: any) => ({
        persistence: { version: 1, data: { nativeSessionId: String(entry?.sessionId ?? ''), dshCwd: String(entry?.cwd ?? '') } },
        cwd: String(entry?.cwd ?? ''),
        ...(entry?.title ? { title: String(entry.title) } : {}),
        ...(entry?.updatedAt ? { updatedAt: String(entry.updatedAt) } : {}),
      }));
      emit({ type: 'sessions', requestId: input.requestId, sessions });
    } catch {
      emit({ type: 'sessions', requestId: input.requestId, sessions: [] });
    } finally {
      await client.close();
    }
  };

  return {
    version: 1,
    capabilities,
    async send(input: ProviderInput): Promise<void> {
      if (closed) throw new Error('Provider connection is closed');
      if (input.type === 'session.open') {
        if (sessions.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
      } else if ('sessionId' in input) {
        if (!sessions.has(input.sessionId)) throw new Error(`Unknown session: ${input.sessionId}`);
      }
      requireProviderCapabilities(capabilities, input);
      switch (input.type) {
        case 'catalog':
          await handleCatalog(input);
          return;
        case 'sessions':
          await handleSessions(input);
          return;
        case 'session.open':
          await openSession(input);
          return;
        case 'session.prompt': {
          const session = sessions.get(input.sessionId);
          if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
          void runPrompt(session, input.prompt);
          return;
        }
        case 'session.interrupt': {
          const session = sessions.get(input.sessionId);
          if (session) await session.client.cancel(session.acpSessionId);
          emit({ type: 'request.completed', requestId: input.requestId });
          return;
        }
        case 'session.permission': {
          const session = sessions.get(input.sessionId);
          if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
          const pending = session.permissions.get(input.permissionId) ?? session.questions.get(input.permissionId);
          session.permissions.delete(input.permissionId);
          session.questions.delete(input.permissionId);
          pending?.(input.response);
          return;
        }
        case 'session.configure':
          await configureSession(input);
          emit({ type: 'request.completed', requestId: input.requestId });
          return;
        case 'session.close':
          await closeSession(input.sessionId);
          emit({ type: 'request.completed', requestId: input.requestId });
          return;
        default:
          throw new Error(`Unsupported provider input: ${(input as any).type}`);
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const sessionId of [...sessions.keys()]) {
        await closeSession(sessionId);
      }
      listeners.clear();
    },
  };
}

export { negotiateProviderCapabilities };
