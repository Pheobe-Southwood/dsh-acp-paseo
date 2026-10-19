import { describe, expect, it } from 'vitest';
import { projectEvent, usageFromEvent } from '../src/projection.js';

const context = { replay: false, streamedSteps: new Set<string>() };
const event = (type: string, data: any, seq = 1) => ({ type, seq, time: 1_700_000_000_000, data });

describe('durable event projection', () => {
  it('projects user messages as user_message_chunk', () => {
    const updates = projectEvent(event('user/message', { id: 'u1', content: [{ type: 'text', text: 'hello' }] }), context);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hello' },
      messageId: 'u1',
    });
    expect((updates[0]._meta as any).dsh.kind).toBe('update.user_message_chunk');
  });

  it('projects committed assistant messages unless the step was streamed live', () => {
    const committed = event('assistant/message', {
      turn: 2,
      step: 1,
      message: { id: 'a1', content: [{ type: 'text', text: 'hi' }, { type: 'reasoning', text: 'why' }] },
    });
    expect(projectEvent(committed, context).map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_thought_chunk',
    ]);
    const streamed = { replay: false, streamedSteps: new Set(['2:1']) };
    expect(projectEvent(committed, streamed)).toEqual([]);
    expect(projectEvent(committed, { ...streamed, replay: true })).toHaveLength(2);
  });

  it('projects titles, todos, compaction and command output', () => {
    expect(projectEvent(event('session/title', { title: 'New title', source: 'llm' }), context)[0]).toMatchObject({
      sessionUpdate: 'session_info_update',
      title: 'New title',
    });
    const plan = projectEvent(
      event('todo/write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }),
      context,
    )[0];
    expect(plan).toMatchObject({ sessionUpdate: 'plan' });
    expect(plan.entries).toEqual([
      { content: 'a', priority: 'medium', status: 'completed' },
      { content: 'b', priority: 'medium', status: 'in_progress' },
    ]);
    expect(projectEvent(event('compaction/start', { compactionId: 'c1', turn: 3 }), context)[0]).toMatchObject({
      sessionUpdate: 'compaction_update',
      compactionId: 'c1',
      status: 'in_progress',
    });
    expect(
      projectEvent(event('compaction/summary', { compactionId: 'c1', summary: [{ type: 'text', text: 'digest' }] }), context)[0],
    ).toMatchObject({ sessionUpdate: 'compaction_update', status: 'completed', summary: [{ type: 'text', text: 'digest' }] });
    expect(projectEvent(event('compaction/end', { compactionId: 'c1', error: 'boom' }), context)[0]).toMatchObject({
      sessionUpdate: 'compaction_update',
      status: 'failed',
      error: 'boom',
    });
    expect(projectEvent(event('command/done', { commandId: 'x', kind: 'success', text: 'output' }), context)[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'output' },
    });
    expect(projectEvent(event('command/done', { commandId: 'x', kind: 'success' }), context)).toEqual([]);
  });

  it('projects tool calls and results through the tool projector', () => {
    const call = projectEvent(event('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }), context)[0];
    expect(call).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute' });
    const result = projectEvent(
      event('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false } }),
      context,
    )[0];
    expect(result).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
  });

  it('leaves unknown event kinds to the _dsh/event mirror', () => {
    expect(projectEvent(event('approval/decided', { decision: 'allowed-once' }), context)).toEqual([]);
    expect(projectEvent(event('step/start', { turn: 1, step: 1 }), context)).toEqual([]);
  });

  it('reports usage only for assistant messages', () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    expect(usageFromEvent(event('assistant/message', { usage }))).toEqual(usage);
    expect(usageFromEvent(event('turn/end', { reason: { kind: 'completed' } }))).toBeUndefined();
  });
});
