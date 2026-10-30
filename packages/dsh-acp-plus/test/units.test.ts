import { describe, expect, it } from 'vitest';
import {
  ContentError,
  blocksToChunks,
  blocksToText,
  isCanonicalBase64,
  promptToDshContent,
} from '../src/content.js';
import { decodeModel, encodeModel, applyConfigOption, buildConfigOptions } from '../src/config-options.js';
import {
  EXT_EVENT,
  EXT_FRAME,
  EXT_QUESTIONS,
  META_VERSION,
  dshMeta,
  eventNotification,
  frameNotification,
  initializeMeta,
  updateMeta,
} from '../src/meta.js';
import { mcpPluginConfig, resolveMcpConfigs } from '../src/mcp.js';
import { buildSessionModes } from '../src/modes.js';
import { StreamAccumulator } from '../src/stream.js';
import {
  inferToolKind,
  locationsFromInput,
  parseArguments,
  toolCallUpdateFromCall,
  toolCallUpdateFromResult,
} from '../src/tool-projection.js';

describe('_meta envelope', () => {
  it('stamps the schema version and kind, dropping undefined and reserved fields', () => {
    expect(dshMeta('session-new')).toEqual({ dsh: { v: META_VERSION, kind: 'session-new' } });
    expect(dshMeta('x', { a: 1, b: undefined })).toEqual({ dsh: { v: META_VERSION, kind: 'x', a: 1 } });
    expect(dshMeta('x', { kind: 'spoofed', v: 99 })).toEqual({ dsh: { v: META_VERSION, kind: 'x' } });
  });

  it('prefixes update kinds and keeps the native payload', () => {
    const event = { type: 'tool/call', seq: 4, time: 0, data: { callId: 'c1' } };
    const meta = updateMeta('tool_call', event);
    expect(meta.dsh.kind).toBe('update.tool_call');
    expect(meta.dsh.native).toEqual(event);
  });

  it('wraps events and frames for the extension channels', () => {
    expect(eventNotification('s1', { type: 'turn/start', seq: 1 })).toEqual({
      v: META_VERSION,
      sessionId: 's1',
      event: { type: 'turn/start', seq: 1 },
    });
    expect(frameNotification('s1', { type: 'start', attemptId: 'a' })).toEqual({
      v: META_VERSION,
      sessionId: 's1',
      frame: { type: 'start', attemptId: 'a' },
    });
  });

  it('advertises the extension vocabulary on initialize', () => {
    const meta = initializeMeta({ version: '0.1.0', dshVersion: '0.2.0-rc.2', image: true, fork: true, loadSession: true });
    expect(meta.dsh.kind).toBe('initialize');
    expect(meta.dsh.extensions).toEqual({
      event: EXT_EVENT,
      frame: EXT_FRAME,
      questions: EXT_QUESTIONS,
      fork: '_dsh/session/fork',
    });
    expect(meta.dsh.features).toEqual({ fork: true, loadSession: true, cost: false });
    expect(meta.dsh.dsh).toEqual({ version: '0.2.0-rc.2' });
  });
});

describe('content conversion', () => {
  it('accepts canonical base64 only', () => {
    expect(isCanonicalBase64('aGVsbG8=')).toBe(true);
    expect(isCanonicalBase64('aGVsbG8')).toBe(false);
    expect(isCanonicalBase64('!!!!')).toBe(false);
    expect(isCanonicalBase64('')).toBe(false);
  });

  it('joins text blocks and marks images', () => {
    expect(blocksToText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }])).toBe(
      'a[image]b',
    );
  });

  it('maps assistant and user blocks to the right chunk kinds', () => {
    const chunks = blocksToChunks(
      [
        { type: 'text', text: 'hello' },
        { type: 'reasoning', text: 'hmm' },
        { type: 'image' },
        { type: 'tool-call', callId: 'c1' },
      ],
      'assistant',
      'm1',
    );
    expect(chunks.map((chunk) => chunk.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
    ]);
    expect(chunks[0]).toMatchObject({ content: { type: 'text', text: 'hello' }, messageId: 'm1' });
    expect(chunks[1].content).toEqual({ type: 'text', text: 'hmm' });
    expect(chunks[2].content).toEqual({ type: 'text', text: '[image]' });
  });

  it('converts a text-only prompt', async () => {
    const result = await promptToDshContent([{ type: 'text', text: 'hi' }], undefined, false);
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(result.hasImages).toBe(false);
  });

  it('saves images through the attachment service', async () => {
    const saved: any[] = [];
    const attachments = {
      saveImages: async (images: any[]) => {
        saved.push(...images);
        return images.map((_image, index) => ({ type: 'image', id: `img-${index}` }));
      },
    };
    const result = await promptToDshContent(
      [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
      attachments,
      true,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].mediaType).toBe('image/png');
    expect(Buffer.from(saved[0].data).toString('utf8')).toBe('hello');
    expect(result.hasImages).toBe(true);
    expect(result.content[1]).toMatchObject({ type: 'image', attachment: { id: 'img-0' } });
  });

  it('rejects images when the model cannot take them, and rejects empty prompts', async () => {
    await expect(
      promptToDshContent([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], undefined, false),
    ).rejects.toBeInstanceOf(ContentError);
    await expect(promptToDshContent([{ type: 'text', text: '   ' }], undefined, false)).rejects.toBeInstanceOf(ContentError);
    await expect(promptToDshContent([{ type: 'audio', data: 'x' }], undefined, false)).rejects.toBeInstanceOf(ContentError);
    await expect(
      promptToDshContent([{ type: 'image', data: 'not base64!', mimeType: 'image/png' }], { saveImages: async () => [] }, true),
    ).rejects.toBeInstanceOf(ContentError);
  });
});

