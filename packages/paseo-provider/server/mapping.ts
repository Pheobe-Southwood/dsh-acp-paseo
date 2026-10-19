/**
 * Pure mapping helpers: ACP payloads to Paseo provider events/items.
 * Nothing here reads `_meta` for rendering — `_meta` is stored, not shown.
 * @module paseo-provider/mapping
 */
import type {
  ProviderConfigState,
  ProviderPermissionRequest,
  ProviderSetting,
  ProviderToolCallDetail,
  ProviderTimelineItem,
  ProviderUsage,
} from '@getpaseo/plugin/server/provider';
import type { DshQuestion, DshQuestionAnswer } from './types.js';

export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, any>;
    if (value.type === 'content' && value.content) {
      parts.push(textOf([value.content]));
      continue;
    }
    if (value.type === 'text' && typeof value.text === 'string') parts.push(value.text);
    else if (value.type === 'image') parts.push('[image]');
    else if (value.type === 'diff' && typeof value.path === 'string') {
      parts.push(`--- ${value.path}\n${value.oldText ?? ''}\n+++ ${value.newText ?? ''}`);
    }
  }
  return parts.join('\n');
}

function contentBlocks(content: unknown): any[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: any) => {
    if (block && typeof block === 'object' && block.type === 'content' && block.content) return [block.content];
    return block ? [block] : [];
  });
}

function diffEntry(content: unknown): { path: string; oldText: string | null; newText: string } | undefined {
  for (const value of contentBlocks(content)) {
    if (value.type === 'diff' && typeof value.path === 'string') {
      return {
        path: value.path,
        oldText: typeof value.oldText === 'string' ? value.oldText : null,
        newText: typeof value.newText === 'string' ? value.newText : '',
      };
    }
  }
  return undefined;
}

function firstLocation(update: any): string | undefined {
  const locations = Array.isArray(update?.locations) ? update.locations : [];
  const first = locations[0];
  return first && typeof first.path === 'string' ? first.path : undefined;
}

