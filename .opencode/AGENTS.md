# opencode fork — local development setup

This repository is a fork of `anomalyco/opencode` at `/home/vsixer/Projects/opencode`.
The official repository is configured as the `upstream` remote; `origin` points to the fork.

## Local builds: `ocl`, `ocl-dev`, `ocl-build`

Three shell aliases are defined in `~/.zshrc`. They point to locally-built binaries under `.ocl-builds/` (gitignored).

| Alias | Build channel | Database file | Purpose |
|---|---|---|---|
| `ocl` | `latest` | `~/.local/share/opencode/opencode.db` | Production build. Sees the user's real session history. Use for daily work and verification. |
| `ocl-dev` | `dev` (current git branch) | `~/.local/share/opencode/opencode-dev.db` | Dev build. Fully isolated from production data. Use for experiments and destructive changes. |
| `ocl-build` | — | — | Rebuilds both binaries from current source. |

Layout:

```
.ocl-builds/
  build.sh         # rebuild script (computes its own path; safe if repo moves)
  prod/opencode    # binary for `ocl`
  dev/opencode     # binary for `ocl-dev`
```

### Rebuild after code changes

```
ocl-build
```

Both binaries update in place. Aliases do not need to change. Takes ~2–3 minutes.

### Channel → database mapping (why two databases exist)

The channel is baked into the binary at build time via the `OPENCODE_CHANNEL` define (`packages/opencode/script/build.ts:198`). At runtime `packages/core/src/database/database.ts:43-55` picks the database file:

- Channels `latest`, `beta`, `prod` → `opencode.db`
- Any other channel (e.g. `dev`, branch name) → `opencode-<channel>.db`

To force any binary to use `opencode.db` regardless of its baked-in channel, set `OPENCODE_DISABLE_CHANNEL_DB=1`.

### Important

- Do not run experimental or destructive code paths via `ocl` — it shares the user's production database (`opencode.db`, ~18 GB of session history).
- Use `ocl-dev` for any change that might corrupt sessions or trigger destructive migrations.
- `ocl` and `ocl-dev` must never run at the same time against the same database file — both use SQLite WAL and concurrent access from two builds would corrupt it. Cross-channel isolation (different files) is safe; same-file concurrency is not.

## Upstream sync

```
git fetch upstream
git checkout dev
git merge upstream/dev
git push origin dev
```

As of 2026-08-03 the fork is a clean fast-forward from `upstream/dev` with no local commits, so merges should be conflict-free until local changes are introduced.

## Bun version

Root `package.json` pins `packageManager: "bun@1.3.14"`. Local Bun must satisfy that range or `packages/opencode/script/build.ts` aborts. Bun is installed globally via npm; upgrade with `npm install -g bun@<version>` (the built-in `bun upgrade` hangs on this machine).

## Paths are absolute

All paths in this file are absolute under `/home/vsixer/Projects/opencode`. If the repo is moved or this setup is replicated elsewhere, update the aliases in `~/.zshrc` to match. The `build.sh` script resolves its own location via `readlink -f`, so it does not need edits.
