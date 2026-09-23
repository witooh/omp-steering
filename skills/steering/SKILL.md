---
name: steering
description: >
  Load and follow Kiro steering files from ~/.kiro/steering and <cwd>/.kiro/steering.
  Use at the start of work in a repo that has .kiro/steering, when the user types
  /steering or #name, and before editing a path that matches fileMatch steering.
argument-hint: "<name> [request]"
compatibility: Grok hooks require bun on PATH. This skill itself only needs read access to steering files.
---

# Kiro steering

Follow Kiro steering files already in the project. Do not rewrite them as AGENTS.md or `.grok/rules/`.

## Discover

Read every `*.md` under `~/.kiro/steering/` (global) and `<cwd>/.kiro/steering/` (workspace), including nested directories. Parse YAML frontmatter. Default `inclusion` is `always`. Workspace files win over global files of the same name.

Skip a file whose frontmatter is invalid; do not guess an inclusion mode.

## Inclusion

| Mode | What to do |
| --- | --- |
| `always` | Follow the body now. |
| `fileMatch` | Follow the body before reading or changing a workspace path that matches `fileMatchPattern`. A pattern without `/` also matches by basename (`*.tsx` → `src/Button.tsx`). |
| `manual` | Follow when the user writes `#<filename-stem>` or `/steering <filename-stem>`. |
| `auto` | Follow when the request matches that file's `description`. Also invocable as `#<name>` / `/steering <name>` using frontmatter `name`. |

`/steering <name> [request]` loads that manual or auto file, then does the optional request. `/steering` with no name lists available names.

## File references

`#[[file:path]]` in a steering body is a workspace-relative file. Read it. Reject paths that escape the workspace.

## Hooks

Grok hooks inject always/index context and activate `fileMatch` on tool paths. A first matching mutation may be denied once so the steering arrives before the retry. Cursor's hook concatenates the markdown and does not apply inclusion modes. If a hook did not inject, still follow the table above.
