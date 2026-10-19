/**
 * Transient assistant-stream framing: one attempt at a time, revision-fenced,
 * dense chunk indexes, text/reasoning deltas surfaced as ACP chunks.
 *
 * `revision` is a per-session monotonic frame counter (not an attempt
 * constant), so every accepted frame must carry a strictly greater revision
 * than the last accepted one; that drops replayed or superseded frames.
 * @module dsh-acp-plus/stream
 */
export interface StreamFrame {
  type: 'start' | 'chunk' | 'end';
  attemptId: string;
  revision: number;
  turn?: number;
  step?: number;
  index?: number;
  time?: number;
  chunk?: any;
  outcome?: any;
}

export interface StreamDelta {
  kind: 'text' | 'reasoning';
  text: string;
  messageId: string;
}

export class StreamAccumulator {
  private attemptId: string | null = null;
  private lastRevision = -1;
  private nextIndex = 0;
  private ended = false;
  private turn: number | undefined;
  private step: number | undefined;

  /** Current attempt identity, or undefined before the first frame. */
  get attempt(): string | null {
    return this.attemptId;
  }

  get currentTurn(): number | undefined {
    return this.turn;
  }

  get currentStep(): number | undefined {
    return this.step;
  }

  get finished(): boolean {
    return this.ended;
  }

  messageId(): string | null {
    return this.attemptId ? `attempt:${this.attemptId}` : null;
  }

  /** Step key (`turn:step`) of the current attempt, for committed-message de-duplication. */
  stepKey(): string | null {
    if (this.turn === undefined || this.step === undefined) return null;
    return `${this.turn}:${this.step}`;
  }

  /**
   * Feed one frame.
   * @returns deltas to publish, or an empty list for stale/replayed frames.
   */
  push(frame: StreamFrame): StreamDelta[] {
    if (!frame || typeof frame !== 'object') return [];
    const revision = Number(frame.revision);
    if (!Number.isFinite(revision) || revision <= this.lastRevision) return [];

    if (frame.type === 'start') {
      // A replacement attempt starts a fresh index space and message id.
      this.attemptId = frame.attemptId;
      this.lastRevision = revision;
      this.nextIndex = 0;
      this.ended = false;
      this.turn = frame.turn;
      this.step = frame.step;
      return [];
    }
    if (!this.attemptId || frame.attemptId !== this.attemptId) return [];
    this.lastRevision = revision;
    if (frame.type === 'end') {
      this.ended = true;
      return [];
    }
    if (this.ended) return [];
    const index = typeof frame.index === 'number' ? frame.index : -1;
    if (index !== this.nextIndex) return [];
    this.nextIndex += 1;
    const chunk = frame.chunk;
    if (!chunk || typeof chunk !== 'object') return [];
    const messageId = this.messageId();
    if (!messageId) return [];
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      return [{ kind: 'text', text: chunk.text, messageId }];
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      return [{ kind: 'reasoning', text: chunk.text, messageId }];
    }
    return [];
  }
}
