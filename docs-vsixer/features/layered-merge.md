# Layered merge for commands / agents / skills

**Status:** stable
**Дата:** 2026-08-05
**Branch:** `global-local-merge`
**Связанные:** —

## TL;DR

When a project (`.opencode/`) definition collides by name with a global (`~/.config/opencode/`) one, the two are now **composed** instead of the local one fully replacing the global. The global definition acts as a reusable core that projects extend locally — deterministic, at config-load time, no runtime skill-adapter hooks.

## Мотивация

Before this feature, a name collision was winner-takes-all: the project body fully replaced the global body, and the global frontmatter was deep-merged via `remeda.mergeDeep`. There was no way for a project to *append* to a global command/agent body or to fill named slots in it without duplicating the entire definition.

The goal: give global commands/agents/skills a shared core that projects extend locally, without duplication and without probabilistic runtime skill-adapter composition.

## Поведение

### Merge strategy (`merge` frontmatter field, local file)

| Value | Body result |
|---|---|
| `append` (default) | global body → local body |
| `prepend` | local body → global body |
| `replace` | only local body (legacy winner-takes-all, opt-out) |

### Slots (HTML-comment markers, markdown body only)

Global declares an empty insertion point with a single marker:

```
<!-- slot: post-create -->
```

Local fills it with a paired block:

```
<!-- slot: post-create -->
…content…
<!-- /slot: post-create -->
```

- No default content in slots — an unfilled marker renders nothing.
- Local text **outside** fill blocks is «plain text», combined with the slot-filled global body per the `merge` strategy.
- Unknown slot (local references a name not declared in global) → load-time warning.
- Duplicate fill block for the same slot → warning + concatenation.
- v1: flat slots, no nesting.
- Same slot syntax for all three types: commands, agents, skills.

### Frontmatter merge policy

| Field kind | Policy |
|---|---|
| Scalars (`model`, `description`, `mode`, `temperature`, `steps`, …) | local-wins |
| Objects/arrays (`options`, `metadata`-like via rest-pocket, …) | wholesale local-wins (local replaces the whole value) |
| `permission` (agent) | **per-key override**: `{ ...global.permission, ...local.permission }`. Local wins per tool key; global-only keys survive. Sub-record (`permission.edit = {...}`) replaced wholesale per key. |

Formulated as: «shallow everywhere, except `permission` which is per-key union».

`permission` is a flat record keyed by tool name (`{ bash: "allow", edit: {...}, "*": "deny" }`), not an ordered rule list. Per-key override gives the «last matching rule wins» semantics the design wanted, on top of the actual data model.

### N-layer fold

`directories` can yield more than two entries (several project `.opencode/` up the tree + `~/.opencode` + `OPENCODE_CONFIG_DIR`). The fold composes them in order: each incoming layer's `merge` directive controls composition onto the accumulator; the accumulator declares slots for the incoming layer to fill.

### Skills: scope of merge

Layered merge applies **only** to opencode-configDir layers (global `.opencode` vs project `.opencode`). External skills (`.claude/`, `.agents/`), `skills.paths`, and `skills.urls` are imported as-is and applied last-write-wins on top of the folded opencode layers. The built-in `customize-opencode` skill is a base that any real file overrides.

### `description` for skills

Skill `description` is local-wins (scalar policy). This changes the auto-trigger keywords. Accepted for v1; an opt-in `description_merge: append` is deferred (see Open questions).

## Расхождение с upstream

| Upstream behavior | Fork behavior |
|---|---|
| `ConfigCommand.load` / `ConfigAgent.load` returned schema-decoded `Info` maps, merged across `directories` via `remeda.mergeDeep`. Body strings replaced wholesale (last dir wins). | Loaders return raw `Definition` (frontmatter + body + source) pre-decode. `config.ts` folds them via `ConfigMerge`, then decodes the final result once. |
| `skill/index.ts:add()` did last-write-wins over a flat match set, with a «duplicate skill name» warning on every collision. | Skill discovery builds per-layer maps; `foldEntries` composes opencode-configDir layers; external/paths/urls applied last-write-wins on top. Collisions inside opencode layers no longer warn (they merge by design). |
| No `merge` field; command frontmatter decoded via loose `Schema.decodeUnknownExit` (extra keys silently ignored). | `merge: optional(Literals(["append","prepend","replace"]))` added to `ConfigCommandV1.Info` and `ConfigAgentV1.Info`. Command decode stays lenient (extra keys like `reasoningEffort` still pass through). |
| No slot parser. | HTML-comment slot parser in `ConfigMerge`. |
| No inspector. | `opencode show-merged <type> <name>` CLI command. |

### Files changed/added

