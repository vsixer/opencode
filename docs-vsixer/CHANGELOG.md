# Fork changelog

Fork-specific changes on top of `anomalyco/opencode`. Separate from the auto-generated `UPCOMING_CHANGELOG.md` (which derives from the full git log). This file is maintained manually per fork feature.

Entries: newest first. Format: `YYYY-MM-DD — <feature>` with a link to `features/<name>.md`.

---

## 2026-08-08 — materialize-attachment tool

New custom tool `materialize-attachment` that turns an inline pasted/attached image (or PDF/SVG) into a real file path and returns it. This lets non-vision models (e.g. `glm-5.2`) recover from a «model does not support image input» error by routing the path to a vision tool (`zai-mcp-server_extract_text_from_screenshot`, `zai-mcp-server_analyze_image`, …). Reads the latest user attachment's `file` part read-only from the local SQLite projection (channel-agnostic — scans all `opencode*.db`), preferring the original `source.path` if the file still exists on disk, otherwise decoding the inline `data:` URL to `/tmp/opencode/attachments/<sha1>.<ext>`. Uses `bun:sqlite` only — no network port, no `@opencode-ai/opencode` import — so it works in every run mode (TUI/CLI/ACP).

Fork-safe: confined to `.opencode/tool/materialize-attachment.ts` + `.opencode/opencode.jsonc`; no `packages/**` files touched — zero `git merge upstream/dev` conflict surface.

Docs: [`features/materialize-attachment.md`](features/materialize-attachment.md).

## 2026-08-07 — Version scheme for local builds

Local builds (`ocl-build`) now report the **actual npm `opencode-ai@latest` version with a `+vsixer` suffix** (e.g. `1.18.15+vsixer`) instead of the `package.json` version that drifted relative to the registry. The `+vsixer` suffix is semver build metadata: it stays visible in `--version`, but `semver.satisfies` still treats the version as equal to the release, so plugin compatibility checks (`checkPluginCompatibility`) keep working and there is no false «update available» notification. Offline fallback: `package.json` version + `+vsixer`.

Change is confined to `.ocl-builds/build.sh` (fork-owned). Upstream versioning logic in `packages/script/src/index.ts` is untouched — no `git merge upstream/dev` conflict surface.

Docs: [`setup/build-aliases.md`](setup/build-aliases.md).

## 2026-08-07 — BTW side panel

Branch: `btw-side-panel`.

`/btw` теперь открывает эфемерный side-chat в **боковой панели** (рабочая область делится 50/50 по горизонтали), а не в блокирующей модалке. Основная сессия остаётся интерактивной — две сессии работают параллельно. Включает: cycle фокуса (`<leader>b`), закрытие (`<leader>p`), прерывание хода (зеркалирует `session.interrupt` из `tui.jsonc`), сворачиваемые thinking-блоки, индикатор выполнения (таймер тура), подсветку синтаксиса через `<markdown>`/`<code>` как в основной сессии. Серверная часть `session/btw` in-memory, без персистенции; сбрасывается при смене сессии.

Расхождение с upstream: btw — полностью fork-фича (upstream не имеет `/btw`); затронуты upstream-owned TUI-файлы (`app.tsx`, `routes/session/index.tsx`, `component/prompt/index.tsx`, `config/keybind.ts`, `ui/dialog.tsx`) — это конфликт-поверхность при `git merge upstream/dev`.

Docs: [`features/btw-side-panel.md`](features/btw-side-panel.md).

## 2026-08-05 — Layered merge for commands/agents/skills

Branch: `global-local-merge`.

When a local (project `.opencode/`) definition collides by name with a global (`~/.config/opencode/`) one, the definitions are now **merged** (composed) instead of the local one fully replacing the global. Default composition: global body → local body, with named slots (`<!-- slot: X -->`) for insertion points. Frontmatter: scalars/objects wholesale local-wins, `permission` per-key override. Opt out per-file via `merge: replace`.

Breaking: existing collisions start merging on upgrade. Escape hatch: `merge: replace` in the local file's frontmatter.

Docs: [`features/layered-merge.md`](features/layered-merge.md).
