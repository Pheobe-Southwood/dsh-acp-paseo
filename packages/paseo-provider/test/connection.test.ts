import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderEventSchema, ProviderInputSchema } from '@getpaseo/plugin/server/provider';
import { describe, expect, it, vi } from 'vitest';
import { AcpSessionClient } from '../server/acp-client.js';
import { createConnection } from '../server/connection.js';
import { createFakeAgent, defaultModes, type FakeAgentHooks } from './fake-agent.js';

const CAPABILITIES = [
  'prompt.message',
  'prompt.command',
  'permission',
  'permission.tool_policy',
  'session.configure',
  'session.list',
  'session.persistence',
];

function sessionConfig(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/tmp/project',
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
    ...overrides,
  };
}

async function harness(hooks: FakeAgentHooks = {}) {
  const home = await mkdtemp(join(tmpdir(), 'paseo-meta-'));
  const app = createFakeAgent(hooks);
  const events: any[] = [];
  const connection = createConnection({
    request: { versions: [1], capabilities: CAPABILITIES } as any,
    capabilities: CAPABILITIES,
    overrides: {
      paseoHome: home,
      createClient: (_sessionId, _config, clientHooks) => {
        const client = new AcpSessionClient(clientHooks);
        client.connectToApp(app);
        return client;
      },
    },
  });
  connection.onEvent((event) => events.push(event));
  const send = async (input: any) => {
    const parsed = ProviderInputSchema.safeParse(input);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
    await connection.send(input as any);
  };
  return { home, events, connection, send };
}

