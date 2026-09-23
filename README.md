# omp-steering

An omp extension, Grok plugin, and Cursor plugin that reads [Kiro Steering](https://kiro.dev/docs/steering/)
from existing projects without requiring files to be moved or rules to be
rewritten.

## Supported features

<!-- markdownlint-disable MD013 -->

| Kiro Steering | Behavior |
| --- | --- |
| Global scope | Reads `~/.kiro/steering/**/*.md` |
| Workspace scope | Reads `<cwd>/.kiro/steering/**/*.md` |
| `inclusion: always` | Appended to the system prompt for every request; this is the default when frontmatter is omitted |
| `inclusion: fileMatch` | Matches globs against workspace-relative paths and injects steering before working with matching files |
| `inclusion: manual` | Invoked with `#file-name` or `/steering <file-name>` |
| `inclusion: auto` | Exposes `name`, `description`, and the path so the agent can load relevant steering automatically |
| `#[[file:path]]` | Reads workspace-relative file content into context while preventing path traversal |

<!-- markdownlint-enable MD013 -->

When global and workspace instructions conflict, workspace steering is placed
later and explicitly given priority, matching Kiro's behavior.

On omp, `always` files are appended to the system prompt. On Grok and Cursor they are
emitted from session start (and the first prompt, when that hook runs) and from the
`/steering` skill. Grok injection is best-effort; see [Grok Build](#grok-build).

## Installation

### omp

```bash
omp plugin install github:witooh/omp-steering
```

### Upgrade

```bash
omp plugin install github:witooh/omp-steering
# or a specific release
omp plugin install github:witooh/omp-steering#v0.1.1
```

Link the current checkout instead of installing from git:

```bash
bun install
omp plugin link .
```

Or load it for a single run without registering it:

```bash
omp -e /path/to/omp-steering
```

omp loads the package through `omp.extensions` in `package.json`.

### Cursor

The repo is a Cursor plugin (`.cursor-plugin/plugin.json`, `skills/steering`, `hooks/hooks-cursor.json`). Add it from the GitHub repository; bun must be on PATH so the hooks can run.

```text
/add-plugin https://github.com/witooh/omp-steering
```

`sessionStart` injects `always` steering and the fileMatch/auto/manual index. `beforeSubmitPrompt` expands `#name`. `preToolUse` denies the first matching mutation (`Write`, `Edit`, and the other edit tools) once so the steering arrives before the retry, and injects matching steering on a read. Cursor has no prompt-submit context field besides blocking, so `#name` is injected as `additional_context` only when the host accepts it; `/steering` remains the fallback.

Cloud Agents do not run `/add-plugin` during a Build, and they do not load `~/.cursor/hooks.json`. They do scan `~/.cursor/skills`. Put the installer in `environment.json` `install`, not `start`: `install` runs while Cursor creates a Build, and the resulting disk is snapshotted.

```bash
./scripts/install-cursor-cloud.sh
```

From a service repo that does not contain this checkout, pin a tag:

```bash
OMP_STEERING_REF=v0.1.5 ./scripts/install-cursor-cloud.sh
```

That copies `skills/steering` into `~/.cursor/skills` and does not touch the working tree. A later commit is invisible until the next successful Build.

### Grok Build

The repo is a native Grok plugin (`plugin.json`, `hooks/hooks.json`, `skills/steering`). bun must be on PATH so the hooks can run.

```bash
grok plugin install witooh/omp-steering --trust
grok plugin enable omp-steering
```

`--trust` lets the hooks run. `enable` is separate: Grok leaves plugins off until they are listed in `[plugins].enabled` or enabled in the Plugins tab (`/plugins`, then Space). Start a new session after enabling.

Grok 1.0.30 discovers plugin `hooks/hooks.json` but does not dispatch those commands into `hook_execution`. `fileMatch` deny therefore never fires from the plugin file alone. After install, copy the user-global overlay (then start a new session, or reload hooks with `/hooks`):

```bash
./hooks/install-user-hook.sh
```

That writes `~/.grok/hooks/omp-steering.json`, which Grok does run. Plugin-bundled hooks still use `${GROK_PLUGIN_ROOT}/hooks/run.sh` for hosts that dispatch them.

```bash
grok plugin update omp-steering
grok plugin uninstall omp-steering --confirm
```

Or add this repo as a marketplace, then install by catalog name (that clones GitHub, not a local working tree):

```bash
grok plugin marketplace add witooh/omp-steering
grok plugin install omp-steering --trust
grok plugin enable omp-steering
```

Local checkout:

```bash
grok plugin install . --trust
grok plugin enable omp-steering
```

`/steering` (or `/omp-steering:steering` on a name collision) lists or loads a manual/auto file. `#name` in a prompt is handled by the `UserPromptSubmit` hook.

Grok 1.0.30 **runs** the SessionStart and UserPromptSubmit hooks. The official hooks guide says those events discard stdout / `additionalContext`, so always-included bodies may not land in the model context. The `/steering` skill is the fallback for `always` and `auto`. `fileMatch` on a mutating tool (`search_replace`, `write`, `edit`) is a `PreToolUse` deny whose reason **does** reach the model; Grok clips that reason at 10,000 characters.

## Examples

### Always included

`.kiro/steering/project.md`

```markdown
# Project conventions

- Use bun.
- Add tests for behavior changes.
```

The mode can also be declared explicitly:

```markdown
---
inclusion: always
---

# Project conventions
```

### Conditional inclusion

```markdown
---
inclusion: fileMatch
fileMatchPattern: ["**/*.ts", "**/*.tsx"]
---

# TypeScript conventions
```

When a file tool opens or modifies a matching path, the package adds the
steering file to the conversation context. For the first matching mutation
(`edit` / `write` / `ast_edit` / `apply_patch` in omp; `search_replace` /
`write` / `edit` in Grok), it blocks the mutation once and asks the agent to
retry after the steering instructions have been delivered.
Targets are read from `path` / `paths` (omp), `target_file` / `file_path` /
`target_directory` (Grok), from `[path#TAG]` section headers of a hashline
`edit` patch, and from `*** Update File:` envelopes in apply_patch mode.

A pattern without a `/` also matches by basename, so `"*.tsx"` covers
`src/Button.tsx`.

### Manual inclusion

```markdown
---
inclusion: manual
---

# Review checklist
```

Invoke manual steering in either form:

```text
Review this code using #review
/steering review Review the staged changes
```

The manual steering name comes from the filename (`review.md` becomes
`review`).

### Auto inclusion

```markdown
---
inclusion: auto
name: api-design
description: REST API conventions. Use when creating or changing API endpoints.
---

# API design rules
```

The extension adds only this metadata to the system prompt so the agent can load
the full content when the request matches the description. Auto steering can
also be invoked explicitly with `#api-design` or `/steering api-design`.

### Live file references

```markdown
Follow the contract in #[[file:docs/api.md]].
```

The path must remain inside the workspace. Each referenced file is limited to
50 KiB to prevent excessive context growth.

## Limitations

- Automatic `fileMatch` activation works for tool calls that expose a path.
  Shell commands and custom tools that hide paths inside command text rely on
  the steering index, which instructs the agent to load matching rules before
  proceeding.
- `#name` expansion runs on omp's `input` event (interactive and RPC prompts)
  and on Grok's `UserPromptSubmit` hook. Use `/steering <name>` elsewhere.
- Grok hooks require bun on PATH. SessionStart / UserPromptSubmit injection is
  best-effort on Grok 1.0.30 even after the hook runs; see [Grok Build](#grok-build).
  On 1.0.30, plugin-bundled `hooks.json` is discovered but not dispatched — run
  `./hooks/install-user-hook.sh` so `fileMatch` deny can fire.
- Workspace steering is always read; omp has no project-trust gate.
- `auto` relies on the model to compare the request with each `description`, so
  descriptions should be precise and specific.
- The workspace root is the current working directory used to start omp.
- Steering files with invalid frontmatter are skipped with a warning rather than
  loaded under the wrong inclusion mode.
- Cursor `sessionStart` is not available in cloud agents. Project hooks from an installed plugin still need bun on PATH. `#name` on Cursor depends on `beforeSubmitPrompt` accepting `additional_context`; if it does not, use `/steering <name>`.

## Development

```bash
bun test
bun run check
bun run lint
```

## References

- Kiro Steering: <https://kiro.dev/docs/steering/>
- omp Extensions: <https://omp.sh>
- Grok plugins: `grok plugin validate` in this checkout
