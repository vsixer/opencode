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
- [`features/materialize-attachment.md`](features/materialize-attachment.md) — `materialize-attachment` tool: turns an inline pasted/attached image into a real file path so non-vision models can route it to vision tools (`zai-mcp-server_*`). Status: stable, 2026-08-08.
- [`features/config-reload.md`](features/config-reload.md) — `/reload` slash command + `reload_config` tool: hot-reload config, plugins, MCP servers, and instance services without restarting the TUI (adapts upstream PR #9871 to the fork's node-layer + schema event-manifest architecture). Status: stable, 2026-08-08.
- [`features/exclude-configs.md`](features/exclude-configs.md) — `instructionsExclude` config field: glob patterns of instruction files (`AGENTS.md`, …) that opencode ignores without deleting them from disk; applies to global files, auto-discovery, explicit `instructions` paths, and walk-up attach. Status: stable, 2026-08-22.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md).

## Relationship with `.opencode/AGENTS.md`

`.opencode/AGENTS.md` is **agentic instructions** (for LLM agents working in the repo: build rules, git policy, context-mode routing). `docs-vsixer/` is **human-facing documentation** of fork features and setup. Different audiences → kept separate, with cross-references.

## Documenting a new feature

Use the `/document-feature` command to generate or update a `features/<name>.md` from the current branch's diff against `upstream/dev`. See `.opencode/command/document-feature.md`.
