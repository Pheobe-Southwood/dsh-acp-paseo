# The DSH-side ACP bridge is written from scratch

**Status**: Accepted

## Context

The project needs an ACP v1 agent that runs inside the DeepSeek Harness and expresses DSH semantics without loss. Three existing sources could have been reused: the published `@deepseek-ai/dsh-acp` package, this repository's own archive branch, and the reference checkout at `ref/dsh-paseo`. All three are incomplete for the goal: the published bridge has no interactive-question channel and no fork, and the other two are abandoned attempts.

## Decision

`packages/dsh-acp-plus` is written from scratch in this repository. We deliberately do not read, copy or adapt `@deepseek-ai/dsh-acp`, this repository's archive branch, or `ref/dsh-paseo`. The only compatibility baseline is the ACP v1 specification plus DSH's public APIs.

## Consequences

- Full control over the `_meta.dsh` envelope, `_dsh/*` extensions, the question channel and fork.
- We own and maintain the pieces that would otherwise come from the published bridge: the ACP-to-DSH content projector, MCP server validation/normalization, and directory comparison.
- Upstream fixes in `@deepseek-ai/dsh-acp` do not reach us; we track DSH releases ourselves.
- The bundle still depends on `@deepseek-ai/dsh-acp-app` for the `acpAppStartup` gate and the stock row that the patch disables.

## Alternatives considered

- **Fork or adapt `@deepseek-ai/dsh-acp`.** Rejected: it carries a stock surface (no `_dsh/user_questions`, no fork) and its structure would have to be rewritten for lossless `_meta` anyway.
- **Revive the archive branch or `ref/dsh-paseo`.** Rejected: both are abandoned and incomplete, and the user explicitly ruled them out as references.
