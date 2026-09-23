#!/usr/bin/env bash
# Cursor sessionStart hook. Reads Kiro steering markdown and injects it.
# Shell only. Inclusion modes are ignored: every *.md is context, the way
# other harnesses read an instruction file they do not specially understand.
set -euo pipefail

cat >/dev/null

MAX_CHARS=100000

escape_for_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

strip_frontmatter() {
  awk '
    NR == 1 && $0 == "---" { skip = 1; next }
    skip && $0 == "---" { skip = 0; next }
    !skip { print }
  ' "$1"
}

append_tree() {
  local root="$1"
  local label="$2"
  local file body
  if [ ! -d "$root" ]; then
    return 0
  fi
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    body="$(strip_frontmatter "$file")"
    if [ -z "$body" ]; then
      continue
    fi
    if [ -n "$context" ]; then
      context="${context}"$'\n\n'
    fi
    context="${context}## ${label}/${file#"$root"/}"$'\n\n'"${body}"
  done <<EOF
$(find "$root" -type f -name '*.md' | sort)
EOF
}

context=""
if [ -n "${HOME:-}" ]; then
  append_tree "$HOME/.kiro/steering" "~/.kiro/steering"
fi
workspace="${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-}}"
if [ -n "$workspace" ]; then
  append_tree "$workspace/.kiro/steering" ".kiro/steering"
fi

if [ -z "$context" ]; then
  exit 0
fi

if [ "${#context}" -gt "$MAX_CHARS" ]; then
  context="${context:0:$((MAX_CHARS - 14))}"$'\n[truncated]'
fi

escaped="$(escape_for_json "$context")"
printf '{"additional_context":"%s"}\n' "$escaped"
