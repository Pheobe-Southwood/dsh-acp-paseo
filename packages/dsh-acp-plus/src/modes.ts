/**
 * DSH Agent presets exposed as ACP session modes.
 *
 * DSH's preset registry is optional: a profile that does not declare
 * `agentPresets` keeps the pre-mode behavior and advertises no modes.
 * @module dsh-acp-plus/modes
 */
import { service, type DshContext } from './dsh-types.js';

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

/**
 * Display copy for the four presets shipped by the DSH Web bundle. Custom
 * presets publish their own name and description, so they are never rewritten.
 */
const BUILT_IN_COPY: Readonly<Record<string, { name: string; description: string }>> = {
  standard: {
    name: 'Standard mode',
    description:
      'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  },
  ptc: {
    name: 'PTC mode',
    description:
      'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  },
  minimal: {
    name: 'Minimal mode',
    description:
      'The agent uses a terminal and image reading, with context compaction. Useful for testing and comparing its basic performance.',
  },
  cordis: {
    name: 'Creator mode',
    description:
      'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',
  },
};

function displayMode(row: any): AcpSessionMode {
  const copy = row?.name === undefined ? BUILT_IN_COPY[String(row?.id ?? '')] : undefined;
  const description = copy?.description ?? (typeof row?.description === 'string' ? row.description : undefined);
  return {
    id: String(row?.id ?? ''),
    name: copy?.name ?? String(row?.name ?? row?.id ?? ''),
    ...(description ? { description } : {}),
  };
}

/**
 * Read the profile's preset roster and turn it into an ACP mode state.
 * Broken presets are omitted because selecting one cannot mount a composition.
 * @param ctx - Host context carrying the optional `agentPresets` service.
 * @param record - Session record whose current preset is being reported.
 * @returns Mode state, or undefined when the profile declares no usable presets.
 */
export async function buildSessionModes(
  ctx: DshContext,
  record: { agent?: any; currentModeId?: string },
): Promise<AcpSessionModeState | undefined> {
  const presets = service<any>(ctx, 'agentPresets');
  if (!presets?.list) return undefined;
  let rows: any[];
  try {
    rows = (await presets.list()) ?? [];
  } catch {
    return undefined;
  }
  const available = rows.filter((row) => row?.id && row.broken === undefined).map(displayMode);
  if (available.length === 0) return undefined;
  let current: string | undefined = record.currentModeId;
  if (!current && record.agent?.ctx && typeof presets.composedPreset === 'function') {
    try {
      current = presets.composedPreset(record.agent.ctx);
    } catch {
      current = undefined;
    }
  }
  if (!current && typeof presets.defaultId === 'string') current = presets.defaultId;
  if (!current || !available.some((mode) => mode.id === current)) current = available[0].id;
  return { currentModeId: current, availableModes: available };
}
