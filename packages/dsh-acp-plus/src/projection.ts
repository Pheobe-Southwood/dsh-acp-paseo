/**
 * Durable-event projection: one DSH session event becomes zero or more ACP
 * `session/update` payloads. Every update carries a `_meta.dsh` envelope with
 * the originating event verbatim; the session bridge separately mirrors the
 * event on the `_dsh/event` extension notification channel.
 * @module dsh-acp-plus/projection
 */
import { blocksToChunks } from './content.js';
import type { DshEvent } from './dsh-types.js';
import { updateMeta } from './meta.js';
import { toolCallUpdateFromCall, toolCallUpdateFromResult } from './tool-projection.js';

export interface ProjectionContext {
  /** Replay projects everything; live projection skips already-streamed text. */
  replay: boolean;
  /** `turn:step` keys whose assistant text was already streamed as frames. */
  streamedSteps: ReadonlySet<string>;
}

export type AcpUpdate = Record<string, unknown>;

function chunkUpdates(event: DshEvent, chunks: ReturnType<typeof blocksToChunks>, kind: string): AcpUpdate[] {
  return chunks.map((chunk) => ({
    sessionUpdate: chunk.sessionUpdate,
    content: chunk.content,
    ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
    _meta: updateMeta(kind, event),
  }));
}

/** Project one durable event into ACP updates. */
export function projectEvent(event: DshEvent, context: ProjectionContext): AcpUpdate[] {
  const data: any = event?.data ?? {};
  switch (event.type) {
    case 'user/message': {
      const messageId = data.id === undefined ? undefined : String(data.id);
      const chunks = blocksToChunks(data.content, 'user', messageId);
      return chunkUpdates(event, chunks, 'user_message_chunk');
    }
    case 'assistant/message': {
      const key = `${data.turn}:${data.step}`;
      if (!context.replay && context.streamedSteps.has(key)) return [];
      const messageId = data.message?.id === undefined ? undefined : String(data.message.id);
      const chunks = blocksToChunks(data.message?.content, 'assistant', messageId);
      return chunkUpdates(event, chunks, 'assistant_message');
    }
    case 'tool/call':
      return [toolCallUpdateFromCall(event)];
    case 'tool/result':
      return [toolCallUpdateFromResult(event)];
    case 'session/title':
      return [
        {
          sessionUpdate: 'session_info_update',
          title: typeof data.title === 'string' ? data.title : undefined,
          updatedAt: new Date(event.time).toISOString(),
          _meta: updateMeta('session_info_update', event, { source: data.source }),
        },
      ];
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      return [
        {
          sessionUpdate: 'plan',
          entries: todos.map((todo: any) => ({
            content: String(todo?.content ?? ''),
            priority: 'medium',
            status: todo?.status === 'completed' ? 'completed' : todo?.status === 'in_progress' ? 'in_progress' : 'pending',
          })),
          _meta: updateMeta('plan', event),
        },
      ];
    }
    case 'compaction/start':
      return [
        {
          sessionUpdate: 'compaction_update',
          compactionId: String(data.compactionId ?? `compaction-${event.seq}`),
          status: 'in_progress',
          _meta: updateMeta('compaction_update', event, { turn: data.turn }),
        },
      ];
    case 'compaction/summary': {
      const summary = blocksToChunks(data.summary, 'assistant');
      return [
        {
          sessionUpdate: 'compaction_update',
          compactionId: String(data.compactionId ?? `compaction-${event.seq}`),
          status: 'completed',
          ...(summary.length > 0
            ? { summary: summary.map((chunk) => ({ type: 'text', text: chunk.content.text })) }
            : {}),
          _meta: updateMeta('compaction_update', event, {
            shadowedRange: data.shadowedRange,
            shadowedTokenCount: data.shadowedTokenCount,
          }),
        },
      ];
    }
    case 'compaction/end':
      return [
        {
          sessionUpdate: 'compaction_update',
          compactionId: String(data.compactionId ?? `compaction-${event.seq}`),
          status: data.error ? 'failed' : 'completed',
          ...(data.error ? { error: String(data.error) } : {}),
          _meta: updateMeta('compaction_update', event, { turn: data.turn }),
        },
      ];
    case 'command/done': {
      if (typeof data.text !== 'string' || data.text.length === 0) return [];
      return [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: data.text },
          _meta: updateMeta('command_done', event, { commandId: data.commandId, resultKind: data.kind }),
        },
      ];
    }
    default:
      return [];
  }
}

/** Assistant usage from a committed `assistant/message` event, if reported. */
export function usageFromEvent(event: DshEvent): any | undefined {
  if (event?.type !== 'assistant/message') return undefined;
  return (event.data as any)?.usage;
}
