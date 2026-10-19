# One-shot permissions and a hard question fallback

**Status**: Accepted

## Context

ACP `session/request_permission` options are per-call, and DSH's approval policies have no "remember this choice" contract that a bridge could safely project. Separately, interactive questions need a channel that most ACP clients do not implement; a bridge that waits forever on such a client would deadlock the turn.

## Decision

- Permissions are one-shot: `allow_once` versus `reject_once`/`cancelled`. There are no session-scoped grants and no "always allow" memory.
- Interactive questions are forwarded over the `_dsh/user_questions` extension request.
- When the client cannot answer — the method is unsupported, the request is cancelled, or it times out — the `ask_user_question` tool fails with a clear error instead of hanging.

## Consequences

- The same tool can prompt again on the next call; the user stays in control.
- A client that cannot answer questions gets an explicit tool failure the model can act on, rather than a stalled turn.
- The Paseo provider resolves a dismissed or timed-out card as deny, which becomes the same failure path.
- `questionTimeoutMs` is a backstop longer than the harness's own `tool-ask-user` timeout, so the harness normally owns the deadline.

## Alternatives considered

- **`allow_always` / session grants.** Rejected: needs a durable policy store and hides privilege escalation from the user.
- **Fall back to a permission card for questions.** Rejected: only choice questions can be expressed, free text is lost, and the semantics are confusing.
- **Wait indefinitely for an answer.** Rejected: deadlocks the turn on clients without the extension.
