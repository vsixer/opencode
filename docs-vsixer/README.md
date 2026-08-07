# docs-vsixer — fork documentation

Documentation of fork-specific changes layered on top of `anomalyco/opencode`.
Separate from upstream-owned docs (`README*.md`, `CONTRIBUTING.md`, etc.) to keep
`git merge upstream/dev` conflict-free.

## Rule

**Only add files under fork-owned paths. Never edit upstream-owned files.**

| Path | Owner |
|---|---|
| `docs-vsixer/` | fork |
| `.opencode/` (fork content: agents, commands, skills, AGENTS.md) | fork |
| `.ocl-builds/` | fork (gitignored) |
| `README*.md`, `CONTRIBUTING.md`, `SECURITY.md`, `STATS.md`, `CONTEXT.md`, root `AGENTS.md`, `packages/`, `script/`, `specs/`, etc. | upstream — do not edit |

If a fork change requires modifying an upstream file, record the deviation in the relevant `features/<name>.md` under «Расхождение с upstream» and keep the diff minimal.

## Navigation

### Setup
- [`setup/build-aliases.md`](setup/build-aliases.md) — `ocl` / `ocl-dev` / `ocl-build`, channel→DB mapping, Bun version, paths.
- [`setup/upstream-sync.md`](setup/upstream-sync.md) — sync procedure, conflict safety, git policy.

### Features
- [`features/layered-merge.md`](features/layered-merge.md) — layered merge for commands/agents/skills (global + project definitions compose instead of replacing). Status: stable, 2026-08-05.
- [`features/btw-side-panel.md`](features/btw-side-panel.md) — `/btw` as a side panel (50/50 split) instead of a blocking modal; ephemeral side-chat with focus cycle, collapsible thinking, progress indicator, and markdown syntax highlighting. Status: stable, 2026-08-07.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md).

## Relationship with `.opencode/AGENTS.md`

`.opencode/AGENTS.md` is **agentic instructions** (for LLM agents working in the repo: build rules, git policy, context-mode routing). `docs-vsixer/` is **human-facing documentation** of fork features and setup. Different audiences → kept separate, with cross-references.

## Documenting a new feature

Use the `/document-feature` command to generate or update a `features/<name>.md` from the current branch's diff against `upstream/dev`. See `.opencode/command/document-feature.md`.
