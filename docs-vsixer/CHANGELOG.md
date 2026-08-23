# Fork changelog

Fork-specific changes on top of `anomalyco/opencode`. Separate from the auto-generated `UPCOMING_CHANGELOG.md` (which derives from the full git log). This file is maintained manually per fork feature.

Entries: newest first. Format: `YYYY-MM-DD — <feature>` with a link to `features/<name>.md`.

---

## 2026-08-22 — instructionsExclude: исключение файлов инструкций

Новое поле `instructionsExclude` в `opencode.json`: список glob-паттернов файлов инструкций, которые opencode игнорирует без удаления с диска. Фильтр действует на все файловые источники — глобальные файлы, автопоиск `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md`, явные пути из `instructions` и walk-up подключение при чтении файлов; URL не затрагиваются. Паттерны сопоставляются относительно корня проекта (в non-git каталогах — рабочей директории), для внешних файлов поддерживается абсолютный путь и префикс `~/`; exclude побеждает include. Поле опционально — без него поведение идентично upstream.

Конфликтная поверхность: изменены четыре upstream-owned файла (`packages/core/src/v1/config/config.ts`, `packages/opencode/src/config/config.ts`, `packages/opencode/src/session/instruction.ts`, `packages/opencode/test/session/instruction.test.ts`) — вставки локальны, вероятность конфликта при синке низкая.

Docs: [`features/exclude-configs.md`](features/exclude-configs.md).

## 2026-08-08 — /reload hot config reload

Slash-команда `/reload` и тул `reload_config` горячо перезагружают конфигурацию (`opencode.jsonc`, плагины, MCP-серверы, instance-scoped сервисы) без перезапуска TUI. Если есть активные сессии — релод ставится в очередь до idle, затем инстанс перезагружается через `InstanceStore.reload`, а TUI ре-синхронизируется (overlay + bootstrap-cycle handshake `POST /config/bootstrap-complete`). Состояние per-instance; повторные запросы коалясятся; overlay защищён fallback-таймаутом. Тул `reload_config` больше не инжектит синтетический continuation-prompt — durable-история остаётся чистой.

Адаптация upstream PR [#9871](https://github.com/anomalyco/opencode/pull/9871) (issue #6719) под архитектуру форка: node-слои вместо `defaultLayer`, события `config.reload.*` вынесены в `packages/schema/src/config-reload-event.ts` и зарегистрированы в event-manifest (источник истины для OpenAPI/SDK), mock `ConfigReload` добавлен в 6 тестов из-за unbound-зависимости `InstanceBootstrap` в `InstanceStore.node`.

Конфликтная поверхность: изменены upstream-owned файлы в `packages/opencode`, `packages/schema`, `packages/tui` + регенерирован SDK — потребуется сведение, если upstream смержит PR #9871.

Docs: [`features/config-reload.md`](features/config-reload.md).

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
