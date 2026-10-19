# dsh-acp-paseo context

Domain model for the two packages in this repository: `dsh-acp-plus`, an ACP v1 agent bridge inside the DeepSeek Harness, and `paseo-provider`, a Paseo plugin that drives it over ACP.

## Bridge and projection

**Lossless bridge**:
The DSH-side ACP v1 agent (`dsh-acp-plus`) that emits a standard projection for every durable session event and mirrors the native event alongside it, so a client that understands only standard ACP loses nothing it can later re-derive.
_Used by_: `dsh-acp-plus` produces both channels; `paseo-provider` renders the standard channel and stores the native one.
_Avoid_: proxy, adapter

**Standard projection**:
The subset of ACP v1 updates that any client can render without DSH knowledge (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `session_info_update`, `config_option_update`, `compaction_update`, `available_commands_update`).
_Used by_: `dsh-acp-plus` emits it; `paseo-provider` maps it to `ProviderEvent`s and timeline items.

**Native semantic**:
DSH meaning that has no standard ACP field, such as turn/step coordinates, DSH tool-call ids, the approval policy, or an event type with no ACP equivalent.
_Used by_: `dsh-acp-plus` carries it in `_meta.dsh.native` and in `_dsh/event`; `paseo-provider` stores it verbatim and does not render it.

**Session bridge**:
The DSH-side in-memory association between one ACP `sessionId` and one DSH agent, its config-option state, its pending permission and question waiters, and its cancellation state.
_Used by_: only `dsh-acp-plus` has a session bridge; `paseo-provider` keeps a separate provider-side session map keyed by Paseo's session id.

## Meta and extensions

**`_meta.dsh` envelope**:
The versioned object `{v, kind, native}` attached to a standard ACP payload: `v` is `META_VERSION` (currently `1`), `kind` is a stable tag such as `update.tool_call`, `session-new` or `prompt-result`, and `native` is the originating DSH object.
_Used by_: `dsh-acp-plus` builds it with `dshMeta()` / `updateMeta()`; `paseo-provider` never interprets it, only stores it.

**`_dsh/event`**:
Extension notification mirroring one durable DSH session event verbatim, in seq order, with params `{v, sessionId, event}`.
_Used by_: `dsh-acp-plus` emits one per durable event; `paseo-provider` appends each payload to the sidecar meta log.

**`_dsh/frame`**:
Extension notification carrying one transient assistant-stream frame, with params `{v, sessionId, frame}`; it exists for clients that want frame-level fidelity next to the projected chunk.
_Used by_: `dsh-acp-plus` emits it while a turn streams; `paseo-provider` stores it and does not render it in v1.

**`_dsh/user_questions`**:
Extension request from the agent to the client carrying interactive questions (`{v, requestId, sessionId, timeoutMs, questions[]}`) and expecting `{answers: [{id, selected[], custom?}]}`.
_Used by_: `dsh-acp-plus` sends it when DSH's `user-questions/request` waterfall fires; `paseo-provider` turns it into a native question card.

**`_dsh/session/fork`**:
Extension request that forks a session at an optional boundary and returns the new session id plus lineage; `dsh-acp-plus` registers the same handler as the unstable `session/fork`.
_Used by_: `dsh-acp-plus` implements it with `buildForkSeed`; `paseo-provider` does not call it in v1, because Paseo forks by replaying the transcript app-side.

**Negotiated capabilities**:
The intersection of what a peer advertises and what the other side supports: client `initialize` capabilities against `dsh-acp-plus`, and Paseo's capability list against `negotiateProviderCapabilities()` in `paseo-provider`.
_Used by_: `dsh-acp-plus` advertises its features in the `initialize` response `_meta.dsh`; `paseo-provider` advertises `prompt.message`, `prompt.command`, `permission`, `permission.tool_policy`, `session.configure`, `session.list`, `session.persistence`, plus `prompt.image` when the probe says the agent accepts images.

## Sessions and history

**Session record**:
`dsh-acp-plus`'s per-session state object (ACP id, cwd, DSH agent handle, config-option state, client capabilities, pending waiters, and the `loading | ready | prompting | closed` state); `paseo-provider` has its own `SessionState` (native session id, persistence, meta store, timeline/message/tool maps, pending permissions and questions).
_Used by_: both packages keep one; neither shares it with the other.

**Replay**:
The `session/load` path that emits historical events as `session/update` in seq order before resuming the DSH agent; the `replayLimit` config caps how many events are replayed (`0` replays all).
_Used by_: `dsh-acp-plus` performs replay after `sessionQuery.readSession`; `paseo-provider` requests `session/load` when its persistence handle contains a `nativeSessionId`.