describe('mcp config translation', () => {
  it('accepts stdio and http servers', () => {
    const configs = resolveMcpConfigs(
      [
        { name: 'fs', command: '/usr/bin/mcp-fs', args: ['--root', '.'], env: { TOKEN: 'x' } },
        { name: 'web', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer y' } },
      ],
      '/tmp/project',
    );
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ transport: 'stdio', serverName: 'fs', command: '/usr/bin/mcp-fs', cwd: '/tmp/project' });
    expect(configs[1]).toMatchObject({ transport: 'streamable-http', serverName: 'web', url: 'https://example.com/mcp' });
    expect(mcpPluginConfig(configs[0])).toMatchObject({ transport: 'stdio', serverName: 'fs', args: ['--root', '.'] });
    expect(mcpPluginConfig(configs[1])).toMatchObject({ transport: 'streamable-http', serverName: 'web' });
  });

  it('accepts ACP name-value arrays for stdio env and HTTP headers', () => {
    const configs = resolveMcpConfigs(
      [
        { name: 'fs', command: '/usr/bin/mcp-fs', env: [{ name: 'TOKEN', value: 'placeholder' }] },
        { name: 'web', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer placeholder' }] },
      ],
      '/tmp/project',
    );

    expect(configs[0].env).toEqual({ TOKEN: 'placeholder' });
    expect(configs[1].headers).toEqual({ Authorization: 'Bearer placeholder' });
  });

  it('rejects malformed and duplicate ACP name-value entries', () => {
    expect(() => resolveMcpConfigs([{ name: 'web', url: 'https://example.com/mcp', headers: [{ name: 'x-test' }] }], '/tmp')).toThrow(
      ContentError,
    );
    expect(
      () =>
        resolveMcpConfigs(
          [{ name: 'web', url: 'https://example.com/mcp', headers: [{ name: 'x-test', value: 'one' }, { name: 'x-test', value: 'two' }] }],
          '/tmp',
        ),
    ).toThrow(ContentError);
  });

  it('normalizes unsafe names and rejects invalid entries', () => {
    const [config] = resolveMcpConfigs([{ name: 'my server!', command: '/bin/echo' }], '/tmp');
    expect(config.serverName).toMatch(/^my_server_[0-9a-f]{8}$/);
    expect(() => resolveMcpConfigs([{ name: 'x', command: 'relative' }], '/tmp')).toThrow(ContentError);
    expect(() => resolveMcpConfigs([{ name: 'x' }], '/tmp')).toThrow(ContentError);
    expect(() => resolveMcpConfigs([{ name: 'x', command: '/bin/echo', url: 'https://a' }], '/tmp')).toThrow(ContentError);
    expect(() => resolveMcpConfigs([{ name: 'x', url: 'ftp://a' }], '/tmp')).toThrow(ContentError);
    expect(() => resolveMcpConfigs([{ name: 'dup', command: '/bin/a' }, { name: 'dup', command: '/bin/b' }], '/tmp')).toThrow(
      ContentError,
    );
  });
});

