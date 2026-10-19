/**
 * Minimal structural view of the DeepSeek Harness runtime consumed by the
 * bridge. The bridge deliberately depends on a small structural surface (plus a
 * handful of documented public helpers) so it can be built and unit-tested
 * without booting the whole harness.
 * @module dsh-acp-plus/dsh-types
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One durable session event envelope. */
export interface DshEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: any;
  readonly ignorable?: boolean;
}

/** The live session driven by an agent. */
export interface DshSession {
  readonly id: string;
  readonly header?: any;
  readonly firstLifecycleSeq?: number;
  requestContext?(): any;
  whenIdle?(): Promise<void>;
}

/** The live agent the bridge drives. */
export interface DshAgent {
  readonly session: DshSession;
  readonly options?: any;
  readonly status?: string;
  followup(message: any): void;
  cancel(cause?: any, options?: any): void;
  whenIdle?(): Promise<void>;
}

export interface DshAgentHandle {
  readonly agent: DshAgent;
  dispose(): Promise<void>;
}

/** Loose context access; every service is read defensively with `ctx.get`. */
export interface DshContext {
  [key: string]: any;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Canonical directory comparison: real paths when both resolve, otherwise a
 * resolved-string comparison. Reimplemented here because the harness keeps its
 * own helper private.
 */
export function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolvePath(a) === resolvePath(b);
  }
}

export function isAbsolutePath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value);
}

export function newId(): string {
  return randomUUID();
}

/** Deep JSON-safe clone; non-serializable values degrade to a string form. */
export function jsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return String(value) as unknown as T;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Read an optional service from a Cordis-like context. */
export function service<T = any>(ctx: DshContext, name: string): T | undefined {
  try {
    const fromGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    if (fromGet !== undefined) return fromGet as T;
  } catch {
    /* fall through to property access */
  }
  const direct = ctx[name];
  return direct === undefined ? undefined : (direct as T);
}
