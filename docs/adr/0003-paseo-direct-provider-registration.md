# The Paseo plugin registers a direct provider

**Status**: Accepted

## Context

Paseo ships an ACP provider shim (`runAcpProvider`) that a plugin can wrap with a few lines. It cannot satisfy this project: the shim overwrites `persistence.data` with `{sessionId}` on every `session.open`, ignores `updatedInput` on permission responses, and hardcodes tool permissions as `kind: "tool"`. That makes a durable `_meta` sidecar, native question cards and faithful config mapping unreachable.

## Decision

`packages/paseo-provider` registers a direct `ProviderRegistration` with id `deepseek-harness`, label `DeepSeek Harness`, and its own ACP client built on `@agentclientprotocol/sdk@1.4.0`. The plugin owns the session lifecycle, the persistence handle, the `_meta` sidecar and the question channel.

## Consequences

- We implement and maintain the provider-side pieces ourselves: ACP client wiring, update-to-timeline mapping, permission and question plumbing, catalog/sessions probes.
- Native question cards work because the provider emits `session.permission` with `kind: "question"` directly, which the shim never does.
- The persistence handle can carry `nativeSessionId`, `dshCwd` and the meta-log pointer, so a restored session keeps its lossless record.
- We must track the Paseo provider contract ourselves as it evolves; the published `@getpaseo/*` packages are pinned at `0.12.0-beta.3`.

## Alternatives considered

- **`runAcpProvider` shim.** Rejected: overwrites persistence, ignores `updatedInput`, and only produces tool permissions.
- **A fork-only provider.** Rejected: Paseo's fork is app-side transcript replay and does not exercise the provider, so it solves none of the above.