describe('stream accumulator', () => {
  const start = { type: 'start' as const, attemptId: 'a1', revision: 1, turn: 2, step: 3 };
  let revision = 1;
  const chunk = (index: number, text: string) => ({
    type: 'chunk' as const,
    attemptId: 'a1',
    revision: ++revision,
    index,
    chunk: { type: 'text-delta', text },
  });
  const reset = () => {
    revision = 1;
  };

  it('emits dense text and reasoning deltas with a stable message id', () => {
    reset();
    const stream = new StreamAccumulator();
    expect(stream.push(start)).toEqual([]);
    expect(stream.messageId()).toBe('attempt:a1');
    expect(stream.stepKey()).toBe('2:3');
    expect(stream.push(chunk(0, 'Hel'))).toEqual([{ kind: 'text', text: 'Hel', messageId: 'attempt:a1' }]);
    expect(stream.push({ ...chunk(1, 'lo'), chunk: { type: 'reasoning-delta', text: 'lo' } })).toEqual([
      { kind: 'reasoning', text: 'lo', messageId: 'attempt:a1' },
    ]);
  });

  it('drops out-of-order, replayed and unknown-attempt frames', () => {
    reset();
    const stream = new StreamAccumulator();
    stream.push(start);
    expect(stream.push(chunk(5, 'skip'))).toEqual([]);
    const replayed = { ...chunk(0, 'x'), revision: 2 };
    expect(stream.push(replayed)).toEqual([]);
    expect(stream.push({ ...chunk(0, 'x'), attemptId: 'other' })).toEqual([]);
    expect(stream.push(chunk(0, 'ok'))).toHaveLength(1);
    const endRevision = revision + 1;
    expect(stream.push({ type: 'end', attemptId: 'a1', revision: endRevision })).toEqual([]);
    revision = endRevision;
    expect(stream.finished).toBe(true);
    expect(stream.push(chunk(1, 'after-end'))).toEqual([]);
  });

  it('restarts on a newer attempt', () => {
    reset();
    const stream = new StreamAccumulator();
    stream.push(start);
    stream.push(chunk(0, 'first'));
    expect(stream.push({ type: 'start', attemptId: 'a2', revision: ++revision, turn: 2, step: 4 })).toEqual([]);
    expect(stream.messageId()).toBe('attempt:a2');
    expect(stream.push({ ...chunk(0, 'second'), attemptId: 'a2' })).toHaveLength(1);
  });

  it('ignores a start whose revision was already seen', () => {
    reset();
    const stream = new StreamAccumulator();
    stream.push(start);
    expect(stream.push({ ...start, attemptId: 'a9' })).toEqual([]);
    expect(stream.messageId()).toBe('attempt:a1');
  });
});

describe('tool projection', () => {
  it('infers ACP tool kinds from DSH tool names', () => {
    expect(inferToolKind('read_file')).toBe('read');
    expect(inferToolKind('write_file')).toBe('edit');
    expect(inferToolKind('apply_patch')).toBe('edit');
    expect(inferToolKind('bash')).toBe('execute');
    expect(inferToolKind('glob_search')).toBe('search');
    expect(inferToolKind('fetch_url')).toBe('fetch');
    expect(inferToolKind('todo_write')).toBe('think');
  });

  it('parses JSON arguments and tolerates plain strings', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments('{"broken"')).toBe('{"broken"');
    expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseArguments(undefined)).toBeUndefined();
  });

  it('collects at most eight distinct locations', () => {
    const locations = locationsFromInput({ file_path: '/a', nested: { path: '/b' }, list: [{ path: '/a' }] });
    expect(locations).toEqual([{ path: '/a' }, { path: '/b' }]);
  });

  it('projects a tool call with kind, input and locations', () => {
    const update = toolCallUpdateFromCall({
      type: 'tool/call',
      seq: 11,
      time: 0,
      data: { callId: 'c1', name: 'read_file', arguments: '{"file_path":"/tmp/a.txt"}', turn: 1, step: 2 },
    });
    expect(update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      kind: 'read',
      status: 'in_progress',
      rawInput: { file_path: '/tmp/a.txt' },
      locations: [{ path: '/tmp/a.txt' }],
    });
    expect((update._meta as any).dsh.native.data.callId).toBe('c1');
  });

  it('projects a tool result with text, diff and failure status', () => {
    const update = toolCallUpdateFromResult({
      type: 'tool/result',
      seq: 12,
      time: 0,
      data: {
        message: { toolCallId: 'c1', content: [{ type: 'text', text: 'done' }], isError: false },
        meta: { diff: { path: '/tmp/a.txt', oldText: 'a', newText: 'b' } },
      },
    });
    expect(update).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
    expect(update.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'done' } },
      { type: 'diff', path: '/tmp/a.txt', oldText: 'a', newText: 'b' },
    ]);
    const failed = toolCallUpdateFromResult({
      type: 'tool/result',
      seq: 13,
      time: 0,
      data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'boom' }], isError: true } },
    });
    expect(failed.status).toBe('failed');
  });
});

