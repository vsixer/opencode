# Build aliases: `oc`, `oc-dev`, `oc-build`, `oc-local`

Shell aliases defined in `~/.zshrc`. They point to locally-built binaries under `.ocl-builds/` (gitignored).

| Alias | Build channel | Database file | Purpose |
|---|---|---|---|
| `oc` | `latest` | `~/.local/share/opencode/opencode.db` | Production fork build (alias repurposed from upstream opencode; upstream has no plain alias now). |
| `oc-dev` | `dev` (current git branch) | `~/.local/share/opencode/opencode-dev.db` | Dev build. Fully isolated from production data. Use for experiments and destructive changes. |
| `oc-build` | — | — | Rebuilds both binaries from current source. |
| `oc-local` | `latest` | `~/.local/share/opencode/opencode.db` | Fork fully on the local LLM: `OPENCODE_AGENT_MODELS` → `~/.config/opencode/config/agent-models-local.jsonc` (every registry role, including `builtin:*` built-in agents, → `freetoken/nvidia/Qwen3.6-35B-A3B-NVFP4`). Note: the overlay `agent-models.disabled.jsonc` is shared per directory, so it applies to both registry files. |

Layout:

```
.ocl-builds/
  build.sh         # rebuild script (computes its own path; safe if repo moves)
  prod/opencode    # binary for `oc`
  dev/opencode     # binary for `oc-dev`
```

## Rebuild after code changes

```
oc-build
```

Both binaries update in place. Aliases do not need to change. Takes ~2–3 minutes.

## Version scheme

The baked-in version is **npm `opencode-ai@latest` + `+vsixer`** (e.g. `1.18.15+vsixer`), derived in `build.sh` via `fork_version()`. This differs from the upstream builder, which for the `latest` channel fetches npm latest and bumps `patch + 1` (`packages/script/src/index.ts`).

Why `+vsixer` (semver build metadata) and not `-vsixer` (prerelease):

- `+vsixer` keeps `semver.satisfies` returning `true` for caret ranges, so plugin compatibility checks (`checkPluginCompatibility`) still pass.
- `1.18.15+vsixer` compares **equal** to `1.18.15` in semver — no false «update available» notification.
- `-vsixer` (prerelease) compares **lower** than `1.18.15`, which breaks both behaviors.

Offline fallback: if the npm registry is unreachable, the version falls back to `packages/opencode/package.json` version + `+vsixer`.

## Channel → database mapping (why two databases exist)

The channel is baked into the binary at build time via the `OPENCODE_CHANNEL` define (`packages/opencode/script/build.ts:198`). At runtime `packages/core/src/database/database.ts:43-55` picks the database file:

- Channels `latest`, `beta`, `prod` → `opencode.db`
- Any other channel (e.g. `dev`, branch name) → `opencode-<channel>.db`

To force any binary to use `opencode.db` regardless of its baked-in channel, set `OPENCODE_DISABLE_CHANNEL_DB=1`.

## Important

- Do not run experimental or destructive code paths via `oc` — it shares the user's production database (`opencode.db`, ~18 GB of session history).
- Use `oc-dev` for any change that might corrupt sessions or trigger destructive migrations.
- `oc` and `oc-dev` must never run at the same time against the same database file — both use SQLite WAL and concurrent access from two builds would corrupt it. Cross-channel isolation (different files) is safe; same-file concurrency is not.

## Bun version

Root `package.json` pins `packageManager: "bun@1.3.14"`. Local Bun must satisfy that range or `packages/opencode/script/build.ts` aborts. Bun is installed globally via npm; upgrade with `npm install -g bun@<version>` (the built-in `bun upgrade` hangs on this machine).

## Paths are absolute

All paths in fork documentation are absolute under `/home/vsixer/Projects/opencode`. If the repo is moved or this setup is replicated elsewhere, update the aliases in `~/.zshrc` to match. The `build.sh` script resolves its own location via `readlink -f`, so it does not need edits.