| File | Change |
|---|---|
| `packages/core/src/v1/config/merge.ts` | **new** — `ConfigMergeV1.Strategy` schema |
| `packages/core/src/v1/config/command.ts` | + `merge` field |
| `packages/core/src/v1/config/agent.ts` | + `merge` field, `merge` added to `KNOWN_KEYS` |
| `packages/opencode/src/config/parse.ts` | + lenient `ConfigParse.decode` (extra-keys pass through); `schema` = extra-check + `decode` |
| `packages/opencode/src/config/merge.ts` | **new** — `ConfigMerge`: slot parser, `compose`, `fold`, `foldEntries`, provenance |
| `packages/opencode/src/config/command.ts` | `load` returns raw `Definition` |
| `packages/opencode/src/config/agent.ts` | `load` / `loadMode` return raw `Definition` |
| `packages/opencode/src/config/config.ts` | layered fold + `decodeEntries`, warnings → `Effect.logWarning` |
| `packages/opencode/src/skill/index.ts` | skill discovery restructured to per-layer fold |
| `packages/opencode/src/cli/cmd/show-merged.ts` | **new** — inspector |
| `packages/opencode/src/index.ts` | register `ShowMergedCommand` |
| `packages/opencode/test/config/merge.test.ts` | **new** — 16 unit tests |

## Usage

### Frontmatter directives (local file)

```yaml
---
merge: append        # append (default) | prepend | replace
model: openai/gpt-5  # scalar: local-wins
permission:          # per-key union with global.permission
  edit: deny
---
```

### Slots

Global (`~/.config/opencode/commands/task/start.md`):

```
## Step 1. Create folder/task.md
…
<!-- slot: post-create -->
## Step 2. Summary
```

Project (`.opencode/command/task/start.md`):

```
---
model: openai/gpt-5.6-luna
---
<!-- slot: post-create -->
### Project extras
- call YouTrack
- init pointer
<!-- /slot: post-create -->
```

Result: global body with `post-create` filled, `model` from local (local-wins), `description` from global (local did not override).

### Inspector

```
opencode show-merged <command|agent|skill> <name>
```

Prints: strategy, winning source, frontmatter with per-key provenance (`[global]`/`[local]`/`[project]`), permission provenance (`global`/`local`/`overridden`), slot status (filled/unfilled/unknown), warnings, composed body.

## Migration

Big-bang, no shim. On upgrade, **all** existing name collisions start merging with `merge: append`. No files are auto-modified.

- `merge: replace` in the local file's frontmatter restores the legacy winner-takes-all behavior — the documented escape hatch.
- Known-impact collisions in this setup (skills, project environment — not in the fork repo itself):
  - `sql-guidelines` — global (MCP hard-guard, ~67 lines) vs MacroCRM-local (MySQL conventions, ~212 lines). Effectively two different skills under one name. **Recommended:** rename one or set `merge: replace` on the local file.
  - `db-deletion-guard` — global (hard guard on MCP) vs MacroCRM-local (soft-delete/UPDATE extension). Related but divergent — review the merged result and decide.
- Hidden breaking: `options`/object fields previously deep-merged via `remeda.mergeDeep` are now wholesale local-wins. Workaround: redefine the whole `options` object locally if key-level merge was relied upon.

## Реализация

Key entry points (see «Files changed/added» above for the full list):

- `packages/opencode/src/config/merge.ts` — `compose(global, local)`, `fold(layers)`, `foldEntries(layerMaps)`, slot parser (`findSlotMarkers`, `extractFills`).
- `packages/opencode/src/config/config.ts` — `loadInstanceState` builds `layered[]` then `foldEntries` + `decodeEntries`.
- `packages/opencode/src/skill/index.ts` — `discoverSkills` returns `opencodeLayers[]` + `plainMatches[]`; `loadSkills` folds opencode layers then applies plain.
- `packages/opencode/src/cli/cmd/show-merged.ts` — rescan + fold + render with provenance.

### Data flow (commands)

```
ConfigCommand.load(dir) → Record<name, Definition>   (per dir, raw frontmatter + body)
   ↓ accumulate into layered[] (with layer tag)
ConfigMerge.foldEntries(layers) → Record<name, Composed>   (frontmatter merged, body composed, provenance)
   ↓
decodeEntries(... ConfigParse.decode(ConfigCommandV1.Info, ...)) → Record<name, Info>   (one decode)
   ↓
mergeDeep(result.command, foldedCommands)   (json-config base from opencode.json, if any)
```

## Open questions / future work

- **`slots: [...]` frontmatter contract.** Optional declaration of slot names in the global file for validation/autocomplete. Deferred.
- **Warning on agent `mode` change.** If local changes `mode: subagent ↔ primary ↔ all` — load-time warning (affects orchestration). Deferred.
- **Third layer: references.** The N-layer fold already supports more than 2 layers; explicit `references` placement semantics are not wired yet.
- **`description_merge: append` for skills.** Currently `description` is local-wins, which changes auto-trigger keywords. An opt-in append mode is deferred.
- **Strip `merge` from runtime Info.** The `merge` directive currently survives decode into `config.command[name]` / `config.agent[name]` (harmless for runtime, slightly noisy in serialization). Could be stripped post-decode for cleanliness.
