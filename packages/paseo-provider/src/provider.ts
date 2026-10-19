/**
 * Paseo provider registration for the DeepSeek Harness.
 *
 * The provider is a direct `ProviderRegistration` (not the ACP shim) so it can
 * surface native question cards, persist the `_meta` sidecar, and map ACP
 * config options onto Paseo's composer.
 * @module paseo-provider/provider
 */
import { Readable, Writable } from 'node:stream';
import { client as createClientApp, ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { spawnProcess, terminateProcess } from '@getpaseo/plugin/server';
import {
  negotiateProviderCapabilities,
  type ProviderConnectRequest,
  type ProviderRegistration,
} from '@getpaseo/plugin/server/provider';
import { createConnection } from './connection.js';
import { DEFAULT_COMMAND } from './types.js';

/** Capabilities always offered; `prompt.image` is added when the agent accepts images. */
const BASE_CAPABILITIES = [
  'prompt.message',
  'prompt.command',
  'permission',
  'permission.tool_policy',
  'session.configure',
  'session.list',
  'session.persistence',
] as const;

interface ProbeResult {
  image: boolean;
  loadSession: boolean;
}

const probeCache = new Map<string, Promise<ProbeResult>>();

async function runProbe(request: ProviderConnectRequest): Promise<ProbeResult> {
  const launch = request.launch;
  const command = launch?.command ?? DEFAULT_COMMAND[0];
  const args = launch?.args ?? DEFAULT_COMMAND.slice(1);
  const child = spawnProcess(command, args, {
    env: launch?.env ?? ({ ...process.env } as Record<string, string>),
    stdio: 'pipe',
  });
  const app = createClientApp({ name: 'paseo-deepseek-harness-probe' });
  const stream: Stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  try {
    const response: any = await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {}, configOptions: {} } },
    });
    return {
      image: response?.agentCapabilities?.promptCapabilities?.image === true,
      loadSession: response?.agentCapabilities?.loadSession !== false,
    };
  } finally {
    try {
      connection.close?.();
    } catch {
      /* ignore */
    }
    try {
      await terminateProcess(child);
    } catch {
      /* ignore */
    }
  }
}

function probeCapabilities(request: ProviderConnectRequest): Promise<ProbeResult> {
  const launch = request.launch;
  const key = launch ? `${launch.command} ${launch.args.join(' ')}` : DEFAULT_COMMAND.join(' ');
  let pending = probeCache.get(key);
  if (!pending) {
    pending = runProbe(request).catch(() => ({ image: false, loadSession: true }));
    probeCache.set(key, pending);
  }
  return pending;
}

export function createDeepseekHarnessProvider(): ProviderRegistration {
  return {
    id: 'deepseek-harness',
    label: 'DeepSeek Harness',
    description: 'DeepSeek Harness over ACP: standard projection plus stored DSH-native semantics.',
    requiresConfiguration: true,
    icon: 'icon.svg',
    command: DEFAULT_COMMAND,
    async connect(request: ProviderConnectRequest) {
      if (!request.versions.includes(1)) throw new Error('Provider protocol version 1 is required');
      const probe = await probeCapabilities(request);
      const supported: string[] = [
        ...BASE_CAPABILITIES,
        ...(probe.image ? ['prompt.image'] : []),
      ];
      const capabilities = negotiateProviderCapabilities(request.capabilities, supported);
      return createConnection({ request, capabilities });
    },
  };
}
