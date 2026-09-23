#!/usr/bin/env bash
# Dispatch stdin JSON to the Cursor hook. bun is required (same runtime as the omp extension).
set -euo pipefail

ROOT="${CURSOR_PLUGIN_ROOT:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return
  fi
  for candidate in "${HOME}/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

HOOK="$ROOT/src/cursor-hook.ts"
if [ ! -f "$HOOK" ]; then
  printf '%s\n' '{"additional_context":"omp-steering: cursor hook script is missing from the plugin install."}'
  exit 0
fi

BUN="$(find_bun || true)"
if [ -z "$BUN" ]; then
  printf '%s\n' '{"additional_context":"omp-steering: bun is required on PATH to load Kiro steering files."}'
  exit 0
fi

exec "$BUN" "$HOOK"
