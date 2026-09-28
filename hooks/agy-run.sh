#!/usr/bin/env bash
# Antigravity does not set CLAUDE_PLUGIN_ROOT and does not expand ${...} in hook commands.
# agy runs this with cwd set to the directory that contains hooks.json (the plugin root).
set -euo pipefail
export AGY_HOOK_EVENT="${1:-}"
exec "$(cd "$(dirname "$0")" && pwd)/run.sh"
