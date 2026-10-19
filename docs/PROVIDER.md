# Paseo provider technical reference

The `@ds-hu/dsh-acp-paseo` package is an out-of-tree Paseo plugin that registers the provider `deepseek-harness` and drives the DeepSeek Harness over ACP.

It is a direct `ProviderRegistration`, not the `runAcpProvider` shim, because the plugin needs native question cards, a durable `_meta` sidecar, and faithful ACP config-option mapping.

## Install

The plugin manifest is `paseo-plugin.json` (`id: "deepseek-harness-provider"`, `requirements.paseo: ">=0.12.0-beta.3"`), and the server entry is `index.server.ts`:

```ts
export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDeepseekHarnessProvider());
  return () => {};
}
```

Paseo compiles plugin modules from `client/`, `server/` or `shared/`. The
provider implementation lives in `server/`, and `index.server.ts` imports
`./server/provider.js`. A module directly under the plugin root fails the
compiler before the plugin can load.

```bash
paseo plugin install npm:@ds-hu/dsh-acp-paseo
```

For local development, point the same command at the package directory instead:

```bash
paseo plugin install /absolute/path/to/dsh-acp-paseo/packages/paseo-provider
```

Then enable the provider in the Paseo config:

```json
{
  "agents": {
    "providers": {
      "deepseek-harness": { "command": ["dsh", "--profile", "acp-plus"] }
    }
  }
}
```

`requiresConfiguration` is `true`, and the default command is `['dsh', '--profile', 'acp-plus']` (`DEFAULT_COMMAND`), so the `command` entry can be omitted when that default is what you want.

## Advertised capabilities

Always offered: `prompt.message`, `prompt.command`, `permission`, `permission.tool_policy`, `session.configure`, `session.list`, `session.persistence`. `prompt.image` is added when a cached capability probe reports that the agent accepts image prompts. The final set is the intersection with what Paseo offers, computed by `negotiateProviderCapabilities()`.

`permission.tool_policy` is required rather than optional: Paseo's `requiredProviderCapabilities()` adds it for `session.open` whenever the session config carries a `toolPolicy`, and `requireProviderCapabilities()` throws if the provider did not advertise it. Since this provider accepts `toolPolicy`, it must advertise the capability.

The probe spawns the agent once per launch command, calls `initialize`, and reads `promptCapabilities.image` and `loadSession`; results are cached per command string.

## Sidecar meta log

Every raw ACP payload that carries DSH semantics is appended verbatim to:

```
${PASEO_HOME:-~/.paseo}/plugin-data/deepseek-harness/sessions/<sessionId>.meta.jsonl
```

Each line is `{v: 1, seq, ts, src, payload}` where `src` is one of `event`, `frame`, `update`, `request`, `response` or `unknown`. Writes are best-effort and never throw, so a storage failure cannot fail a turn. The file is capped at 64 MiB (`DEFAULT_MAX_BYTES`); once the cap is reached a `{v: 1, truncated: true, ts}` marker is appended and later records are dropped. The file path and counters travel in the persistence handle as `metaLog: {schema: "dsh-meta@1", file, count, bytes, truncated?}`.

This directory is created and owned by the plugin; Paseo does not manage it.

## Timeline mapping

| ACP update | Paseo result |
| --- | --- |
| `user_message_chunk` | `user_message` timeline item (text accumulated per `messageId`). |
| `agent_message_chunk` | `assistant_message` timeline item. |
| `agent_thought_chunk` | `reasoning` timeline item. |
| `tool_call` / `tool_call_update` | `tool_call` timeline item, updated in place. |
| `plan` | `todo` timeline item. |
| `available_commands_update` | `session.commands` event. |
| `config_option_update` | `session.config` event. |
| `usage_update` | `session.usage` event. |
| `compaction_update` | `compaction` timeline item. |
| anything else | Stored in the sidecar and skipped; never rendered and never breaks the session. |

`_meta.dsh`, `_dsh/event` and `_dsh/frame` payloads are stored and not rendered in v1 (see `docs/adr/0004-store-dont-render.md`).

## Question cards

A `_dsh/user_questions` request becomes a `session.permission` request with `kind: "question"` and Paseo's native question form:

```json
{
  "questions": [
    {
      "question": "…",
      "header": "…",
      "options": [{ "label": "…", "description": "…" }],
      "multiSelect": false,
      "allowOther": true,
      "allowEmpty": false,
      "placeholder": "…"
    }
  ]
}
```

The actions are `answer` (allow, primary) and `dismiss` (deny, secondary). Paseo returns `updatedInput.answers` as a `Record<header, string>` with selected option labels joined by `", "`; the provider maps that back to DSH's `{id, selected[], custom?}` shape, treating unmatched trailing text as `custom`. A dismissed card, a cancelled request or a timeout resolves as deny, and the bridge reports a question failure to the model instead of hanging.

Tool permissions use the same `session.permission` channel with `kind: "tool"`; an allow response selects the requested option id, and a deny response is reported as `cancelled`.

## Persistence handle

The provider stores `nativeSessionId`, `dshCwd` and the meta-log pointer in `{version: 1, data: {…}}` and emits it as `session.persistence`. On restore, `session.open` carries the handle back; the provider calls ACP `session/load` (or `session/resume` when no replay is wanted) with that native session id.

## Tests

```bash
pnpm --filter @ds-hu/dsh-acp-paseo test      # vitest, includes test/**/*.test.ts
pnpm --filter @ds-hu/dsh-acp-paseo typecheck
```

`test/fake-agent.ts` provides a scripted ACP peer so the provider can be exercised without a real harness process; emitted provider events are validated against the published `ProviderEventSchema`.
