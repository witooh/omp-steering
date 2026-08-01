---
name: ship
description: Cut a release of this package in one step — commit pending work, bump the version, run the gates, tag, push, and publish the GitHub release. Use when asked to ship, release, or cut a version.
---

# Ship

One invocation from working tree to published GitHub release. A dirty tree is
expected: ship commits it. Argument selects the bump — `patch` (default),
`minor`, `major`, or an explicit `X.Y.Z`.

Run every step; stop at the first failure and report where it stopped.

## 1. Preflight

```bash
git rev-parse --abbrev-ref HEAD   # must be main
gh auth status
git status --short
```

Read the status list. Abort and ask the user if anything staged-by-`-A` would
be a mistake — `.env*`, keys, tokens, build output, logs, dumps, anything large
or untracked that `.gitignore` should have caught. Everything else ships.

## 2. Gates

```bash
bun test && bun run check && bunx biome check .
```

A failing gate ends the ship: no commit, no bump, no tag.

## 3. Commit pending work

Skip when `git status --short` is empty. Otherwise:

```bash
git add -A && git commit -F - <<'EOF'
<imperative summary of what changed>

<why, and anything a reader six months out needs>
EOF
```

Describe the change, not the release. The version bump gets its own commit in
the next step.

## 4. Bump, commit, tag

```bash
bun pm version <increment> -m "Release v%s"
```

One command: writes `package.json`, commits `Release vX.Y.Z`, tags `vX.Y.Z`.
Verify:

```bash
git show --stat HEAD && git describe --tags --abbrev=0
```

Only `package.json` may appear in that commit, and the tag carries the `v`
prefix — this repo tags `v0.1.0`, never `0.1.0`.

## 5. Push

```bash
git push origin main && git push origin vX.Y.Z
```

## 6. GitHub release

Notes come from `git log <previous-tag>..vX.Y.Z --oneline`, grouped by what a
user sees — features, fixes, breaking changes — not one bullet per commit.
Always close with the install block.

```bash
gh release create vX.Y.Z --title vX.Y.Z --notes "$(cat <<'EOF'
<notes>

## Install

```bash
omp plugin install github:witooh/omp-steering#vX.Y.Z
```
EOF
)"
```

## 7. Report

```bash
gh release view vX.Y.Z --json tagName,isDraft,url
```

Report the tag, both commit shas, and the release URL.

## Rollback

Failed after the bump but before pushing:

```bash
git tag -d vX.Y.Z && git reset --hard HEAD~1
```

Once pushed, never rewrite — ship the next patch instead.
