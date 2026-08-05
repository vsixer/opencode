# Upstream sync

The official repository is configured as the `upstream` remote; `origin` points to the fork.

```
git fetch upstream
git checkout dev
git merge upstream/dev
git push origin dev
```

## Conflict safety

`docs-vsixer/`, `.opencode/` (fork content), and `.ocl-builds/` are fork-owned — upstream does not contain them, so `git merge upstream/dev` will never conflict on these paths. Conflicts can only arise when a fork commit edits an upstream-owned file (`README*.md`, `CONTRIBUTING.md`, files under `packages/`, etc.). Rule: **only add fork files, never edit upstream-owned files**.

When local fork commits exist, before merging upstream:

```
git fetch upstream
git log --oneline upstream/dev..dev       # what's local
git log --oneline dev..upstream/dev       # what's incoming
```

Resolve conflicts preserving both fork intent and upstream changes. If a fork feature modifies the same file upstream changed, consult `docs-vsixer/features/<name>.md` for the fork intent before resolving.

## Status

As of 2026-08-03 the fork was a clean fast-forward from `upstream/dev`. As of 2026-08-05 it carries fork commits on the `global-local-merge` branch (layered merge feature — see `docs-vsixer/features/layered-merge.md`).

## Git policy

Git commits are FORBIDDEN from automated agents. Only `git status`, `git diff`, `git log` are allowed without explicit user request. Commits, amendments, pushes, and PRs require an explicit user instruction. See the `git-policy` skill for full rules.
