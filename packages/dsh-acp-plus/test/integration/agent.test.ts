/**
 * End-to-end integration against a real `dsh --profile acp-plus` process with a
 * throwaway DSH home. Everything here is offline: the prompt exercises slash
 * command routing (`/plan off`), which never calls a model.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client as createClientApp, ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let home: string;
let workspace: string;
let child: ChildProcessWithoutNullStreams;
let connection: any;
const updates: any[] = [];
const events: any[] = [];
const frames: any[] = [];
let stderr = '';

async function waitFor(check: () => boolean, timeoutMs = 60_000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}\nstderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const updateKinds = () => updates.map((notification) => notification?.update?.sessionUpdate);
const eventTypes = () => events.map((notification) => notification?.event?.type);

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-home-'));
  workspace = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-work-'));
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

  const app = createClientApp({ name: 'dsh-acp-plus-integration' });
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
}, 180_000);

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

describe('dsh-acp-plus over stdio', () => {
  let initialize: any;
  let sessionId: string;

  it('answers initialize with the lossless capability surface', async () => {
    initialize = await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {}, configOptions: {} } },
    });
    expect(initialize.protocolVersion).toBe(1);
    expect(initialize.agentCapabilities.loadSession).toBe(true);
    expect(initialize.agentCapabilities.sessionCapabilities).toMatchObject({ list: {}, resume: {}, close: {}, fork: {} });
    expect(initialize._meta.dsh.kind).toBe('initialize');
    expect(initialize._meta.dsh.extensions.event).toBe('_dsh/event');
    expect(initialize._meta.dsh.features).toMatchObject({ fork: true, loadSession: true });
  });

  it('creates a session and advertises config options and slash commands', async () => {
    const response = await connection.agent.request('session/new', { cwd: workspace, mcpServers: [] });
    sessionId = response.sessionId;
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    const ids = (response.configOptions ?? []).map((option: any) => option.id);
    expect(ids).toEqual(expect.arrayContaining(['approval_policy', 'sandbox_mode', 'plan_mode']));
    const approval = (response.configOptions ?? []).find((option: any) => option.id === 'approval_policy');
    expect(approval.type).toBe('select');
    expect(approval.options.map((option: any) => option.value)).toEqual(['ask', 'never']);

    await waitFor(() => updateKinds().includes('available_commands_update'), 30_000, 'available_commands_update');
    const commands = updates.find((notification) => notification.update.sessionUpdate === 'available_commands_update').update
      .availableCommands;
    expect(commands.map((command: any) => command.name)).toEqual(expect.arrayContaining(['plan', 'compact']));
    const plan = commands.find((command: any) => command.name === 'plan');
    expect(plan.input).toEqual({ hint: '[off|message]' });
  });

  it('routes a slash command without a model turn and mirrors its events', async () => {
    const before = events.length;
    const response = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/plan off' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(response._meta.dsh.kind).toBe('prompt-result');
    expect(response._meta.dsh.command.kind).toBe('success');

    await waitFor(() => eventTypes().slice(before).includes('command/done'), 15_000, 'command/done event');
    const newTypes = eventTypes().slice(before);
    expect(newTypes).toContain('command/run');
    expect(newTypes).toContain('command/done');
    const run = events.slice(before).find((notification) => notification.event.type === 'command/run');
    expect(run.event.data.name).toBe('plan');
    expect(run.v).toBe(1);
    expect(run.sessionId).toBe(sessionId);

    await waitFor(
      () => updates.some((notification) => notification.update._meta?.dsh?.kind === 'update.command_done'),
      15_000,
      'projected command output',
    );
    const projected = updates.find((notification) => notification.update._meta?.dsh?.kind === 'update.command_done');
    expect(projected.update.sessionUpdate).toBe('agent_message_chunk');
    expect(typeof projected.update.content.text).toBe('string');
  });

  it('applies a config option and reports the new value', async () => {
    const response = await connection.agent.request('session/set_config_option', {
      sessionId,
      configId: 'approval_policy',
      value: 'never',
    });
    const approval = response.configOptions.find((option: any) => option.id === 'approval_policy');
    expect(approval.currentValue).toBe('never');
    expect(response._meta.dsh.kind).toBe('session-config');
  });

  it('lists the stored session', async () => {
    const response = await connection.agent.request('session/list', { cwd: workspace });
    const entry = response.sessions.find((session: any) => session.sessionId === sessionId);
    expect(entry).toBeTruthy();
    expect(entry.cwd).toBe(workspace);
    expect(entry._meta.dsh.kind).toBe('session-list-item');
  });

  it('closes the session and replays it on load', async () => {
    await connection.agent.request('session/close', { sessionId });
    const before = updates.length;
    const response = await connection.agent.request('session/load', { sessionId, cwd: workspace, mcpServers: [] });
    expect(response._meta.dsh.kind).toBe('session-load');
    expect(response._meta.dsh.replayed).toBeGreaterThan(0);

    const replayed = updates.slice(before);
    const replayedEvents = eventTypes();
    expect(replayedEvents).toContain('command/run');
    expect(replayedEvents).toContain('command/done');
    const commandChunk = replayed.find((notification) => notification.update._meta?.dsh?.kind === 'update.command_done');
    expect(commandChunk).toBeTruthy();
    expect(replayed.every((notification) => notification.sessionId === sessionId)).toBe(true);
  });

  it('refuses to fork a session with no completed turn', async () => {
    await expect(connection.agent.request('session/fork', { sessionId, cwd: workspace })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('rejects cwd mismatches and unknown sessions with JSON-RPC errors', async () => {
    await connection.agent.request('session/close', { sessionId });
    await expect(
      connection.agent.request('session/load', { sessionId, cwd: join(workspace, 'elsewhere'), mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      connection.agent.request('session/load', { sessionId: 'does-not-exist', cwd: workspace, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32002 });
    await expect(connection.agent.request('session/close', { sessionId: 'does-not-exist' })).resolves.toBeTruthy();
    await expect(
      connection.agent.request('session/prompt', { sessionId: 'does-not-exist', prompt: [{ type: 'text', text: 'x' }] }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it('sends no frame mirrors for a command-only session', () => {
    expect(frames).toEqual([]);
  });
});
