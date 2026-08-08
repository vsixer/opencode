# materialize-attachment tool

**Status:** stable
**Дата:** 2026-08-08
**Branch:** —
**Связанные:** `zai-mcp-server` vision tools

## TL;DR

A custom opencode tool (`.opencode/tool/materialize-attachment.ts`) that turns an inline prompt attachment (a pasted/attached image, PDF, or SVG) into a real file on disk and returns its path. This bridges the gap that prevents non-vision models from working with attachments: the bytes live only as an inline `data:` URL inside the session message, invisible to the model and unreachable by file/URL-based vision tools.

## Мотивация

When a user attaches an image in the TUI:

1. `packages/tui/src/component/prompt/local-attachment.ts` reads the file bytes and converts them to a `data:image/png;base64,…` URL.
2. The attachment is stored on the `User` message as `FileAttachment.uri` (`packages/schema/src/prompt.ts`) — a `data:` URL. The original filesystem path is discarded.
3. `to-llm-message.ts` turns it into a `{type:"media", data}` content part and sends it to the provider.

For a model without vision support, the provider rejects the image (`model does not support image input`), and the agent has no way to recover: the bytes are not on disk, so file/URL-based vision tools (`zai-mcp-server_extract_text_from_screenshot`, `zai-mcp-server_analyze_image`, …) cannot read them. There was no built-in `data URL → file` bridge.

The goal: let any agent materialize the current session's latest attachment to a deterministic temp path in one tool call, then route that path to a vision tool — without editing any upstream-owned package.

## Поведение

The tool is registered as `materialize-attachment` (enabled in `.opencode/opencode.jsonc`). When the agent calls it:

1. Resolves the opencode data dir (`$XDG_DATA_HOME/opencode` || `~/.local/share/opencode`, honoring an absolute `OPENCODE_DB` override).
2. Opens each `opencode*.db` **read-only** with `bun:sqlite` (WAL-safe alongside the live writer) and finds the one holding parts for `sessionID`. Channel-agnostic — works regardless of `stable`/`dev`/custom-channel DB naming.
3. In the `part` table, finds the latest `message_id` with a `type: "file"` part, then reads all file parts of that message ordered by creation time.
4. Selects the attachment by `index` (1-based, matches the `[Image N]` marker the TUI injects), by `name`, or `all`.
5. Materializes each selected part in priority order:
   - **`source.path` still on disk** → return that path directly (zero copy). This is the common case when the user attached a real file (e.g. a WSL `/mnt/d/...` path).
   - **`http(s)` url** → return as-is (vision tools accept URLs).
   - **`data:` URL** → decode bytes, write to `/tmp/opencode/attachments/<sha1-16>.<ext>` (idempotent by content hash), return that path.
6. Returns the absolute path (+ mime, original name, index/total, provenance `source-path`/`remote`/`decoded`).

### Why SQLite-direct and not the HTTP API

The opencode HTTP server is **not always bound to a TCP port**: in TUI mode the frontend talks to the server in-process via the worker's `app.fetch` RPC proxy (`packages/opencode/src/cli/tui/worker.ts`), so a `fetch(localhost:PORT)` call from a custom tool would have no port to hit. A custom tool under `.opencode/tool/` also cannot `import @opencode-ai/opencode/server/server` (the package is not in `.opencode/node_modules`). Reading the `part` projection read-only from the local SQLite DB sidesteps both problems and works in every run mode (TUI / CLI / ACP).

### Аргументы

| Arg | Type | Default | Meaning |
|---|---|---|---|
| `index` | number? | 1 | 1-based attachment index; matches `[Image N]`. |
| `name` | string? | — | Select by original filename instead of index. |
| `all` | boolean? | — | Materialize every attachment from the latest user message. |

### Agent signal (no admission-time change)

The tool's `description` teaches the agent to call it when it sees a `[Image N]` marker, a vision-unsupported error, or any request to read a pasted screenshot. The TUI already injects `[Image N]` virtual text into the user message (`packages/tui/src/component/prompt/index.tsx`), so the marker reaches the model as part of `User.text`. The agent then chains: `materialize-attachment` → path → `zai-mcp-server_*`.

## Расхождение с upstream

| Upstream behavior | Fork behavior |
|---|---|
| No `data URL → file` bridge. Inline attachments are unreachable by file/URL-based tools; non-vision models cannot recover from a vision-unsupported error. | Custom `materialize-attachment` tool exposed via `.opencode/tool/` exposes the attachment bytes at a temp path. |

### Files changed/added

| File | Change |
|---|---|
| `.opencode/tool/materialize-attachment.ts` | **new** — the tool |
| `.opencode/opencode.jsonc` | enable the tool (`materialize-attachment: true`) |
| `docs-vsixer/features/materialize-attachment.md` | **new** — this page |

No `packages/**` files are modified — the feature is entirely fork-local, so `git merge upstream/dev` stays conflict-free for this change.

## Usage

Typical chain (model without vision, user pastes a screenshot and asks "read the text"):

```
agent:  materialize-attachment({ index: 1 })
  ->   /tmp/opencode/attachments/a3f9c1d8e7b2.png
agent:  zai-mcp-server_extract_text_from_screenshot({ image_source: "/tmp/opencode/attachments/a3f9c1d8e7b2.png", ... })
  ->   recognized text
```

## Реализация

- Data access: read-only `bun:sqlite` over the local `opencode*.db` projection. Channel-agnostic DB discovery (scans all `opencode*.db` in the data dir, honors `OPENCODE_DB`). No network port, no auth, no `@opencode-ai/opencode` import — the tool only needs `@opencode-ai/plugin` (already in `.opencode/node_modules`) and Bun built-ins.
- Source-path preference: a `file` part carries `source.path` (the file the user actually attached). If it still exists on disk, the tool returns it directly — no copy, no decode. This covers the WSL/Windows-attach case (e.g. `/mnt/d/Pictures/Temp/...png`).
- Idempotency (decode path): output filename is `sha1(bytes)[:16] + ext`, so repeated calls for the same attachment return the same path without re-writing.
- MIME → extension map covers png/jpeg/gif/webp/avif/svg/pdf; unknown MIME falls back to `bin`; an explicit `filename` extension wins.
- `[Image N]` mapping: the latest message_id with a `file` part is selected, and `index` is 1-based within that message in creation order — matching the marker the TUI inserts into `User.text`.

## Граничные случаи

- **Clipboard paste with no filename**: synthesizes `attachment-<index>.<ext>`; `source.path` is absent so the `data:` URL is decoded to a temp file.
- **Original file no longer on disk**: falls through to decoding the inline `data:` URL (the bytes are always retained in the `part` projection).
- **Remote attachments** (`http(s)`): returned as-is.
- **Multiple images in one message**: `all: true` returns every path; `index` selects within the latest message.
- **Node-only run** (non-Bun): the tool uses `bun:sqlite`; the fork's `ocl`/`ocl-dev` run on Bun, so this is not hit in practice. A `better-sqlite3` fallback can be added if a Node entrypoint is introduced.

## Open questions / future work

- Auto-inject a system hint at prompt admission so the agent learns the path proactively (would require an upstream edit in `SessionV2.prompt` admission; intentionally deferred to keep the change fork-safe).
- Optional caching of materialized paths on the message itself to avoid repeated decoding across turns.
