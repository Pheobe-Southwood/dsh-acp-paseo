/**
 * Durable `_meta` sidecar store.
 *
 * Paseo has no native transcript storage for a provider, so every raw ACP
 * payload that carries DSH semantics (`_meta.dsh`, `_dsh/event`, `_dsh/frame`)
 * is appended verbatim to a per-session JSONL file. The file path and counters
 * travel in the provider persistence handle so a restored session keeps its
 * lossless record without ever rendering it.
 * @module paseo-provider/meta-store
 */
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const META_SCHEMA = 'dsh-meta@1';
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

// A type alias (not an interface) so it stays assignable to JSON value types.
export type MetaLogPointer = {
  schema: string;
  file: string;
  count: number;
  bytes: number;
  truncated?: boolean;
};

export interface MetaRecord {
  v: 1;
  seq: number;
  ts: string;
  src: 'event' | 'frame' | 'update' | 'request' | 'response' | 'unknown';
  payload: unknown;
}

export function resolvePaseoHome(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.PASEO_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.paseo');
}

export function metaLogPath(paseoHome: string, sessionId: string): string {
  return join(paseoHome, 'plugin-data', 'deepseek-harness', 'sessions', `${sessionId}.meta.jsonl`);
}

export class MetaStore {
  private count = 0;
  private bytes = 0;
  private truncated = false;
  private ready: Promise<void>;

  constructor(
    readonly file: string,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    this.ready = (async () => {
      await mkdir(dirname(this.file), { recursive: true });
      try {
        const info = await stat(this.file);
        if (info.isFile() && info.size > 0) {
          this.bytes = info.size;
          this.count = await countLines(this.file);
        }
      } catch {
        await writeFile(this.file, '');
      }
    })();
  }

  pointer(): MetaLogPointer {
    return {
      schema: META_SCHEMA,
      file: this.file,
      count: this.count,
      bytes: this.bytes,
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  /** Append one raw payload. Never throws: storage failures must not break a turn. */
  async append(src: MetaRecord['src'], payload: unknown): Promise<void> {
    try {
      await this.ready;
      if (this.truncated || this.bytes >= this.maxBytes) {
        if (!this.truncated) {
          this.truncated = true;
          await appendFile(this.file, `${JSON.stringify({ v: 1, truncated: true, ts: new Date().toISOString() })}\n`);
        }
        return;
      }
      const record: MetaRecord = {
        v: 1,
        seq: this.count + 1,
        ts: new Date().toISOString(),
        src,
        payload: safeJson(payload),
      };
      const line = `${JSON.stringify(record)}\n`;
      await appendFile(this.file, line);
      this.count += 1;
      this.bytes += Buffer.byteLength(line, 'utf8');
    } catch {
      /* sidecar storage is best-effort */
    }
  }
}

async function countLines(file: string): Promise<number> {
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(file, 'utf8');
    if (content.length === 0) return 0;
    return content.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
