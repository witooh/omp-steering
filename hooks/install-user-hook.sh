#!/usr/bin/env bash
# Copy the Grok user-global overlay so SessionStart / UserPromptSubmit / PreToolUse
# run even when Grok does not dispatch plugin-bundled hooks.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.grok/hooks/omp-steering.json"
mkdir -p "$(dirname "$DEST")"
cp "$ROOT/grok-user-global.json" "$DEST"
printf 'Installed %s\n' "$DEST"