**Fork seed**:
The inclusive prefix of a session log plus the closers produced by `buildForkSeed()`, which becomes the `seed` of `agents.create()`.
_Used by_: `dsh-acp-plus` builds one for `session/fork`; `paseo-provider` never builds one.

**Inherited event count**:
The number of events a seeded session inherits from its source (`inheritedEventCount`, `boundary + 1` for a fork), telling DSH where the inherited prefix ends.
_Used by_: `dsh-acp-plus` sets it when creating a fork; `paseo-provider` only sees it inside `_meta.dsh` lineage.

## Permissions and questions

**One-shot permission**:
An approval decision that applies to one tool call only: `dsh-acp-plus` offers `allow_once` versus `reject_once`/`cancelled`, with no session-scoped "always allow" memory.
_Used by_: `dsh-acp-plus` asks over `session/request_permission`; `paseo-provider` maps Paseo's permission actions to the same single decision.

**Question fallback**:
The behaviour when a client cannot answer `_dsh/user_questions` because the method is unsupported, the request is cancelled, or it times out: the `ask_user_question` tool fails with a clear error instead of hanging.
_Used by_: `dsh-acp-plus` throws `the connected client does not support interactive questions` or `interactive questions are unavailable: …`; `paseo-provider` resolves a dismissed or timed-out card as deny, which surfaces as the same failure.

## Configuration

**Config option ids**:
The stable ids used by ACP `session/set_config_option` and `configOptions`: `model` (encoded `provider/model`), `reasoning_effort`, `approval_policy`, `sandbox_mode`, and `plan_mode`.
_Used by_: `dsh-acp-plus` backs them with `llm` model selection, `dsh-user-approval`, `dsh-sandbox-policy` and `ctx.planMode.set`; `paseo-provider` maps them onto Paseo's config state with `configStateFromAcp()`.

## Paseo side

**Paseo provider**:
The Paseo plugin-side registration with id `deepseek-harness` and label `DeepSeek Harness` that Paseo uses to launch and talk to `dsh --profile acp-plus`.
_Used by_: `paseo-provider` registers it through `server.registerProvider()`; `dsh-acp-plus` is the process it launches.

**Provider connection**:
The object returned by `connect(request)` in the Paseo provider contract (`version`, `capabilities`, `send(input)`, `onEvent`, `close`).
_Used by_: `paseo-provider` implements it over its own ACP client; `dsh-acp-plus` sits on the other end of the stdio pipe.

**Timeline item**:
One entry of Paseo's closed provider timeline vocabulary (`user_message`, `assistant_message`, `reasoning`, `tool_call`, `todo`, `error`, `notification`, `compaction`, `plugin`).
_Used by_: `paseo-provider` emits them from projected ACP updates; `dsh-acp-plus` produces those updates.

**Persistence handle**:
Paseo's opaque `{version, data}` blob that a provider returns and receives again on restore.
_Used by_: `paseo-provider` stores `nativeSessionId`, `dshCwd` and the meta-log pointer in it; `dsh-acp-plus` is addressed by that `nativeSessionId` on `session/load`/`session/resume`.

**Sidecar meta log**:
The per-session JSONL file where `paseo-provider` appends every `_meta.dsh`, `_dsh/event` and `_dsh/frame` payload verbatim; the path is `<paseoHome>/plugin-data/deepseek-harness/sessions/<sessionId>.meta.jsonl`, records look like `{v, seq, ts, src, payload}`, writes are best-effort, and the file is truncated past 64 MiB.
_Used by_: `paseo-provider` owns the file; `dsh-acp-plus` produces the payloads it stores.

**Catalog vs sessions probe**:
Two Paseo inputs with different jobs: `catalog` asks for models, modes and thinking options (answered by spawning a throwaway agent session and reading its `configOptions`), while `sessions` asks for restorable sessions (answered with ACP `session/list`).
_Used by_: `paseo-provider` translates both into ACP calls; `dsh-acp-plus` serves `session/new` for the catalog probe and `session/list` for the sessions probe.

**Store-don't-render**:
The Paseo-side rule that `_meta` and `_dsh/*` payloads are persisted but never shown in v1; only vocabulary-confirmed timeline items reach the UI.
_Used by_: `paseo-provider` enforces it in its update handler and meta store; `dsh-acp-plus` has no opinion about it.
