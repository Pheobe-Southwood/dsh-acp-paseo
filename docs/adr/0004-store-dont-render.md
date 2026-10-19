# Paseo stores `_meta` but does not render it

**Status**: Accepted

## Context

Paseo's provider timeline vocabulary is closed: nine item types, validated by zod. An update type outside that vocabulary throws during validation and is dropped, so there is no place to render DSH-native detail without inventing UI. At the same time the native detail is the reason the bridge exists.

## Decision

The Paseo plugin appends every `_meta.dsh`, `_dsh/event` and `_dsh/frame` payload verbatim to a per-session JSONL sidecar at `<paseoHome>/plugin-data/deepseek-harness/sessions/<sessionId>.meta.jsonl`, and renders only timeline items confirmed by Paseo's vocabulary. Unknown standard updates are stored and skipped; they never break a turn.

## Consequences

- Nothing is lost: a future renderer can replay the sidecar without touching the bridge.
- The sidecar grows with the session; it is capped at 64 MiB, after which a `{v: 1, truncated: true}` marker is appended and further records are dropped.
- Sidecar writes are best-effort and never throw, so storage failures cannot fail a prompt.
- The Paseo UI shows only the standard projection in v1, which is deliberate.
- The file path and counters travel in the persistence handle so a restored session finds its record again.

## Alternatives considered

- **Render `_meta` into existing items.** Rejected: requires guessing mappings into a closed vocabulary and churns the UI for data nobody asked to see yet.
- **Drop unknown payloads.** Rejected: contradicts the lossless goal and cannot be recovered later.
