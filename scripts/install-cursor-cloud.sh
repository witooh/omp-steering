#!/bin/bash
# Install omp-steering skills onto a Cursor Cloud Agent VM.
#
# Put this in environment.json "install", not "start". "install" runs while
# Cursor creates a Build and the resulting disk is snapshotted. "start" runs
# on every agent boot and is for processes, not skill files.
#
# Cloud Agents scan ~/.cursor/skills/<name>/SKILL.md. /add-plugin does not run
# inside a Build install script, and ~/.cursor/hooks.json is not loaded there.
# This script copies skills only. A later commit is invisible until the next
# successful Build, because the install script's disk state is what gets snapshotted.
#
# From an omp-steering checkout (installs this tree; OMP_STEERING_REF is ignored):
#   ./scripts/install-cursor-cloud.sh
#
# From anywhere else, including a service repo that vendors only this file:
#   OMP_STEERING_REF=v0.1.5 ./scripts/install-cursor-cloud.sh
#
# Dashboard install field, pinned to a tag:
#   set -euo pipefail
#   dir="$(mktemp -d)"
#   git clone --depth 1 --branch v0.1.5 https://github.com/witooh/omp-steering.git "$dir"
#   "$dir/scripts/install-cursor-cloud.sh"
#   rm -rf "$dir"

set -euo pipefail
shopt -s nullglob

OMP_STEERING_URL="${OMP_STEERING_URL:-https://github.com/witooh/omp-steering.git}"
MANIFEST_NAME=".omp-steering-skills"

usage() {
  cat <<'EOF'
Install omp-steering skills into ~/.cursor for a Cursor Cloud Agent Build.

  ./scripts/install-cursor-cloud.sh
      Run from an omp-steering checkout. Installs that tree. OMP_STEERING_REF is ignored.

  OMP_STEERING_REF=<tag> ./scripts/install-cursor-cloud.sh
      Clone that tag or branch, then install it. Required outside a checkout.

  OMP_STEERING_URL=<git url>   override the clone URL (default: the public GitHub repo)

Writes ~/.cursor/skills only. The service working tree is not modified.
Put the command in environment.json "install" so the Build snapshots the result.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi
if [ $# -gt 0 ]; then
  echo "install-cursor-cloud.sh: unknown argument '$1' (try --help)" >&2
  exit 1
fi

valid_ref() {
  case "$1" in
    ""|-*|*..*|*[[:space:]]*|*'~'*|*'^'*|*'?'*|*'['*|*'@{'*) return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  return 0
}

safe_name() {
  case "$1" in
    ""|.*|*/*|*..*) return 1 ;;
  esac
  return 0
}

is_checkout() {
  [ -f "$1/.cursor-plugin/plugin.json" ] && [ -f "$1/skills/steering/SKILL.md" ] || return 1
  grep -q '"name": "omp-steering"' "$1/.cursor-plugin/plugin.json"
}

install_pack() {
  local repo="$1"
  local cursor_root="${HOME:?install-cursor-cloud.sh: HOME is not set}/.cursor"
  local dir name manifest manifest_tmp
  local current_skills=()
  local owned=()
  local removed_skills=()

  if [ ! -f "$repo/skills/steering/SKILL.md" ]; then
    echo "install-cursor-cloud.sh: $repo has no skills/steering/SKILL.md" >&2
    exit 1
  fi

  echo "install-cursor-cloud.sh: installing $repo"
  echo "  target: $cursor_root/skills"
  mkdir -p "$cursor_root/skills"

  for dir in "$repo"/skills/*/; do
    if [ ! -f "${dir}SKILL.md" ]; then
      continue
    fi
    name="$(basename "${dir%/}")"
    if ! safe_name "$name"; then
      echo "install-cursor-cloud.sh: refusing skill name '$name'" >&2
      exit 1
    fi
    current_skills+=("$name")
  done

  manifest="$cursor_root/$MANIFEST_NAME"
  if [ -f "$manifest" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ""|\#*) continue ;;
      esac
      line="${line%$'\r'}"
      if safe_name "$line"; then
        owned+=("$line")
      fi
    done < "$manifest"
  fi

  if [ "${#owned[@]}" -gt 0 ]; then
    for name in "${owned[@]}"; do
      safe_name "$name" || continue
      local current=""
      if [ "${#current_skills[@]}" -gt 0 ]; then
        for current in "${current_skills[@]}"; do
          if [ "$current" = "$name" ]; then
            current="keep"
            break
          fi
        done
      fi
      if [ "$current" = "keep" ]; then
        continue
      fi
      if [ -d "$cursor_root/skills/$name" ]; then
        rm -rf "$cursor_root/skills/$name"
        removed_skills+=("$name")
      fi
    done
  fi

  local skills=0
  for dir in "$repo"/skills/*/; do
    if [ ! -f "${dir}SKILL.md" ]; then
      continue
    fi
    name="$(basename "${dir%/}")"
    rm -rf "$cursor_root/skills/$name"
    cp -R "${dir%/}" "$cursor_root/skills/$name"
    skills=$((skills + 1))
  done

  manifest_tmp="$(mktemp)"
  if [ "${#current_skills[@]}" -gt 0 ]; then
    printf '%s\n' "${current_skills[@]}" | sort > "$manifest_tmp"
  else
    : > "$manifest_tmp"
  fi
  mv "$manifest_tmp" "$manifest"
  printf '  %-11s %d\n' "skills:" "$skills"
  printf '  %-11s %d\n' "removed:" "${#removed_skills[@]}"
}

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$script_dir/.." && pwd)"
pack=""
if is_checkout "$repo"; then
  pack="$repo"
fi

clone_dir=""
cleanup() {
  if [ -n "$clone_dir" ]; then
    rm -rf "$clone_dir"
  fi
}
trap cleanup EXIT

if [ -n "$pack" ]; then
  install_pack "$pack"
else
  ref="${OMP_STEERING_REF:-}"
  if ! valid_ref "$ref"; then
    echo "install-cursor-cloud.sh: OMP_STEERING_REF must be a tag or branch name (example: OMP_STEERING_REF=v0.1.5)" >&2
    exit 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "install-cursor-cloud.sh: git is required to clone $ref" >&2
    exit 1
  fi
  clone_dir="$(mktemp -d)"
  echo "install-cursor-cloud.sh: cloning $ref"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$ref" "$OMP_STEERING_URL" "$clone_dir"
  install_pack "$clone_dir"
fi

if [ ! -f "$HOME/.cursor/skills/steering/SKILL.md" ]; then
  echo "install-cursor-cloud.sh: install finished but $HOME/.cursor/skills/steering/SKILL.md is missing" >&2
  exit 1
fi

echo "install-cursor-cloud.sh: steering skill is in $HOME/.cursor/skills"
