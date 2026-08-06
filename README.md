# omp-steering

An omp extension that reads [Kiro Steering](https://kiro.dev/docs/steering/)
from existing projects without requiring files to be moved or rules to be
rewritten.

## Supported features

<!-- markdownlint-disable MD013 -->

| Kiro Steering | Behavior in omp |
| --- | --- |
| Global scope | Reads `~/.kiro/steering/**/*.md` |
| Workspace scope | Reads `<cwd>/.kiro/steering/**/*.md` |
| `inclusion: always` | Appended to the system prompt for every request; this is the default when frontmatter is omitted |
| `inclusion: fileMatch` | Matches globs against workspace-relative paths and injects steering before working with matching files |
| `inclusion: manual` | Invoked with `#file-name` or `/steering <file-name>` |
| `inclusion: auto` | Exposes `name`, `description`, and the path so the agent can load relevant steering automatically |
| `#[[file:path]]` | Reads workspace-relative file content into context while preventing path traversal |

<!-- markdownlint-enable MD013 -->

When global and workspace instructions conflict, the extension places workspace
steering later and explicitly gives it priority, matching Kiro's behavior.

## Installation

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

When an omp file tool opens or modifies a matching path, the extension adds the
steering file to the conversation context. For the first matching `edit` or
`write`, the extension blocks the mutation once and asks the agent to retry
after the steering instructions have been delivered. Targets are read from the
tool's `path`/`paths` arguments and from the `[path#TAG]` section headers of a
hashline `edit` patch.

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
- `#name` expansion runs on the `input` event, which omp emits for interactive
  and RPC prompts only. Use `/steering <name>` elsewhere.
- Workspace steering is always read; omp has no project-trust gate.
- `auto` relies on the model to compare the request with each `description`, so
  descriptions should be precise and specific.
- The workspace root is the current working directory used to start omp.
- Steering files with invalid frontmatter are skipped with a warning rather than
  loaded under the wrong inclusion mode.

## Development

```bash
bun test
bun run check
bun run lint
```

## References

- Kiro Steering: <https://kiro.dev/docs/steering/>
- omp Extensions: <https://omp.sh>
