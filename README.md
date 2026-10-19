# dsh-acp-paseo

Two plugins that let [Paseo](https://github.com/getpaseo/paseo) drive the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) without
losing DSH-native semantics:

| Package | Side | Role |
| --- | --- | --- |
| [`dsh-acp-plus`](packages/dsh-acp-plus/README.md) | DSH bundle | Self-written ACP v1 agent. Projects DSH sessions onto standard ACP payloads **and** carries the native objects in `_meta.dsh` plus `_dsh/*` extension notifications. |
| [`paseo-provider-deepseek-harness`](packages/paseo-provider/README.md) | Paseo plugin | Registers the `deepseek-harness` provider, renders the vocabulary Paseo supports, and stores every `_meta`/`_dsh/*` payload verbatim in a per-session sidecar instead of rendering it. |

The design decisions behind that split are recorded in
[`docs/CONTEXT.md`](docs/CONTEXT.md) and [`docs/adr/`](docs/adr).

## Quick start

```bash
pnpm install
pnpm -r build
pnpm test              # unit + contract tests (offline)
pnpm test:integration  # spawns a real `dsh --profile acp-plus` on a throwaway DSH_HOME
DSH_ACP_LIVE=1 pnpm --filter dsh-acp-plus test:live   # real model turn + fork
PASEO_E2E=1 pnpm e2e:paseo                            # the live test, plus the Paseo CLI when present
```

The DSH side installs as a bundle named `dsh-acp-plus`; a profile built from
`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-acp-plus"]` serves
ACP v1 on stdio and is what Paseo launches (`dsh --profile acp-plus`). See the
package README for the exact profile layout used by the integration test.

## Layout

```
packages/dsh-acp-plus/   DSH bundle + ACP v1 agent (src/, test/, cordis.patch.yml)
packages/paseo-provider/ Paseo plugin (index.server.ts, src/, test/)
contract/                Language-neutral JSON Schema + fixtures for the _meta/_dsh contract
docs/                    CONTEXT.md glossary and ADRs
scripts/e2e-paseo.sh     Flag-gated real end-to-end
```

## License

MIT — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
