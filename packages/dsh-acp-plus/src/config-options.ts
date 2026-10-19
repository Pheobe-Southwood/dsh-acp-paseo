/**
 * ACP session configuration options backed by DSH-native controls:
 * model, reasoning effort, approval policy, sandbox mode, and plan mode.
 * @module dsh-acp-plus/config-options
 */
import { APPROVAL_POLICIES, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { ContentError } from './content.js';
import { service, type DshContext } from './dsh-types.js';

export const OPTION_MODEL = 'model';
export const OPTION_REASONING = 'reasoning_effort';
export const OPTION_APPROVAL = 'approval_policy';
export const OPTION_SANDBOX = 'sandbox_mode';
export const OPTION_PLAN = 'plan_mode';

export interface ModelSelectionState {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface ConfigOptionRecord {
  agent: any;
  selectionRef: { current: ModelSelectionState | undefined; assembled: ModelSelectionState | undefined };
  approvalPolicy?: string;
  sandboxMode?: string;
  cwd: string;
}

export function encodeModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function decodeModel(value: string): { provider: string; model: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const index = value.indexOf('/');
  if (index <= 0 || index === value.length - 1) return undefined;
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

function currentSelection(record: ConfigOptionRecord): ModelSelectionState {
  const selected = record.selectionRef.current;
  if (selected?.provider && selected.model) return selected;
  const options = record.agent?.options ?? {};
  return { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort };
}

async function modelOptions(ctx: DshContext): Promise<Array<{ value: string; name: string; description?: string }>> {
  const llm = service<any>(ctx, 'llm');
  if (!llm?.listProviders || !llm?.listModels) return [];
  const out: Array<{ value: string; name: string; description?: string }> = [];
  for (const provider of llm.listProviders() ?? []) {
    const providerId = String(provider?.id ?? provider?.provider ?? '');
    if (!providerId) continue;
    let models: any[] = [];
    try {
      models = (await llm.listModels(providerId)) ?? [];
    } catch {
      continue;
    }
    for (const model of models) {
      const modelId = String(model?.id ?? '');
      if (!modelId) continue;
      out.push({
        value: encodeModel(providerId, modelId),
        name: `${provider?.name ?? providerId} · ${model?.name ?? modelId}`,
        ...(model?.description ? { description: String(model.description) } : {}),
      });
    }
  }
  return out;
}

async function reasoningOptions(
  ctx: DshContext,
  selection: ModelSelectionState,
): Promise<{ options: Array<{ value: string; name: string; description?: string }>; current: string }> {
  const llm = service<any>(ctx, 'llm');
  const empty = { options: [] as Array<{ value: string; name: string }>, current: selection.reasoningEffort ?? '' };
  if (!llm?.resolveModelInfo || !selection.provider || !selection.model) return empty;
  try {
    const info = await llm.resolveModelInfo(selection.provider, selection.model);
    const reasoning = info?.reasoning;
    if (!reasoning?.efforts?.length) return empty;
    return {
      options: reasoning.efforts.map((effort: any) => ({
        value: String(effort.id),
        name: String(effort.name ?? effort.id),
        ...(effort.description ? { description: String(effort.description) } : {}),
      })),
      current: selection.reasoningEffort ?? String(reasoning.defaultEffort ?? ''),
    };
  } catch {
    return empty;
  }
}

/** Build the complete ACP config option list for one session. */
export async function buildConfigOptions(ctx: DshContext, record: ConfigOptionRecord): Promise<any[]> {
  const selection = currentSelection(record);
  const models = await modelOptions(ctx);
  const reasoning = await reasoningOptions(ctx, selection);
  const approval = record.approvalPolicy ?? 'ask';
  const sandbox = record.sandboxMode ?? service<any>(ctx, 'sandboxPolicy')?.defaultMode ?? 'workspace-write';
  const planMode = service<any>(ctx, 'planMode');
  let planActive = false;
  try {
    planActive = planMode?.get?.(record.agent)?.active === true;
  } catch {
    planActive = false;
  }

  const options: any[] = [];
  if (models.length > 0 && selection.provider && selection.model) {
    options.push({
      id: OPTION_MODEL,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: encodeModel(selection.provider, selection.model),
      options: models,
    });
  }
  if (reasoning.options.length > 0) {
    options.push({
      id: OPTION_REASONING,
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: reasoning.current,
      options: reasoning.options,
    });
  }
  options.push({
    id: OPTION_APPROVAL,
    name: 'Approvals',
    category: 'model_config',
    type: 'select',
    currentValue: approval,
    options: [
      { value: 'ask', name: 'Ask for approval' },
      { value: 'never', name: 'Never ask' },
    ],
  });
  options.push({
    id: OPTION_SANDBOX,
    name: 'Sandbox',
    category: 'model_config',
    type: 'select',
    currentValue: sandbox,
    options: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
      { value: 'danger-full-access', name: 'Danger full access' },
    ],
  });
  if (planMode) {
    options.push({
      id: OPTION_PLAN,
      name: 'Plan mode',
      category: 'model_config',
      type: 'select',
      currentValue: planActive ? 'on' : 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    });
  }
  return options;
}

/** Apply one ACP `session/set_config_option` request. */
export function applyConfigOption(ctx: DshContext, record: ConfigOptionRecord, configId: string, value: unknown): void {
  const selection = record.selectionRef.current ?? {};
  switch (configId) {
    case OPTION_MODEL: {
      const decoded = decodeModel(String(value));
      if (!decoded) throw new ContentError(`invalid model value: ${String(value)}`);
      record.selectionRef.current = { ...selection, provider: decoded.provider, model: decoded.model, reasoningEffort: undefined };
      return;
    }
    case OPTION_REASONING: {
      const effort = String(value ?? '');
      record.selectionRef.current = { ...selection, reasoningEffort: effort.length > 0 ? effort : undefined };
      return;
    }
    case OPTION_APPROVAL: {
      const policy = String(value);
      if (!APPROVAL_POLICIES.includes(policy as any)) throw new ContentError(`invalid approval policy: ${policy}`);
      setApprovalPolicy(record.agent.session, policy as any);
      record.approvalPolicy = policy;
      return;
    }
    case OPTION_SANDBOX: {
      const mode = String(value);
      if (!SANDBOX_MODES.includes(mode as any)) throw new ContentError(`invalid sandbox mode: ${mode}`);
      setSandboxMode(record.agent.session, mode as any);
      record.sandboxMode = mode;
      return;
    }
    case OPTION_PLAN: {
      const planMode = service<any>(ctx, 'planMode');
      if (!planMode?.set) throw new ContentError('plan mode is not available');
      const active = value === true || value === 'on' || value === 'true';
      planMode.set(record.agent, active);
      return;
    }
    default:
      throw new ContentError(`unknown config option: ${configId}`);
  }
}
