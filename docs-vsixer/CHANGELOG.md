# Fork changelog

Fork-specific changes on top of `anomalyco/opencode`. Separate from the auto-generated `UPCOMING_CHANGELOG.md` (which derives from the full git log). This file is maintained manually per fork feature.

Entries: newest first. Format: `YYYY-MM-DD — <feature>` with a link to `features/<name>.md`.

---

## 2026-08-05 — Layered merge for commands/agents/skills

Branch: `global-local-merge`.

When a local (project `.opencode/`) definition collides by name with a global (`~/.config/opencode/`) one, the definitions are now **merged** (composed) instead of the local one fully replacing the global. Default composition: global body → local body, with named slots (`<!-- slot: X -->`) for insertion points. Frontmatter: scalars/objects wholesale local-wins, `permission` per-key override. Opt out per-file via `merge: replace`.

Breaking: existing collisions start merging on upgrade. Escape hatch: `merge: replace` in the local file's frontmatter.

Docs: [`features/layered-merge.md`](features/layered-merge.md).
