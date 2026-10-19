/**
 * Cordis plugin entry for the `dsh-acp-plus` bundle: waits for the ACP app
 * startup gate, claims stdio with an NDJSON ACP v1 transport, and serves every
 * session until the process exits.
 * @module dsh-acp-plus
 */
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Logger } from './dsh-types.js';
import { createAcpPlusServer } from './server.js';

export const name = 'acp-plus';

/** Wait for the ACP app's command-line gate and the harness services we need. */
export const inject = ['acpAppStartup', 'agents', 'llm', 'sessionPersistence'];

export const VERSION = '0.1.0';

export interface Config {
  provider?: string;
  model?: string;
  sessionListPageSize: number;
  questionTimeoutMs: number;
  replayLimit: number;
}

export const Config: Schema<Config> = Schema.object({
  provider: Schema.string().description('Default DSH provider route for new ACP sessions.'),
  model: Schema.string().description('Default model id for new ACP sessions.'),
  sessionListPageSize: Schema.natural().default(100).description('Maximum sessions returned per `session/list` page.'),
  questionTimeoutMs: Schema.natural().default(660_000).description('How long an interactive question waits for a client answer.'),
  replayLimit: Schema.natural().default(0).description('Maximum events replayed by `session/load` (0 replays all).'),
});

const FALLBACK_LOGGER: Logger = {
  debug: (message, ...args) => console.error('[acp-plus]', message, ...args),
  info: (message, ...args) => console.error('[acp-plus]', message, ...args),
  warn: (message, ...args) => console.error('[acp-plus]', message, ...args),
  error: (message, ...args) => console.error('[acp-plus]', message, ...args),
};

function loggerOf(ctx: Context): Logger {
  try {
    const candidate: any = (ctx as any).logger;
    if (typeof candidate === 'function') {
      const scoped = candidate.call(ctx, 'acp-plus');
      if (scoped?.info) return scoped as Logger;
    }
    if (candidate?.info) return candidate as Logger;
  } catch {
    /* fall through */
  }
  return FALLBACK_LOGGER;
}

export function apply(ctx: Context, config: Config): void {
  const log = loggerOf(ctx);
  const server = createAcpPlusServer({
    ctx: ctx as any,
    log,
    version: VERSION,
    ...(config?.provider ? { provider: config.provider } : {}),
    ...(config?.model ? { model: config.model } : {}),
    sessionListPageSize: config?.sessionListPageSize ?? 100,
    questionTimeoutMs: config?.questionTimeoutMs ?? 660_000,
    replayLimit: config?.replayLimit ?? 0,
  });

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  server.connect(stream);
  log.info('serving ACP v1 on stdio');

  const dispose = () => {
    void server.bridge.closeAll().catch(() => undefined);
  };
  if (typeof (ctx as any).effect === 'function') {
    (ctx as any).effect(() => dispose);
  } else {
    (ctx as any).on?.('dispose', dispose);
  }
}

export default { name, inject, Config, apply };