function assertSchema(events: any[]) {
  for (const event of events) {
    const parsed = ProviderEventSchema.safeParse(event);
    expect(parsed.success, `${event.type}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a provider event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('paseo provider connection', () => {
  it('opens a new session with opened -> persistence -> config -> ready ordering', async () => {
    const { events, send } = await harness();
    await send({ type: 'session.open', requestId: 'open-1', sessionId: 'paseo-1', config: sessionConfig(), history: 'skip' });

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('session.opened');
    expect(types[types.length - 1]).toBe('session.ready');
    expect(types.indexOf('session.persistence')).toBeGreaterThan(0);
    expect(types.indexOf('session.config')).toBeLessThan(types.indexOf('session.ready'));

    const opened = events[0];
    expect(opened.sessionId).toBe('paseo-1');
    expect(opened.cwd).toBe('/tmp/project');
    expect(opened.restoration).toBe('core');
    expect(opened.capabilities).toEqual(CAPABILITIES);

    const config = events.find((event) => event.type === 'session.config');
    expect(config.config.model).toBe('deepseek-v4-flash');
    expect(config.config.models.map((model: any) => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(config.config.thinkingOptions.map((option: any) => option.id)).toEqual(['low', 'medium', 'high']);
    expect(config.config.settings[0].id).toBe('approval_policy');
    assertSchema(events);
  });

  it('replays stored history between opened and ready when restoring', async () => {
    const { events, send } = await harness({
      onLoad: async ({ params, client }) => {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'restored' }, messageId: 'm1' },
        });
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'restored question' }, messageId: 'u1' },
        });
      },
    });
    await send({
      type: 'session.open',
      requestId: 'open-2',
      sessionId: 'paseo-2',
      config: sessionConfig(),
      persistence: { version: 1, data: { nativeSessionId: 'dsh-session-1' } },
      history: 'replay',
    });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('session.opened');
    expect(types[types.length - 1]).toBe('session.ready');
    const itemIndex = events.findIndex((event) => event.type === 'timeline.item');
    expect(itemIndex).toBeGreaterThan(0);
    expect(itemIndex).toBeLessThan(types.length - 1);
    expect(events[itemIndex].item).toMatchObject({ type: 'assistant_message', text: 'restored' });
    const restoredUser = events
      .filter((event) => event.type === 'timeline.item')
      .map((event) => event.item)
      .find((item) => item.type === 'user_message');
    expect(restoredUser.text).toBe('restored question');
    assertSchema(events);
  });

  it('streams assistant text, tool calls, plans and usage into the timeline', async () => {
    const { events, send } = await harness({
      onPrompt: async ({ params, client }) => {
        const update = (value: any) => client.notify('session/update', { sessionId: params.sessionId, update: value });
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' }, messageId: 'm2' });
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' }, messageId: 'm2' });
        await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' }, messageId: 'm2' });
        await update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'injected runtime context' }, messageId: 'u2' });
        await update({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'bash',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'ls -la' },
        });
        await update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'file.txt' } }],
        });
        await update({ sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'medium', status: 'pending' }] });
        await update({ sessionUpdate: 'usage_update', used: 120, size: 1000 });
      },
    });
    await send({ type: 'session.open', requestId: 'open-3', sessionId: 'paseo-3', config: sessionConfig(), history: 'skip' });
    await send({
      type: 'session.prompt',
      sessionId: 'paseo-3',
      prompt: { clientMessageId: 'cm-1', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello' }] } },
    });

    await waitFor(() => events.some((event) => event.type === 'session.turn' && event.state === 'completed'));
    const items = events.filter((event) => event.type === 'timeline.item').map((event) => event.item);
    const assistant = items.filter((item) => item.type === 'assistant_message').at(-1);
    expect(assistant.text).toBe('Hello');
    const reasoning = items.find((item) => item.type === 'reasoning');
    expect(reasoning.text).toBe('thinking');
    const tool = items.filter((item) => item.type === 'tool_call').at(-1);
    expect(tool.status).toBe('completed');
    expect(tool.detail).toMatchObject({ type: 'shell', command: 'ls -la', output: 'file.txt' });
    const todo = items.find((item) => item.type === 'todo');
    expect(todo.items[0]).toMatchObject({ text: 'step one', completed: false });
    // Paseo owns the live user message; DSH user events only carry the injected
    // runtime context and must not add a duplicate bubble.
    expect(items.filter((item) => item.type === 'user_message')).toHaveLength(0);
    const usage = events.filter((event) => event.type === 'session.usage').at(-1);
    expect(usage.usage).toMatchObject({ contextWindowUsedTokens: 120, contextWindowMaxTokens: 1000 });
    expect(events.filter((event) => event.type === 'session.prompt_result')).toHaveLength(1);
    assertSchema(events);
  });

  it('round-trips a tool permission request', async () => {
    let outcome: any;
    const { events, send } = await harness({
      onPrompt: async ({ params, client }) => {
        outcome = await client.request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 't9', title: 'write_file', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
          _meta: { dsh: { v: 1, kind: 'permission-request', native: { toolName: 'write_file' }, reason: 'writes a file' } },
        });
      },
    });
    await send({ type: 'session.open', requestId: 'open-4', sessionId: 'paseo-4', config: sessionConfig(), history: 'skip' });
    await send({
      type: 'session.prompt',
      sessionId: 'paseo-4',
      prompt: { clientMessageId: 'cm-2', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'write' }] } },
    });
    await waitFor(() => events.some((event) => event.type === 'session.permission'));
    const request = events.find((event) => event.type === 'session.permission').request;
    expect(request.kind).toBe('tool');
    expect(request.actions.map((action: any) => action.id)).toEqual(['allow_once', 'reject_once']);
    await send({
      type: 'session.permission',
      sessionId: 'paseo-4',
      permissionId: request.id,
      response: { behavior: 'allow', selectedActionId: 'allow_once' },
    });
    await waitFor(() => events.some((event) => event.type === 'session.turn' && event.state === 'completed'));
    expect(outcome.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(events.some((event) => event.type === 'session.permission_resolved')).toBe(true);
    assertSchema(events);
  });

  it('round-trips an interactive question through the question card shape', async () => {
    let response: any;
    const { events, send } = await harness({
      onPrompt: async ({ params, client }) => {
        response = await client.request('_dsh/user_questions', {
          v: 1,
          requestId: 'q-1',
          sessionId: params.sessionId,
          timeoutMs: 5000,
          questions: [
            {
              id: 'q1',
              header: 'Which target?',
              question: 'Which environment should I deploy to?',
              detail: 'Defaults to staging',
              options: [{ label: 'staging' }, { label: 'production' }],
              multiSelect: false,
            },
          ],
        });
      },
    });
    await send({ type: 'session.open', requestId: 'open-5', sessionId: 'paseo-5', config: sessionConfig(), history: 'skip' });
    await send({
      type: 'session.prompt',
      sessionId: 'paseo-5',
      prompt: { clientMessageId: 'cm-3', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'deploy' }] } },
    });
    await waitFor(() => events.some((event) => event.type === 'session.permission'));
    const request = events.find((event) => event.type === 'session.permission').request;
    expect(request.kind).toBe('question');
    expect(request.input.questions[0]).toMatchObject({
      header: 'Which target?',
      question: 'Which environment should I deploy to?',
      allowOther: true,
      multiSelect: false,
    });
    expect(request.input.questions[0].options).toEqual([{ label: 'staging' }, { label: 'production' }]);
    await send({
      type: 'session.permission',
      sessionId: 'paseo-5',
      permissionId: request.id,
      response: { behavior: 'allow', updatedInput: { answers: { 'Which target?': 'production' } } },
    });
    await waitFor(() => response !== undefined);
    expect(response).toEqual({ answers: [{ id: 'q1', selected: ['production'] }] });
    assertSchema(events);
  });

  it('applies config changes and republishes config', async () => {
    const { events, send } = await harness();
    await send({ type: 'session.open', requestId: 'open-6', sessionId: 'paseo-6', config: sessionConfig(), history: 'skip' });
    await send({ type: 'session.configure', requestId: 'cfg-1', sessionId: 'paseo-6', changes: { model: 'deepseek-v4-pro' } });
    const config = events.filter((event) => event.type === 'session.config').at(-1);
    expect(config.config.model).toBe('deepseek-v4-pro');
    expect(events.some((event) => event.type === 'request.completed' && event.requestId === 'cfg-1')).toBe(true);
    assertSchema(events);
  });

  it('exposes DSH presets as catalog modes and applies mode changes', async () => {
    const applied: string[] = [];
    const { events, send } = await harness({
      modes: defaultModes(),
      onSetMode: ({ params }) => applied.push(String(params.modeId)),
    });
    await send({ type: 'catalog', requestId: 'cat-1', cwd: '/tmp/project' });
    const catalog = events.find((event) => event.type === 'catalog');
    expect(catalog.catalog.modes.map((mode: any) => mode.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis']);
    expect(catalog.catalog.defaultMode).toBe('standard');

    await send({ type: 'session.open', requestId: 'open-m', sessionId: 'paseo-m', config: sessionConfig({ mode: 'ptc' }), history: 'skip' });
    expect(applied).toContain('ptc');
    expect(events.filter((event) => event.type === 'session.config').at(-1).config.mode).toBe('ptc');

    await send({ type: 'session.configure', requestId: 'cfg-m', sessionId: 'paseo-m', changes: { mode: 'minimal' } });
    expect(applied).toContain('minimal');
    expect(events.filter((event) => event.type === 'session.config').at(-1).config.mode).toBe('minimal');
    assertSchema(events);
  });

  it('reflects an agent-initiated current_mode_update in session config', async () => {
    const { events, send } = await harness({
      modes: defaultModes(),
      onPrompt: async ({ params, client }) => {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'cordis' },
        });
      },
    });
    await send({ type: 'session.open', requestId: 'open-mode', sessionId: 'paseo-mode', config: sessionConfig(), history: 'skip' });
    await send({
      type: 'session.prompt',
      sessionId: 'paseo-mode',
      prompt: { clientMessageId: 'cm-mode', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hi' }] } },
    });
    await waitFor(() => events.some((event) => event.type === 'session.turn' && event.state === 'completed'));
    expect(events.filter((event) => event.type === 'session.config').at(-1).config.mode).toBe('cordis');
    assertSchema(events);
  });

  it('lists stored sessions from the agent', async () => {
    const { events, send } = await harness();
    await send({ type: 'sessions', requestId: 'list-1', cwd: '/tmp/project' });
    const listed = events.find((event) => event.type === 'sessions');
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ cwd: '/tmp/project', title: 'Stored session', updatedAt: '2026-01-02T03:04:05.000Z' });
    expect(listed.sessions[0].persistence.data.nativeSessionId).toBe('dsh-session-1');
    assertSchema(events);
  });

  it('stores _meta, events and frames in the sidecar without rendering them', async () => {
    const { home, events, send } = await harness({
      onPrompt: async ({ params, client }) => {
        await client.notify('_dsh/event', {
          v: 1,
          sessionId: params.sessionId,
          event: { type: 'approval/policy', seq: 7, time: 1, data: { policy: 'never' } },
        });
        await client.notify('_dsh/frame', { v: 1, sessionId: params.sessionId, frame: { type: 'start', attemptId: 'a', revision: 1 } });
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi' },
            messageId: 'm1',
            _meta: { dsh: { v: 1, kind: 'agent_message_chunk', native: { big: 'payload' } } },
          },
        });
      },
    });
    await send({ type: 'session.open', requestId: 'open-7', sessionId: 'paseo-7', config: sessionConfig(), history: 'skip' });
    await send({
      type: 'session.prompt',
      sessionId: 'paseo-7',
      prompt: { clientMessageId: 'cm-4', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hi' }] } },
    });
    await waitFor(() => events.some((event) => event.type === 'session.turn' && event.state === 'completed'));
    const persistence = events.filter((event) => event.type === 'session.persistence').at(-1);
    expect(persistence.persistence.data.metaLog.file).toBe(join(home, 'plugin-data', 'deepseek-harness', 'sessions', 'paseo-7.meta.jsonl'));
    const lines = (await readFile(persistence.persistence.data.metaLog.file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.src)).toEqual(expect.arrayContaining(['event', 'frame', 'update']));
    const eventLine = lines.find((line) => line.src === 'event');
    expect(eventLine.payload.event.type).toBe('approval/policy');
    const updateLine = lines.find((line) => line.src === 'update');
    expect(updateLine.payload.meta.kind).toBe('agent_message_chunk');
    assertSchema(events);
  });

  it('rejects inputs that need capabilities the connection did not negotiate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'paseo-meta-'));
    const app = createFakeAgent();
    const connection = createConnection({
      request: { versions: [1], capabilities: CAPABILITIES } as any,
      capabilities: ['prompt.message'],
      overrides: {
        paseoHome: home,
        createClient: (_sessionId, _config, clientHooks) => {
          const client = new AcpSessionClient(clientHooks);
          client.connectToApp(app);
          return client;
        },
      },
    });
    connection.onEvent(() => undefined);
    await expect(
      connection.send({
        type: 'session.configure',
        requestId: 'cfg-2',
        sessionId: 'paseo-8',
        changes: { model: 'x' },
      } as any),
    ).rejects.toThrow();
  });

  it('fails an unknown session instead of silently succeeding', async () => {
    const { send } = await harness();
    await expect(
      send({ type: 'session.interrupt', requestId: 'i-1', sessionId: 'missing' }),
    ).rejects.toThrow(/Unknown session/);
    expect(vi.isMockFunction(send)).toBe(false);
  });
});
