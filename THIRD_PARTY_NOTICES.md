# Third-party notices

This repository is licensed MIT. Each package declares `"license": "MIT"` in its `package.json`.

No source code from the repositories below is copied into this repository. They were consulted as design and contract references while the two packages were written.

## Design references

### `ref/dsh-TUI` — MIT

Consulted as a design reference for the DSH session-fork flow (slicing a session prefix, `agents.create` with a seed and `inheritedEventCount`, and closing an open turn) and for translating DSH events into a client-neutral form. No code from `ref/dsh-TUI` is copied into this repository.

### `ref/dsh-std` — MIT

Consulted as a design reference for session-history and fork protocol semantics and for presentation-level request/value types. No code from `ref/dsh-std` is copied into this repository.

### Paseo — Apache-2.0

Consulted as a contract reference: the provider contract (`ProviderRegistration`, `ProviderConnection`, `ProviderEvent`/`ProviderInput`, capability negotiation), the provider examples, and the question-form core used to shape the question-card mapping. This repository's Paseo plugin depends on the published `@getpaseo/*` packages; no Paseo source code is copied into this repository.
