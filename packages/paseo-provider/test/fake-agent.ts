/**
 * A scripted in-process ACP agent used to exercise the Paseo provider without
 * spawning a real harness process.
 * @module paseo-provider/test/fake-agent
 */
import { agent, type AgentApp } from '@agentclientprotocol/sdk';

export interface FakeAgentHooks {
  configOptions?: any[];
  loadSession?: boolean;
  supportsImage?: boolean;
  onLoad?: (context: { params: any; client: any }) => Promise<void> | void;
  onPrompt?: (context: { params: any; client: any }) => Promise<void> | void;
  onSetConfigOption?: (context: { params: any }) => any[] | undefined;
}

export function defaultConfigOptions(): any[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'deepseek-v4-flash',
      options: [
        { value: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { value: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'approval_policy',
      name: 'Approval policy',
      type: 'select',
      currentValue: 'ask',
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'never', name: 'Never' },
      ],
    },
  ];
}

export function createFakeAgent(hooks: FakeAgentHooks = {}): AgentApp {
  const app = agent({ name: 'fake-dsh' });
  let configOptions = hooks.configOptions ?? defaultConfigOptions();

  app.onRequest('initialize', async () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: hooks.loadSession !== false,
      promptCapabilities: { image: hooks.supportsImage === true, audio: false, embeddedContext: false },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
    },
    authMethods: [],
    agentInfo: { name: 'fake-dsh', version: '0.0.0-test' },
  }));

  app.onRequest('session/new', async () => ({ sessionId: 'dsh-session-1', configOptions }));

  app.onRequest('session/load', async ({ params, client }) => {
    await hooks.onLoad?.({ params, client });
    return { configOptions };
  });

  app.onRequest('session/resume', async () => ({ configOptions }));

  app.onRequest('session/list', async () => ({
    sessions: [
      { sessionId: 'dsh-session-1', cwd: '/tmp/project', title: 'Stored session', updatedAt: '2026-01-02T03:04:05.000Z' },
    ],
  }));

  app.onRequest('session/set_config_option', async ({ params }) => {
    const replacement = hooks.onSetConfigOption?.({ params });
    if (replacement) configOptions = replacement;
    else {
      configOptions = configOptions.map((option) =>
        option.id === params.configId ? { ...option, currentValue: params.value } : option,
      );
    }
    return { configOptions };
  });

  app.onRequest('session/close', async () => ({}));

  app.onRequest('session/prompt', async ({ params, client }) => {
    await hooks.onPrompt?.({ params, client });
    return { stopReason: 'end_turn' };
  });

  return app;
}
