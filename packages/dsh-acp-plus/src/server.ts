/**
 * ACP application wiring: registers every inbound method and extension, and
 * connects the bridge to a transport stream.
 * @module dsh-acp-plus/server
 */
import { agent, type Stream } from '@agentclientprotocol/sdk';
import { IMAGE_MEDIA_TYPES } from './content.js';
import { service, type DshContext, type Logger } from './dsh-types.js';
import { EXT_FORK, initializeMeta } from './meta.js';
import { SessionBridge, invalidParams } from './session.js';

export interface ServerOptions {
  ctx: DshContext;
  log: Logger;
  version: string;
  dshVersion?: string;
  provider?: string;
  model?: string;
  sessionListPageSize: number;
  questionTimeoutMs: number;
  replayLimit: number;
}

export interface AcpPlusServer {
  readonly bridge: SessionBridge;
  connect(stream: Stream): { close(error?: unknown): void };
}

async function detectImageSupport(options: ServerOptions): Promise<boolean> {
  const attachments = service<any>(options.ctx, 'attachments');
  const llm = service<any>(options.ctx, 'llm');
  if (!attachments || !llm || !options.provider || !options.model) return false;
  const mediaTypes: readonly string[] = attachments.imageLimits?.mediaTypes ?? [];
  if (!mediaTypes.some((mediaType) => IMAGE_MEDIA_TYPES.has(mediaType))) return false;
  try {
    const info = await llm.resolveModelInfo(options.provider, options.model);
    const modalities: readonly string[] = info?.inputModalities ?? [];
    return modalities.includes('image');
  } catch {
    return false;
  }
}

export function createAcpPlusServer(options: ServerOptions): AcpPlusServer {
  let client: any = null;
  let imageEnabled = false;

  const bridge = new SessionBridge({
    ctx: options.ctx,
    log: options.log,
    pageSize: options.sessionListPageSize,
    questionTimeoutMs: options.questionTimeoutMs,
    replayLimit: options.replayLimit,
    ...(options.provider ? { defaultProvider: options.provider } : {}),
    ...(options.model ? { defaultModel: options.model } : {}),
    getClient: () => client,
    imageEnabled: () => imageEnabled,
  });

  const app = agent({ name: 'dsh-acp-plus' });

  app.onConnect((connection) => {
    client = connection.client;
  });

  app.onRequest('initialize', async ({ params }) => {
    bridge.setClientCapabilities(params?.clientCapabilities);
    imageEnabled = await detectImageSupport(options);
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: imageEnabled, audio: false, embeddedContext: false },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
      },
      authMethods: [],
      agentInfo: { name: 'dsh-acp-plus', version: options.version },
      _meta: initializeMeta({
        version: options.version,
        ...(options.dshVersion ? { dshVersion: options.dshVersion } : {}),
        image: imageEnabled,
        fork: true,
        loadSession: true,
      }),
    };
  });

  app.onRequest('authenticate', async () => ({}));

  app.onRequest('session/new', async ({ params }) => bridge.newSession(params));
  app.onRequest('session/load', async ({ params }) => bridge.loadSession(params));
  app.onRequest('session/resume', async ({ params }) => bridge.resumeSession(params));
  app.onRequest('session/list', async ({ params }) => bridge.listSessions(params));
  app.onRequest('session/close', async ({ params }) => bridge.closeSession(params));
  app.onRequest('session/set_config_option', async ({ params }) => bridge.setConfigOption(params));
  app.onRequest('session/set_mode', async ({ params }) => bridge.setMode(params));
  app.onRequest('session/prompt', async ({ params }) => bridge.prompt(params));
  app.onRequest('session/fork', async ({ params }) => {
    const result = await bridge.fork(params);
    return {
      sessionId: result.sessionId,
      ...(result.configOptions ? { configOptions: result.configOptions } : {}),
      ...(result.modes ? { modes: result.modes } : {}),
      _meta: result._meta,
    };
  });

  app.onNotification('session/cancel', async ({ params }) => {
    bridge.cancel(String(params?.sessionId ?? ''));
  });

  app.onRequest(EXT_FORK, (params) => (params ?? {}) as Record<string, unknown>, async ({ params }) => {
    if (!params || typeof params.sessionId !== 'string') throw invalidParams('sessionId is required');
    return bridge.fork(params);
  });

  return {
    bridge,
    connect(stream: Stream) {
      return app.connect(stream);
    },
  };
}
