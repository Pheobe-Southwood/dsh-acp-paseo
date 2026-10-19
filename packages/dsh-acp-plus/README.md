# @ds-hu/dsh-acp-plus

A lossless ACP v1 agent bridge for the DeepSeek Harness, shipped as a DSH bundle.

It claims stdio, serves the ACP v1 methods a client expects, and emits two channels at once: a standard projection that any ACP client can render, and DSH-native detail carried in `_meta.dsh` plus the `_dsh/*` extension methods. The bundle disables the stock `acp` row and replaces it with this bridge.

## Install

The profile must stack the base, the ACP application and this bundle:

```json
{
  "name": "dsh-profile-acp-plus",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-acp-app",
        "@ds-hu/dsh-acp-plus"
      ],
      "patchReload": "startup"
    }
  }
}
```

```bash
dsh plugin --profile acp-plus add @ds-hu/dsh-acp-plus
dsh --profile acp-plus
```

`@deepseek-ai/dsh-acp-app` must stay in the list: it inserts the stock `acp` row that this bundle's patch disables, and it provides the `acpAppStartup` gate that the `acp-plus` plugin injects. The package is published to npm as `@ds-hu/dsh-acp-plus`. `patchReload: "startup"` is appropriate because the bridge claims stdio once per process.

## Config

Set these on the `acp-plus` row.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | string, optional | none | Default DSH provider route for new ACP sessions. |
| `model` | string, optional | none | Default model id for new ACP sessions. |
| `sessionListPageSize` | natural | `100` | Maximum sessions returned per `session/list` page. |
| `questionTimeoutMs` | natural | `660000` | How long an interactive question waits for a client answer (backstop). |
| `replayLimit` | natural | `0` | Maximum events replayed by `session/load`; `0` replays all. |

The bundled patch inserts:

```yaml
- id: acp
  disabled: true

- insert:
    - id: acp-plus
      name: '@ds-hu/dsh-acp-plus'
      inject: [acpAppStartup]
      config:
        provider: deepseek-official
        model: deepseek-v4-flash

    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
      config:
        mode: timed
        timeout: 600
```

`dsh-base` mounts the `user-questions` service; the model-facing tool is opt-in, so the patch inserts it. `mode: timed` lets the harness own the timeout (seconds) while `questionTimeoutMs` stays a slightly longer backstop for a vanished client.

## ACP surface

| Method | Behaviour |
| --- | --- |
| `initialize` | `protocolVersion: 1`; `loadSession: true`; `promptCapabilities.image` when the deployment supports image prompts (`audio` and `embeddedContext` are false); `sessionCapabilities: {list, resume, close, fork}`; advertises features in the response `_meta.dsh`. |
| `authenticate` | No-op; returns `{}`. |
| `session/new` | Creates a DSH agent; a non-empty `additionalDirectories` is rejected with `-32602`. Returns `configOptions` and `_meta.dsh`. |
| `session/load` | Replays persisted history as `session/update` in seq order (capped by `replayLimit`), then resumes the agent. |
| `session/resume` | Resumes a persisted session without replay. |
| `session/list` | Paged session summaries; each item carries `_meta.dsh`. |
| `session/close` | Cancels pending waiters and closes the agent. |
| `session/set_config_option` | Applies `model`, `reasoning_effort`, `approval_policy`, `sandbox_mode` or `plan_mode`; returns the updated option set. |
| `session/prompt` | Streams updates for the turn and returns a `stopReason` plus `_meta.dsh`. |
| `session/cancel` (notification) | Cancels the in-flight turn. |
| `session/fork` (unstable) | Forks a session with `buildForkSeed` and `agents.create`; the same handler is exposed as `_dsh/session/fork`. |

Not implemented, so they answer with the ACP unknown-method error `-32601`: `logout`, `session/set_mode`, `session/delete`. The client's `fs/*` and `terminal/*` methods are never called; tool execution stays inside DSH's own filesystem and sandbox. Monetary cost is not reported — `_meta.dsh.features.cost` is `false`.

## `_meta` and extensions

Every payload that allows `_meta` carries an envelope:

```json
{ "_meta": { "dsh": { "v": 1, "kind": "update.tool_call", "native": { } } } }
```

`v` is the envelope version, `kind` is a stable tag (`update.*`, `initialize`, `session-new`, `session-load`, `session-resume`, `session-list`, `session-list-item`, `session-close`, `session-config`, `prompt-result`, `session-fork`, `permission-request`), and `native` is the originating DSH object.

| Extension | Kind | Direction | Payload |
| --- | --- | --- | --- |
| `_dsh/event` | notification | agent → client | `{v, sessionId, event}` — one durable DSH event, in seq order. |
| `_dsh/frame` | notification | agent → client | `{v, sessionId, frame}` — one transient assistant-stream frame. |
| `_dsh/user_questions` | request | agent → client | `{v, requestId, sessionId, timeoutMs, questions[]}` → `{answers: [{id, selected[], custom?}]}`. |
| `_dsh/session/fork` | request | client → agent | Same params and result as `session/fork`; the result `_meta.dsh` carries lineage. |

Permissions are one-shot: the bridge offers `allow_once` versus a reject/cancel outcome, and keeps no session-scoped grants. When a client cannot answer `_dsh/user_questions` (unsupported method, cancellation or timeout), the `ask_user_question` tool fails with a clear error rather than hanging.

## Tests

```bash
pnpm --filter @ds-hu/dsh-acp-plus test        # unit tests under test/, integration excluded
pnpm --filter @ds-hu/dsh-acp-plus typecheck
pnpm test:unit                         # all workspace unit projects
pnpm test:integration                  # builds the package, then runs test/integration/
DSH_ACP_LIVE=1 pnpm --filter @ds-hu/dsh-acp-plus test:live   # real model turn + fork (opt-in)
pnpm test                              # root vitest projects
```

The integration project needs the bundle built (`pnpm --filter @ds-hu/dsh-acp-plus build`) because it boots a profile from `dist/`. It creates a throwaway `DSH_HOME`, symlinks this package into `profiles/acp-plus/node_modules/`, and drives `dsh --profile acp-plus` over stdio. The live project copies the operator's credentials into a throwaway home, so the real one is never mutated.
