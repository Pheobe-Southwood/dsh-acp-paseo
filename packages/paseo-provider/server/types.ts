/**
 * Local structural types for the Paseo provider boundary and the DSH `_meta`
 * contract. Runtime validation of emitted events uses the published
 * `ProviderEventSchema` in tests; these types keep the implementation readable.
 * @module paseo-provider/types
 */
export interface ProviderLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ProviderPersistence {
  version: number;
  data: any;
}

export interface ProviderSessionConfig {
  cwd: string;
  env: Readonly<Record<string, string>>;
  systemPrompt?: string;
  mcpServers: Readonly<Record<string, any>>;
  toolPolicy?: { preapproved: Array<{ kind: 'mcp'; server: string; tool: string }> };
  model?: string;
  mode?: string;
  thinkingOption?: string;
  settings: Readonly<Record<string, any>>;
  providerOptions?: Readonly<Record<string, unknown>>;
  title?: string;
  persist: boolean;
}

export interface ProviderPrompt {
  clientMessageId: string;
  delivery: 'auto' | 'steer';
  input: { type: 'message'; content: any[] } | { type: 'command'; name: string; arguments: string };
  outputSchema?: unknown;
  clearPendingPermissions?: boolean;
}

export interface ProviderPermissionResponse {
  behavior: 'allow' | 'deny';
  selectedActionId?: string;
  updatedInput?: Record<string, any>;
  message?: string;
  interrupt?: boolean;
}

export interface DshQuestion {
  id: string;
  header: string;
  question: string;
  detail?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface DshEventEnvelope {
  v: number;
  sessionId: string;
  event: { type: string; seq: number; time: number; data: any };
}

export interface DshFrameEnvelope {
  v: number;
  sessionId: string;
  frame: any;
}

export interface DshQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface ProviderOptions {
  command: [string, ...string[]];
  env?: Record<string, string>;
  metaDir?: string;
  questionTimeoutMs: number;
}

export const DEFAULT_COMMAND: [string, ...string[]] = ['dsh', '--profile', 'acp-plus'];
