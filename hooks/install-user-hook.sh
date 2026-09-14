#!/usr/bin/env bash
# Copy the Grok user-global overlay so SessionStart / UserPromptSubmit / PreToolUse
# run even when Grok does not dispatch plugin-bundled hooks.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOOKS="${HOME}/.grok/hooks"
mkdir -p "$HOOKS"
cp "$ROOT/user-global-run.sh" "$HOOKS/omp-steering-run.sh"
chmod +x "$HOOKS/omp-steering-run.sh"
cp "$ROOT/grok-user-global.json" "$HOOKS/omp-steering.json"
printf 'Installed %s\n' "$HOOKS/omp-steering.json"