function argString(input: any, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Map an ACP tool call/update into one of Paseo's eleven detail variants. */
export function toolDetailFromUpdate(update: any): ProviderToolCallDetail {
  const kind = String(update?.kind ?? 'other');
  const title = String(update?.title ?? update?.name ?? 'tool');
  const text = textOf(update?.content);
  const diff = diffEntry(update?.content);
  const input = update?.rawInput;
  const path = firstLocation(update) ?? argString(input, ['file_path', 'filePath', 'path', 'file']);
  const status = String(update?.status ?? 'in_progress');

  switch (kind) {
    case 'execute':
      return {
        type: 'shell',
        command: argString(input, ['command', 'cmd', 'script']) ?? title,
        ...(argString(input, ['cwd', 'workdir']) ? { cwd: argString(input, ['cwd', 'workdir']) } : {}),
        ...(text ? { output: text } : {}),
        ...(status === 'completed' ? { exitCode: 0 } : status === 'failed' ? { exitCode: null } : {}),
      };
    case 'read':
      return {
        type: 'read',
        filePath: path ?? title,
        ...(text ? { content: text } : {}),
      };
    case 'edit':
      return {
        type: 'edit',
        filePath: diff?.path ?? path ?? title,
        ...(diff?.oldText ? { oldString: diff.oldText } : {}),
        ...(diff?.newText ? { newString: diff.newText } : {}),
        ...(diff ? { unifiedDiff: text } : {}),
      };
    case 'search':
      return {
        type: 'search',
        query: argString(input, ['query', 'pattern', 'q']) ?? title,
        toolName: 'search',
        ...(text ? { content: text } : {}),
      };
    case 'fetch':
      return {
        type: 'fetch',
        url: argString(input, ['url', 'uri']) ?? title,
        ...(text ? { result: text } : {}),
      };
    case 'think':
      return { type: 'plan', text: text || title };
    default:
      if (text) return { type: 'plain_text', label: title, text, icon: 'wrench' };
      return { type: 'unknown', input: (input ?? null) as any, output: (text || null) as any };
  }
}

/** Build the timeline item for a new ACP `tool_call`. */
export function toolCallItem(update: any): ProviderTimelineItem {
  const callId = String(update?.toolCallId ?? '');
  const status = String(update?.status ?? 'in_progress');
  return {
    id: `tool:${callId}`,
    type: 'tool_call',
    callId,
    name: String(update?.title ?? update?.name ?? 'tool'),
    detail: toolDetailFromUpdate(update),
    metadata: update?._meta ? { dsh: update._meta } : undefined,
    status: status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'canceled' : 'running',
    error: status === 'failed' ? (update?.rawOutput ?? 'tool call failed') : null,
  } as ProviderTimelineItem;
}

/** Update an existing tool_call item from an ACP `tool_call_update`. */
export function toolCallItemUpdated(previous: any, update: any, previousRaw?: any): ProviderTimelineItem {
  const callId = String(update?.toolCallId ?? previous?.callId ?? '');
  const status = String(update?.status ?? previousRaw?.status ?? previous?.status ?? 'in_progress');
  const merged = { ...(previousRaw ?? {}), ...update };
  const detail = update?.content || update?.rawInput !== undefined || update?.kind
    ? toolDetailFromUpdate(merged)
    : previous?.detail;
  return {
    ...previous,
    id: previous?.id ?? `tool:${callId}`,
    type: 'tool_call',
    callId,
    name: String(update?.title ?? previousRaw?.title ?? previous?.name ?? 'tool'),
    detail,
    ...(update?._meta ? { metadata: { dsh: update._meta } } : {}),
    status: status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'canceled' : 'running',
    error: status === 'failed' ? (update?.rawOutput ?? previous?.error ?? 'tool call failed') : null,
  } as ProviderTimelineItem;
}

/** ACP `plan` update to a Paseo todo item. */
export function todoItem(update: any): ProviderTimelineItem {
  const entries = Array.isArray(update?.entries) ? update.entries : [];
  return {
    id: 'plan',
    type: 'todo',
    items: entries.map((entry: any) => ({
      text: String(entry?.content ?? ''),
      completed: entry?.status === 'completed',
      status: entry?.status === 'completed' ? 'completed' : entry?.status === 'in_progress' ? 'in_progress' : 'pending',
    })),
  };
}

/** ACP session mode state to Paseo provider modes plus the current mode id. */
export function modesFromAcp(modes: any): { modes: ProviderConfigState['modes']; mode?: string } {
  const available = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  const mapped = available
    .map((mode: any) => ({
      id: String(mode?.id ?? ''),
      label: String(mode?.name ?? mode?.id ?? ''),
      ...(typeof mode?.description === 'string' && mode.description.length > 0 ? { description: mode.description } : {}),
    }))
    .filter((mode: { id: string }) => mode.id.length > 0);
  const current = typeof modes?.currentModeId === 'string' && modes.currentModeId.length > 0 ? modes.currentModeId : undefined;
  return {
    modes: mapped,
    ...(current ? { mode: current } : {}),
  };
}

/** ACP config options to Paseo provider config state. */
export function configStateFromAcp(configOptions: readonly any[], modeState?: any): ProviderConfigState {
  const models: Array<{ id: string; label: string }> = [];
  const thinkingOptions: Array<{ id: string; label: string }> = [];
  const settings: ProviderSetting[] = [];
  let model: string | undefined;
  let thinkingOption: string | undefined;
  for (const option of configOptions ?? []) {
    if (!option || option.type !== 'select') continue;
    const id = String(option.id ?? '');
    const label = String(option.name ?? id);
    const options = (Array.isArray(option.options) ? option.options : []).map((entry: any) => ({
      value: String(entry?.value ?? ''),
      label: String(entry?.name ?? entry?.value ?? ''),
    }));
    if (option.category === 'model') {
      model = String(option.currentValue ?? '');
      for (const entry of options) models.push({ id: entry.value, label: entry.label });
      continue;
    }
    if (option.category === 'thought_level') {
      thinkingOption = String(option.currentValue ?? '') || undefined;
      for (const entry of options) thinkingOptions.push({ id: entry.value, label: entry.label });
      continue;
    }
    settings.push({
      type: 'select',
      id,
      label,
      value: option.currentValue === undefined || option.currentValue === null ? null : String(option.currentValue),
      options: options.map((entry: any) => ({ label: entry.label, value: entry.value })),
    });
  }
  const { modes, mode } = modesFromAcp(modeState);
  return {
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(thinkingOption ? { thinkingOption } : {}),
    models,
    modes,
    thinkingOptions,
    settings,
  };
}

/** ACP usage update to Paseo provider usage. */
export function usageFromAcp(update: any): ProviderUsage {
  return {
    contextWindowUsedTokens: Number(update?.used ?? 0),
    contextWindowMaxTokens: Number(update?.size ?? 0),
  };
}

export function usageFromPromptResponse(response: any): ProviderUsage | undefined {
  const usage = response?.usage;
  if (!usage) return undefined;
  return {
    inputTokens: Number(usage.inputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    ...(usage.cachedReadTokens !== undefined ? { cachedInputTokens: Number(usage.cachedReadTokens) } : {}),
  };
}

let permissionSeq = 0;

/** ACP permission request to a Paseo tool permission request. */
export function permissionRequestFromAcp(params: any): ProviderPermissionRequest {
  permissionSeq += 1;
  const toolCall = params?.toolCall ?? {};
  const options = Array.isArray(params?.options) ? params.options : [];
  const actions = options.map((option: any) => ({
    id: String(option?.optionId ?? ''),
    label: String(option?.name ?? option?.optionId ?? ''),
    behavior: String(option?.kind ?? '').startsWith('allow') ? ('allow' as const) : ('deny' as const),
    variant: String(option?.kind ?? '').startsWith('allow') ? ('primary' as const) : ('danger' as const),
  }));
  return {
    id: `permission-${permissionSeq}-${String(toolCall.toolCallId ?? 'tool')}`,
    name: String(toolCall.title ?? toolCall.name ?? 'permission'),
    kind: 'tool',
    title: String(toolCall.title ?? toolCall.name ?? 'Permission required'),
    ...(params?._meta?.dsh?.reason ? { description: String(params._meta.dsh.reason) } : {}),
    ...(toolCall.rawInput && typeof toolCall.rawInput === 'object' ? { input: toolCall.rawInput } : {}),
    actions,
  };
}

/** DSH `_dsh/user_questions` params to a Paseo question permission request. */
export function questionRequestFromDsh(params: any, requestId: string): { request: ProviderPermissionRequest; questions: DshQuestion[] } {
  const questions: DshQuestion[] = (Array.isArray(params?.questions) ? params.questions : []).map((question: any, index: number) => ({
    id: String(question?.id ?? `q${index + 1}`),
    header: String(question?.header ?? `Question ${index + 1}`),
    question: String(question?.question ?? ''),
    ...(question?.detail ? { detail: String(question.detail) } : {}),
    options: (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({
      label: String(option?.label ?? ''),
      ...(option?.description ? { description: String(option.description) } : {}),
    })),
    multiSelect: question?.multiSelect === true,
  }));
  const input = {
    questions: questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options,
      multiSelect: question.multiSelect,
      allowOther: true,
      allowEmpty: false,
      ...(question.detail ? { placeholder: question.detail } : {}),
    })),
  };
  return {
    request: {
      id: requestId,
      name: 'ask_user_question',
      kind: 'question',
      title: 'Question',
      input: input as any,
      actions: [
        { id: 'answer', label: 'Answer', behavior: 'allow', variant: 'primary' },
        { id: 'dismiss', label: 'Dismiss', behavior: 'deny', variant: 'secondary' },
      ],
    },
    questions,
  };
}

/**
 * Paseo's question card answers arrive as `Record<header, string>` with option
 * labels joined by ", ". Convert them back to structured DSH answers.
 */
export function answersFromPaseo(answers: unknown, questions: readonly DshQuestion[]): DshQuestionAnswer[] {
  const record = answers && typeof answers === 'object' ? (answers as Record<string, string>) : {};
  return questions.map((question) => {
    const raw = typeof record[question.header] === 'string' ? record[question.header].trim() : '';
    if (raw.length === 0) return { id: question.id, selected: [] };
    const labels = question.options.map((option) => option.label).sort((a, b) => b.length - a.length);
    let remaining = raw;
    const selected: string[] = [];
    for (const label of labels) {
      if (remaining === label) {
        selected.push(label);
        remaining = '';
        break;
      }
      if (remaining.startsWith(`${label}, `)) {
        selected.push(label);
        remaining = remaining.slice(label.length + 2);
      }
    }
    const custom = remaining.trim().length > 0 ? remaining.trim() : undefined;
    return { id: question.id, selected, ...(custom ? { custom } : {}) };
  });
}
