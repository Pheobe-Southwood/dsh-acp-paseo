/**
 * Tool-call projection: DSH `tool/call` / `tool/result` events become ACP
 * `tool_call` / `tool_call_update` updates. Kind and locations are inferred
 * from the tool name and arguments because DSH tool definitions are not
 * exposed to the bridge.
 * @module dsh-acp-plus/tool-projection
 */
import { updateMeta } from './meta.js';
import { jsonSafe } from './dsh-types.js';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

const KIND_RULES: ReadonlyArray<readonly [RegExp, ToolKind]> = [
  [/web|fetch|http|url/i, 'fetch'],
  [/bash|shell|pwsh|powershell|terminal|exec|command|job/i, 'execute'],
  [/glob|grep|search|find|list_files/i, 'search'],
  [/delete|remove|rm_|unlink/i, 'delete'],
  [/move|rename/i, 'move'],
  [/todo|plan|think|reason/i, 'think'],
  [/edit|replace|patch|write|create|apply|insert/i, 'edit'],
  [/read|cat|view|open|head|tail|stat/i, 'read'],
  [/subagent|task|agent/i, 'other'],
];

/** Infer an ACP {@link ToolKind} from a DSH tool name. */
export function inferToolKind(name: string): ToolKind {
  const value = typeof name === 'string' ? name : '';
  for (const [pattern, kind] of KIND_RULES) {
    if (pattern.test(value)) return kind;
  }
  return 'other';
}

const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'file',
  'target_file',
  'targetFile',
  'absolute_path',
  'absolutePath',
  'notebook_path',
  'filename',
  'cwd',
];

export function parseArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function collectPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEYS.includes(key) && typeof entry === 'string' && entry.length > 0) {
      out.add(entry);
      continue;
    }
    collectPaths(entry, out, depth + 1);
  }
}

/** Best-effort tool locations from parsed arguments. */
export function locationsFromInput(input: unknown): Array<{ path: string }> {
  const out = new Set<string>();
  collectPaths(input, out);
  return [...out].slice(0, 8).map((path) => ({ path }));
}

/** Extract a contextual diff from a DSH tool-result `meta` payload. */
export function diffFromMeta(meta: unknown): { path: string; oldText: string | null; newText: string } | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const candidates: unknown[] = [meta];
  const record = meta as Record<string, unknown>;
  for (const key of ['diff', 'change', 'changes', 'patch', 'result']) {
    if (record[key] !== undefined) candidates.push(record[key]);
  }
  if (Array.isArray(record.changes)) candidates.push(...record.changes);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Record<string, unknown>;
    const path = value.path ?? value.filePath ?? value.file_path ?? value.file;
    const newText = value.newText ?? value.after ?? value.new_string ?? value.newString;
    if (typeof path === 'string' && typeof newText === 'string') {
      const oldText = value.oldText ?? value.before ?? value.old_string ?? value.oldString;
      return { path, oldText: typeof oldText === 'string' ? oldText : null, newText };
    }
  }
  return undefined;
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') parts.push(value.text);
    else if (value.type === 'reasoning' && typeof value.text === 'string') parts.push(value.text);
    else if (value.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

/** Project one durable `tool/call` event. */
export function toolCallUpdateFromCall(event: any): Record<string, unknown> {
  const data = event?.data ?? {};
  const input = parseArguments(data.arguments);
  const locations = locationsFromInput(input);
  return {
    sessionUpdate: 'tool_call',
    toolCallId: String(data.callId ?? `call-${event?.seq ?? 0}`),
    title: String(data.name ?? 'tool'),
    name: String(data.name ?? 'tool'),
    kind: inferToolKind(String(data.name ?? '')),
    status: 'in_progress',
    rawInput: input === undefined ? null : jsonSafe(input),
    ...(locations.length > 0 ? { locations } : {}),
    _meta: updateMeta('tool_call', event, {
      turn: data.turn,
      step: data.step,
      toolName: data.name,
      callId: data.callId,
    }),
  };
}

/** Project one durable `tool/result` event. */
export function toolCallUpdateFromResult(event: any): Record<string, unknown> {
  const data = event?.data ?? {};
  const message = data.message ?? {};
  const isError = message.isError === true;
  const text = textOfBlocks(message.content);
  const diff = diffFromMeta(data.meta);
  const content: Record<string, unknown>[] = [];
  if (text.length > 0) content.push({ type: 'content', content: { type: 'text', text } });
  if (diff) {
    content.push({ type: 'diff', path: diff.path, oldText: diff.oldText, newText: diff.newText });
  }
  const locations = diff ? [{ path: diff.path }] : [];
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: String(message.toolCallId ?? data.callId ?? ''),
    status: isError ? 'failed' : 'completed',
    ...(content.length > 0 ? { content } : {}),
    rawOutput: jsonSafe(message.content ?? null),
    ...(locations.length > 0 ? { locations } : {}),
    _meta: updateMeta('tool_call_update', event, {
      turn: data.turn,
      step: data.step,
      isError,
      error: data.error,
      meta: data.meta,
    }),
  };
}
