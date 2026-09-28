# omp-steering

An omp extension, Grok plugin, Cursor plugin, Claude Code plugin, and Antigravity plugin that reads [Kiro Steering](https://kiro.dev/docs/steering/)
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

On omp, `always` files are appended to the system prompt. On Grok and Claude Code they are
emitted from session start (and the first prompt, when that hook runs) and from the
`/steering` skill. Grok injection is best-effort; see [Grok Build](#grok-build).
Claude Code delivers that context; see [Claude Code](#claude-code).
On Antigravity they are injected as a `PreInvocation` ephemeral message; see [Antigravity](#antigravity).
On Cursor, the plugin hook concatenates every steering markdown file into the
session and does not apply inclusion modes.

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

The repo is a Cursor plugin (`.cursor-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, `skills/steering`, `hooks/hooks-cursor.json`). Add the GitHub repository as a marketplace, then install `omp-steering`. The hook is bash. It does not need bun.

```text
/add-plugin https://github.com/witooh/omp-steering
```

Cursor reads `.cursor-plugin/marketplace.json` first. The only entry is `omp-steering` at `source: "./"`. A repo with only `plugin.json` does not show up in that marketplace list.

`sessionStart` reads `~/.kiro/steering/**/*.md` and `<cwd>/.kiro/steering/**/*.md`, strips YAML frontmatter, and injects the bodies. Workspace files come after global files. `fileMatch`, `manual`, and `auto` are not applied: every file is context, the same way another harness would read instruction files it does not specially understand. `/steering` remains available if the hook did not run.

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

### Claude Code

The repo is a Claude Code plugin (`.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `skills/steering`, `hooks/hooks.json`). bun must be on PATH so the hooks can run. Claude Code loads `hooks/hooks.json` from the plugin root. That file is shared with Grok. The command uses `${GROK_PLUGIN_ROOT}` when it is set, and `${CLAUDE_PLUGIN_ROOT}` otherwise.

```bash
claude plugin marketplace add witooh/omp-steering
claude plugin install omp-steering@omp-steering
```

Load this checkout for one session instead of installing it:

```bash
claude --plugin-dir .
```

Or register the checkout as a marketplace, then install by catalog name:

```bash
claude plugin marketplace add .
claude plugin install omp-steering@omp-steering
```

`/steering` (or `/omp-steering:steering` on a name collision) lists or loads a manual/auto file. `#name` in a prompt is handled by the `UserPromptSubmit` hook.

Claude Code delivers `SessionStart` and `UserPromptSubmit` `additionalContext`. A matching `Read` delivers the `fileMatch` body through `PreToolUse` `additionalContext`. `Edit`, `Write`, and `NotebookEdit` do not reach that hook until the file has been read, so that read is the usual activation. A mutation is denied once only when it is the first matching call. `additionalContext` and deny reasons are capped at 10,000 characters. The first `UserPromptSubmit` repeats the session index. A cloud session does not load plugins installed only on your machine.

### Antigravity

The repo root is an Antigravity plugin (`plugin.json`, `hooks.json`, `skills/steering`). `agy` reads `hooks.json` at the plugin root, not `hooks/hooks.json`. bun must be on PATH so the hooks can run. Hook commands are relative `bash` paths: agy does not expand `${...}`.

```bash
agy plugin install https://github.com/witooh/omp-steering
```

Local checkout:

```bash
agy plugin install .
```

That stages the repo under `~/.gemini/config/plugins/omp-steering`. The CLI and the IDE load plugins from that directory. Start a new session after installing.

```bash
agy plugin uninstall omp-steering
```

There is no `SessionStart` or `UserPromptSubmit` event. `PreInvocation` injects always bodies and the steering index as an `ephemeralMessage` before each model call. The first matching `view_file`, `write_to_file`, `replace_file_content`, or `multi_replace_file_content` is denied once so the `fileMatch` body arrives in `reason`; the retry is allowed. `#name` expands from the latest `USER_INPUT` already written to `transcriptPath`. If that line is not there yet, use `/steering <name>`. Injected text is capped at 10,000 characters. The workspace root is the first `workspacePaths` entry.

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
retry after the steering instructions have been delivered. On Claude Code the
same deny applies only if `Edit`, `Write`, or `NotebookEdit` is the first
matching call. A prior matching `Read` already delivered the body, so the
later mutation is not denied by this plugin. On Antigravity the first matching
`view_file`, `write_to_file`, `replace_file_content`, or
`multi_replace_file_content` is denied once and the body is placed in `reason`.
Targets are read from `path` / `paths` (omp), `target_file` / `file_path` /
`target_directory` (Grok), `file_path` / `notebook_path` (Claude Code),
`AbsolutePath` / `TargetFile` (Antigravity), from `[path#TAG]` section headers of a hashline
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
- `#name` expansion runs on omp's `input` event (interactive and RPC prompts),
  on Grok and Claude Code `UserPromptSubmit` hooks, and on Antigravity from the
  latest `USER_INPUT` in `transcriptPath`. Use `/steering <name>` elsewhere.
- Grok hooks require bun on PATH. SessionStart / UserPromptSubmit injection is
  best-effort on Grok 1.0.30 even after the hook runs; see [Grok Build](#grok-build).
  On 1.0.30, plugin-bundled `hooks.json` is discovered but not dispatched — run
  `./hooks/install-user-hook.sh` so `fileMatch` deny can fire.
- Claude Code hooks require bun on PATH. `Edit`, `Write`, and `NotebookEdit` are blocked by Claude until the file has been read, and that `Read` activates `fileMatch` before the mutation. `additionalContext` is capped at 10,000 characters. A cloud session does not load plugins installed only on your machine.
- Workspace steering is always read; omp has no project-trust gate.
- `auto` relies on the model to compare the request with each `description`, so
  descriptions should be precise and specific.
- The workspace root is the current working directory used to start omp.
- Steering files with invalid frontmatter are skipped with a warning rather than
  loaded under the wrong inclusion mode.
- Cursor's hook injects every steering markdown file at `sessionStart` and ignores inclusion modes. `sessionStart` does not run in cloud agents, so a Cloud Agent only has the `/steering` skill from `install-cursor-cloud.sh`.
- Antigravity hooks require bun on PATH. The hook contract was checked against agy 1.2.12 (`plugin validate` and `plugin install` also succeed on 1.0.8, but that build's runtime dispatch was not checked). There is no session-start event, so always steering is re-injected as a transient `ephemeralMessage` on each `PreInvocation`. `fileMatch` cannot be attached to a successful `view_file`; the first matching file tool is denied once. Multi-root workspaces use `workspacePaths[0]`.

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
- Claude Code plugins: <https://code.claude.com/docs/en/plugins-reference>
- Antigravity plugins: <https://antigravity.google/docs/plugins>
