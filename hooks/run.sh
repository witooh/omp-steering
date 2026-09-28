#!/usr/bin/env bash
# Dispatch stdin JSON to the Grok, Claude Code, or Antigravity hook. bun is required.
set -euo pipefail

ROOT="${GROK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

unavailable() {
  local message="$1"
  if [ -n "${AGY_HOOK_EVENT:-}" ]; then
    if [ "$AGY_HOOK_EVENT" = "PreToolUse" ]; then
      printf '%s\n' "{\"decision\":\"allow\",\"reason\":\"${message}\"}"
    else
      printf '%s\n' "{\"injectSteps\":[{\"ephemeralMessage\":\"${message}\"}]}"
    fi
    exit 0
  fi
  printf '%s\n' "{\"additionalContext\":\"${message}\",\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"${message}\"}}"
  exit 0
}

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

HOOK="$ROOT/src/grok-hook.ts"
if [ ! -f "$HOOK" ]; then
  unavailable "omp-steering: grok hook script is missing from the plugin install."
fi

BUN="$(find_bun || true)"
if [ -z "$BUN" ]; then
  unavailable "omp-steering: bun is required on PATH to load Kiro steering files."
fi

exec "$BUN" "$HOOK"
