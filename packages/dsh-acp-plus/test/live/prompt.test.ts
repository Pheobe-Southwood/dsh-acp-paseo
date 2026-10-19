/**
 * Flag-gated live test: a real model turn through the real harness, exercising
 * streaming frames and session forking. Run with `DSH_ACP_LIVE=1`.
 *
 * Credentials are copied from the operator's own DSH home into a throwaway
 * home so nothing in the live profile is mutated.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client as createClientApp, ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const live = process.env.DSH_ACP_LIVE === '1';

let home: string;
let workspace: string;
let child: ChildProcessWithoutNullStreams;
let connection: any;
const updates: any[] = [];
const frames: any[] = [];
const events: any[] = [];
let stderr = '';

function trace(): string {
  return JSON.stringify(
    {
      updateKinds: updates.map((notification) => notification.update.sessionUpdate),
      frameTypes: frames.map((notification) => notification.frame.type),
      frameChunks: frames.slice(0, 8).map((notification) => ({
        index: notification.frame.index,
        revision: notification.frame.revision,
        attempt: notification.frame.attemptId,
        chunkType: notification.frame.chunk?.type,
        chunkKeys: notification.frame.chunk ? Object.keys(notification.frame.chunk) : null,
        text: typeof notification.frame.chunk?.text === 'string' ? notification.frame.chunk.text.slice(0, 40) : null,
      })),
      eventTypes: events.map((notification) => notification.event.type),
      turnEnds: events.filter((notification) => notification.event.type === 'turn/end').map((notification) => notification.event.data),
      stderr: stderr.split('\n').slice(-15),
    },
    null,
    1,
  );
}

async function waitFor(check: () => boolean, timeoutMs = 180_000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}\nstderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!live)('dsh-acp-plus live model turn', () => {
  let sessionId: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-live-'));
    workspace = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-live-work-'));
    const sourceHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    for (const file of ['.credentials.yaml', 'settings.yaml']) {
      try {
        await access(join(sourceHome, file));
        await copyFile(join(sourceHome, file), join(home, file));
      } catch {
        /* optional */
      }
    }
    const profile = join(home, 'profiles', 'acp-plus');
    await mkdir(join(profile, 'node_modules', '@ds-hu'), { recursive: true });
    await writeFile(
      join(profile, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-acp-plus',
          private: true,
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', '@ds-hu/dsh-acp-plus'],
              patchReload: 'startup',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
    await symlink(packageRoot, join(profile, 'node_modules', '@ds-hu', 'dsh-acp-plus'), 'dir');

    child = spawn(process.env.DSH_BIN ?? 'dsh', ['--profile', 'acp-plus'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const app = createClientApp({ name: 'dsh-acp-plus-live' });
    app.onNotification('session/update', ({ params }) => {
      updates.push(params);
    });
    app.onNotification(
      '_dsh/event',
      (params) => params as any,
      ({ params }) => {
        events.push(params);
      },
    );
    app.onNotification(
      '_dsh/frame',
      (params) => params as any,
      ({ params }) => {
        frames.push(params);
      },
    );
    app.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }));
    const stream: Stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    connection = app.connect(stream);
    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {}, configOptions: {} } },
    });
    const session = await connection.agent.request('session/new', { cwd: workspace, mcpServers: [] });
    sessionId = session.sessionId;
  }, 240_000);

  afterAll(async () => {
    try {
      connection?.close?.();
    } catch {
      /* ignore */
    }
    child?.kill('SIGKILL');
    if (home) await rm(home, { recursive: true, force: true });
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('streams a real answer and mirrors frames and events', async () => {
    const response = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly the single word: pong' }],
    });
    expect(response.stopReason, trace()).toBe('end_turn');
    const text = updates
      .filter((notification) => notification.update.sessionUpdate === 'agent_message_chunk')
      .map((notification) => notification.update.content.text)
      .join('');
    expect(text.toLowerCase(), trace()).toContain('pong');
    expect(frames.length, trace()).toBeGreaterThan(0);
    await waitFor(() => frames.some((notification) => notification.frame.type === 'end'), 30_000, 'stream end frame');
    const kinds = frames.map((notification) => notification.frame.type);
    expect(kinds).toContain('start');
    expect(kinds).toContain('end');
    await waitFor(
      () => updates.some((notification) => notification.update.sessionUpdate === 'usage_update'),
      30_000,
      'usage update',
    );
  }, 240_000);

  it('forks the session at its last completed turn', async () => {
    const fork = await connection.agent.request('session/fork', { sessionId, cwd: workspace });
    expect(fork.sessionId).not.toBe(sessionId);
    expect(fork._meta.dsh.kind).toBe('session-fork');
    expect(fork._meta.dsh.lineage).toMatchObject({ parentSessionId: sessionId, isSeeded: true });
    const opened = await connection.agent.request('session/close', { sessionId: fork.sessionId });
    expect(opened._meta.dsh.kind).toBe('session-close');
    await waitFor(() => true, 1_000, 'fork teardown');
  }, 120_000);
});