describe('config options', () => {
  it('round-trips encoded model values', () => {
    expect(encodeModel('deepseek-official', 'deepseek-v4-flash')).toBe('deepseek-official/deepseek-v4-flash');
    expect(decodeModel('deepseek-official/deepseek-v4-flash')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    expect(decodeModel('nope')).toBeUndefined();
    expect(decodeModel('/model')).toBeUndefined();
  });

  it('builds the option list from the harness services', async () => {
    const ctx: any = {
      get: (name: string) => {
        if (name === 'llm') {
          return {
            listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
            listModels: async () => [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }],
            resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }),
          };
        }
        if (name === 'planMode') return { get: () => ({ active: true }), set: () => undefined };
        if (name === 'sandboxPolicy') return { defaultMode: 'read-only' };
        return undefined;
      },
    };
    const record = {
      agent: { session: {}, options: {} },
      selectionRef: { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, assembled: undefined },
      cwd: '/tmp',
    };
    const options = await buildConfigOptions(ctx, record);
    expect(options.map((option) => option.id)).toEqual([
      'model',
      'reasoning_effort',
      'approval_policy',
      'sandbox_mode',
      'plan_mode',
    ]);
    expect(options[0].currentValue).toBe('deepseek-official/deepseek-v4-flash');
    expect(options[0].category).toBe('model');
    expect(options[1].currentValue).toBe('low');
    expect(options[2].currentValue).toBe('ask');
    expect(options[3].currentValue).toBe('read-only');
    expect(options[4].currentValue).toBe('on');
  });

  it('applies selections and rejects unknown or invalid values', () => {
    const record: any = {
      agent: { session: {}, options: {} },
      selectionRef: { current: { provider: 'p', model: 'm' }, assembled: undefined },
      cwd: '/tmp',
    };
    applyConfigOption({ get: () => undefined } as any, record, 'model', 'other/model-x');
    expect(record.selectionRef.current).toEqual({ provider: 'other', model: 'model-x', reasoningEffort: undefined });
    applyConfigOption({ get: () => undefined } as any, record, 'reasoning_effort', 'high');
    expect(record.selectionRef.current.reasoningEffort).toBe('high');
    expect(() => applyConfigOption({ get: () => undefined } as any, record, 'model', 'bad')).toThrow(ContentError);
    expect(() => applyConfigOption({ get: () => undefined } as any, record, 'approval_policy', 'sometimes')).toThrow(
      ContentError,
    );
    expect(() => applyConfigOption({ get: () => undefined } as any, record, 'nope', 'x')).toThrow(ContentError);
  });
});

describe('agent presets as session modes', () => {
  it('returns undefined when the profile declares no preset registry', async () => {
    expect(await buildSessionModes({ get: () => undefined } as any, {})).toBeUndefined();
  });

  it('labels the four DSH presets and follows the composed preset', async () => {
    const presets = {
      defaultId: 'standard',
      list: async () => [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }],
      composedPreset: () => 'minimal',
    };
    const modes = await buildSessionModes({ get: () => presets } as any, { agent: { ctx: {} } });
    expect(modes?.currentModeId).toBe('minimal');
    expect(modes?.availableModes.map((mode) => mode.name)).toEqual([
      'Standard mode',
      'PTC mode',
      'Minimal mode',
      'Creator mode',
    ]);
    expect(modes?.availableModes.every((mode) => typeof mode.description === 'string')).toBe(true);
  });

  it('keeps custom names, drops broken presets, and falls back to the first usable mode', async () => {
    const presets = {
      defaultId: 'gone',
      list: async () => [
        { id: 'broken', name: 'Broken', broken: { reason: 'missing plugin' } },
        { id: 'first' },
        { id: 'custom', name: 'Team mode', description: 'House rules' },
      ],
      composedPreset: () => 'gone',
    };
    const modes = await buildSessionModes({ get: () => presets } as any, {});
    expect(modes?.availableModes).toEqual([
      { id: 'first', name: 'first' },
      { id: 'custom', name: 'Team mode', description: 'House rules' },
    ]);
    expect(modes?.currentModeId).toBe('first');
  });
});
