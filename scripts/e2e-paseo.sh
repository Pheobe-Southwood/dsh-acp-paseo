#!/usr/bin/env bash
# Real end-to-end, gated behind PASEO_E2E=1.
#
# Stage 1 always runs: a live model turn through `dsh --profile acp-plus`,
# exercising streaming frames, event mirroring and session forking.
#
# Stage 2 runs only when the `paseo` CLI is present and PASEO_CLI_E2E=1: it
# installs this repository's provider plugin into a throwaway PASEO_HOME. The
# install flow talks to a Paseo daemon, so it is opt-in separately.
set -euo pipefail

if [[ "${PASEO_E2E:-}" != "1" ]]; then
  echo "skip: set PASEO_E2E=1 to run the real end-to-end (spawns dsh, may call a model)" >&2
  exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: dsh is not on PATH" >&2
  exit 1
fi

echo "== build"
pnpm -r build

echo "== live DSH bridge turn (real model)"
DSH_ACP_LIVE=1 pnpm --filter @ds-hu/dsh-acp-plus test:live

if [[ "${PASEO_CLI_E2E:-}" != "1" ]]; then
  echo "note: set PASEO_CLI_E2E=1 to also install the provider into a throwaway PASEO_HOME" >&2
  exit 0
fi

if ! command -v paseo >/dev/null 2>&1; then
  echo "note: paseo CLI not found; skipped the provider-install check" >&2
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export PASEO_HOME="$work/paseo-home"
mkdir -p "$PASEO_HOME"

echo "== install the provider plugin (PASEO_HOME=$PASEO_HOME)"
paseo plugin install "$root/packages/paseo-provider"
paseo plugin ls
paseo provider ls
