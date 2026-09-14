#!/usr/bin/env bash
# Locate the installed omp-steering plugin and run its Grok hook.
# Kept out of hooks.json command strings so Grok does not treat $d as a missing env var.
set -euo pipefail

for d in "${HOME}/.grok/installed-plugins/"* "${HOME}/.grok/plugins/"*; do
  if [ -f "$d/hooks/run.sh" ] && [ -f "$d/plugin.json" ] && grep -q '"name": "omp-steering"' "$d/plugin.json"; then
    exec "$d/hooks/run.sh"
  fi
done

printf '%s\n' '{"additionalContext":"omp-steering: installed plugin not found"}'
exit 0
