# Fork changelog

Fork-specific changes on top of `anomalyco/opencode`. Separate from the auto-generated `UPCOMING_CHANGELOG.md` (which derives from the full git log). This file is maintained manually per fork feature.

Entries: newest first. Format: `YYYY-MM-DD — <feature>` with a link to `features/<name>.md`.

---

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
