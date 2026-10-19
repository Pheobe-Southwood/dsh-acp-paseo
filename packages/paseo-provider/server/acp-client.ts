/**
 * ACP client used by the Paseo provider. One instance per Paseo session; it
 * spawns `dsh --profile acp-plus` (or connects to an in-process fake in tests)
 * and owns the `_meta`/extension plumbing.
 * @module paseo-provider/acp-client
 */
import { Readable, Writable } from 'node:stream';
import { client as createClientApp, ndJsonStream, type AgentApp, type Stream } from '@agentclientprotocol/sdk';
import { spawnProcess, terminateProcess } from '@getpaseo/plugin/server';

export const EXT_EVENT = '_dsh/event';
export const EXT_FRAME = '_dsh/frame';
export const EXT_QUESTIONS = '_dsh/user_questions';
export const EXT_FORK = '_dsh/session/fork';

export interface AcpClientHooks {
  onUpdate(params: any): void;
  onPermission(params: any, signal?: AbortSignal): Promise<any>;
  onQuestions(params: any, signal?: AbortSignal): Promise<any>;
  onEvent?(params: any): void;
  onFrame?(params: any): void;
  onLog?(message: string): void;
}

export interface SpawnOptions {
  command: readonly [string, ...string[]];
  env: Record<string, string>;
  cwd?: string;
}

export class AcpSessionClient {
  private readonly app = createClientApp({ name: 'paseo-deepseek-harness' });
  private connection: any = null;
  private child: any = null;
  private closed = false;

  constructor(private readonly hooks: AcpClientHooks) {
    this.app.onNotification('session/update', ({ params }) => {
      this.hooks.onUpdate(params);
    });
    this.app.onRequest('session/request_permission', ({ params, signal }) => {
      return this.hooks.onPermission(params, signal);
    });
    this.app.onRequest(
      EXT_QUESTIONS,
      (params) => params as any,
      ({ params, signal }) => this.hooks.onQuestions(params, signal),
    );
    this.app.onNotification(
      EXT_EVENT,
      (params) => params as any,
      ({ params }) => this.hooks.onEvent?.(params),
    );
    this.app.onNotification(
      EXT_FRAME,
      (params) => params as any,
      ({ params }) => this.hooks.onFrame?.(params),
    );
  }

  /** Connect to an in-process agent app (used by tests and embedding). */
  connectToApp(agentApp: AgentApp): void {
    this.connection = this.app.connect(agentApp);
  }

  /** Spawn the DSH ACP agent and connect over NDJSON stdio. */
  connectToProcess(options: SpawnOptions): void {
    const [command, ...args] = options.command;
    const child = spawnProcess(command, args, {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: 'pipe',
    });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.hooks.onLog?.(chunk.toString('utf8').trimEnd());
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      if (!this.closed) this.hooks.onLog?.(`dsh exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });
    const stream: Stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = this.app.connect(stream);
  }

  private get agent(): any {
    if (!this.connection) throw new Error('ACP client is not connected');
    return this.connection.agent;
  }

  async initialize(): Promise<any> {
    return this.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        session: { compaction: {}, configOptions: {} },
      },
      clientInfo: { name: 'paseo-deepseek-harness', version: '0.1.0' },
    });
  }

  async newSession(params: { cwd: string; mcpServers: any[]; meta?: unknown }): Promise<any> {
    return this.agent.request('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(params.meta ? { _meta: params.meta } : {}),
    });
  }

  async loadSession(params: { sessionId: string; cwd: string; mcpServers: any[]; meta?: unknown }): Promise<any> {
    return this.agent.request('session/load', {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(params.meta ? { _meta: params.meta } : {}),
    });
  }

  async resumeSession(params: { sessionId: string; cwd: string; mcpServers: any[]; meta?: unknown }): Promise<any> {
    return this.agent.request('session/resume', {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(params.meta ? { _meta: params.meta } : {}),
    });
  }

  async listSessions(params: { cwd?: string }): Promise<any> {
    return this.agent.request('session/list', params.cwd ? { cwd: params.cwd } : {});
  }

  async prompt(params: { sessionId: string; prompt: any[] }): Promise<any> {
    return this.agent.request('session/prompt', { sessionId: params.sessionId, prompt: params.prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.agent.notify('session/cancel', { sessionId });
  }

  async setConfigOption(params: { sessionId: string; configId: string; value: string | boolean }): Promise<any> {
    return this.agent.request('session/set_config_option', {
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
  }

  async setMode(params: { sessionId: string; modeId: string }): Promise<any> {
    return this.agent.request('session/set_mode', {
      sessionId: params.sessionId,
      modeId: params.modeId,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.agent.request('session/close', { sessionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection?.close?.();
    } catch {
      /* ignore */
    }
    if (this.child) {
      try {
        await terminateProcess(this.child);
      } catch {
        /* ignore */
      }
    }
  }
}
