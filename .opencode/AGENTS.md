# opencode fork — local development setup

This repository is a fork of `anomalyco/opencode` at `/home/vsixer/Projects/opencode`.
The official repository is configured as the `upstream` remote; `origin` points to the fork.

## Setup & docs (human-facing)

Setup and upstream-sync procedures live in `docs-vsixer/`:

- `docs-vsixer/setup/build-aliases.md` — `ocl` / `ocl-dev` / `ocl-build`, channel→DB mapping, Bun version, paths.
- `docs-vsixer/setup/upstream-sync.md` — sync procedure, conflict safety, git policy.

## Fork documentation (lazy load)

Fork-specific feature docs live in `docs-vsixer/features/`. Index: `docs-vsixer/README.md`. Changelog: `docs-vsixer/CHANGELOG.md`.

**Lazy-load rule:** do NOT read the whole `docs-vsixer/` tree into context. When a task touches a fork feature:

1. Read `docs-vsixer/README.md` (small index) to find the relevant feature page.
2. Read (or `ctx_execute_file`-analyze) only the specific `docs-vsixer/features/<name>.md` that matches the task.
3. Use the «Расхождение с upstream» section of that page to identify the conflict surface before editing upstream-adjacent code.

To document a new feature implemented in the current branch, use the `/document-feature` command (`.opencode/command/document-feature.md`).

## Rule: do not edit upstream-owned files

Only add files under fork-owned paths (`docs-vsixer/`, `.opencode/`, `.ocl-builds/`). Upstream-owned files (`README*.md`, `CONTRIBUTING.md`, `packages/`, `script/`, `specs/`, etc.) must not be edited — that is the conflict surface during `git merge upstream/dev`. Record any unavoidable upstream deviation in the relevant `docs-vsixer/features/<name>.md`.
