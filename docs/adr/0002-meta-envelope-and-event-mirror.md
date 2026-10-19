# `_meta.dsh` envelope plus a `_dsh/event` mirror

**Status**: Accepted

## Context

Standard ACP fields cannot carry DSH semantics: turn and step coordinates, DSH tool-call ids, the approval policy, compaction brackets, or event types with no ACP equivalent. Clients that know nothing about DSH must not break on the extra data, and clients that do know DSH should be able to reconstruct the session without the harness.

## Decision

Two channels carry native semantics:

1. Every payload that allows `_meta` carries `_meta.dsh = {v, kind, native}` — `v` is the envelope version (`1`), `kind` is a stable tag such as `update.tool_call` or `session-fork`, and `native` is the originating DSH object verbatim.
2. Every durable DSH session event is mirrored in seq order as the `_dsh/event` extension notification, and transient assistant-stream frames go on `_dsh/frame`.

## Consequences

- A standard client ignores the unknown notification and still renders the projected update; a DSH-aware client can re-derive the full native history from the mirror.
- Payload volume grows, so the Paseo side stores the native channel in a sidecar instead of Paseo's transcript.
- The envelope and extension names become a public contract: they are versioned (`v`) and additive.
- `_meta` is attached at update level and on method results, so `kind` naming has to stay stable.

## Alternatives considered

- **Standard projection only.** Rejected: lossy; the whole point is that a client can later re-derive what DSH said.
- **A side channel without `_meta`.** Rejected: clients cannot correlate a mirrored event with the standard update it belongs to.
- **Embedding JSON in text content.** Rejected: unparseable by clients and visible in the transcript.
