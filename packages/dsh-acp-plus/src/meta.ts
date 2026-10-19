/**
 * The `_meta.dsh` envelope and the DSH extension method vocabulary.
 *
 * Two channels carry native semantics:
 * - typed `_meta.dsh` envelopes attached to standard ACP payloads, and
 * - `_dsh/event` notifications mirroring every durable session event verbatim.
 *
 * Together they make the projection lossless for clients that understand DSH
 * and harmless for clients that do not (unknown extension notifications are
 * ignored per the ACP specification).
 * @module dsh-acp-plus/meta
 */
import { jsonSafe } from './dsh-types.js';

/** Envelope schema version. */
export const META_VERSION = 1 as const;

/** Extension notification mirroring one durable session event. */
export const EXT_EVENT = '_dsh/event';
/** Extension request carrying interactive questions to the client. */
export const EXT_QUESTIONS = '_dsh/user_questions';
/** Extension request forking a session (also exposed as the unstable `session/fork`). */
export const EXT_FORK = '_dsh/session/fork';

/** Extension notification carrying one transient assistant-stream frame. */
export const EXT_FRAME = '_dsh/frame';

export interface DshMetaEnvelope {
  v: number;
  kind: string;
  [key: string]: unknown;
}

/** Keys owned by the envelope itself; extras may never shadow them. */
const RESERVED_ENVELOPE_KEYS = new Set(['v', 'kind']);

/**
 * Build the `_meta` object attached to an outbound payload.
 * @param kind - stable envelope kind, e.g. `update.tool_call` or `session-new`.
 * @param fields - typed extras for this kind (`native` carries the origin object).
 */
export function dshMeta(kind: string, fields: Record<string, unknown> = {}): { dsh: DshMetaEnvelope } {
  const envelope: DshMetaEnvelope = { v: META_VERSION, kind };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || RESERVED_ENVELOPE_KEYS.has(key)) continue;
    envelope[key] = value;
  }
  return { dsh: envelope };
}

/** Envelope for a standard update, keeping the originating event verbatim. */
export function updateMeta(kind: string, native: unknown, extra: Record<string, unknown> = {}): { dsh: DshMetaEnvelope } {
  return dshMeta(`update.${kind}`, { native: jsonSafe(native), ...extra });
}

/** `_dsh/event` notification params for one durable event. */
export function eventNotification(sessionId: string, event: unknown): Record<string, unknown> {
  return { v: META_VERSION, sessionId, event: jsonSafe(event) };
}

/** `_dsh/frame` notification params for one transient assistant-stream frame. */
export function frameNotification(sessionId: string, frame: unknown): Record<string, unknown> {
  return { v: META_VERSION, sessionId, frame: jsonSafe(frame) };
}

/** The capability block advertised in the `initialize` response `_meta`. */
export function initializeMeta(input: {
  version: string;
  dshVersion?: string;
  image: boolean;
  fork: boolean;
  loadSession: boolean;
}): { dsh: DshMetaEnvelope } {
  return dshMeta('initialize', {
    agent: { name: 'dsh-acp-plus', version: input.version },
    dsh: input.dshVersion ? { version: input.dshVersion } : undefined,
    protocol: 1,
    image: input.image,
    configOptions: ['model', 'reasoning_effort', 'approval_policy', 'sandbox_mode', 'plan_mode'],
    extensions: {
      event: EXT_EVENT,
      frame: EXT_FRAME,
      questions: EXT_QUESTIONS,
      fork: EXT_FORK,
    },
    features: { fork: input.fork, loadSession: input.loadSession, cost: false },
  });
}
