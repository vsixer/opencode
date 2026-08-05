---
description: Generate or update docs-vsixer/features/<name>.md from the current branch's diff against upstream/dev
---

# /document-feature

Create or update the fork documentation page for the feature implemented in the current branch.

## Procedure

Execute all steps. Use context-mode tools (`ctx_batch_execute`, `ctx_execute_file`) for `git log` / `git diff` — do NOT dump raw diffs into context.

### 1. Identify the branch and its fork-specific commits

Run via `ctx_batch_execute(commands, queries)`:

```sh
git rev-parse --abbrev-ref HEAD
git log --oneline upstream/dev..HEAD
git diff --stat upstream/dev..HEAD
```

If `upstream/dev` is unavailable, fall back to `origin/dev..HEAD`. If the branch has zero fork-specific commits, stop and report.

### 2. Determine the feature name

- Derive a short kebab-case name from the branch name (strip type prefixes like `feat/`, `fix/`).
- If the branch name is generic (`dev`, `main`, `fix-bug`), ask the user once for the feature name.
- The doc file is `docs-vsixer/features/<name>.md`.

### 3. Check existing docs

Read `docs-vsixer/README.md` (index) and the target `features/<name>.md` if it exists. Also read one existing feature page (e.g. `features/layered-merge.md`) as a style reference for the template structure.

### 4. Analyze the change

From the indexed diff (step 1 queries), extract:
- **What changed** — new files, modified files, deleted files (group by area).
- **Public surface** — new frontmatter fields, new CLI commands, new config keys, new public APIs.
- **Breaking changes** — any behavior that differs on upgrade.
- **Migration impact** — what existing users must do.

Do NOT read full diffs into context. Derive the summary in the sandbox.

### 5. Fill the template

Create or update `docs-vsixer/features/<name>.md` with this structure (omit sections that do not apply, but keep the headings that do):

```
# <Feature name>
**Status:** stable | experimental | draft
**Дата:** YYYY-MM-DD
**Branch:** <branch>
**Связанные:** <links to other features/*.md, or «—»>

## TL;DR
1–2 lines.

## Мотивация
Problem solved, why it matters.

## Поведение
How it works, with examples (frontmatter, commands, output).

## Расхождение с upstream
What diverges from upstream, why, with a before/after table.

## Usage / Configuration
How to use it.

## Migration
If breaking: what breaks, how to fix, escape hatches.

## Реализация
Key files and entry points.

## Open questions / future work
Deferred items.
```

Write in **Russian** for prose, **English** for code/identifiers/paths (matches existing fork docs).

### 6. Update the index

- `docs-vsixer/README.md` — add a link in the «Features» section: `- [features/<name>.md](features/<name>.md) — <one-line summary>. Status: <status>, <date>.`
- `docs-vsixer/CHANGELOG.md` — add an entry at the top (newest first): `## YYYY-MM-DD — <Feature name>` with branch, one-paragraph summary, and a link to the feature page.

### 7. Report

Print to the user:
- Path of the created/updated feature page.
- Paths of updated README/CHANGELOG.
- One-line summary of what was documented.

Do NOT commit (git-policy). Leave changes staged for the user to review and commit.

## Notes

- If the branch implements multiple unrelated features, ask the user whether to split into multiple pages or keep one.
- If `docs-vsixer/` does not exist yet, create the full structure (`README.md`, `CHANGELOG.md`, `setup/`, `features/`) using `docs-vsixer/README.md` as the index template.
- Provenance: prefer concrete file paths and line numbers over vague references.
- Use the «Расхождение с upstream» section to record every upstream file the feature touches — this is the conflict surface during future upstream syncs.
