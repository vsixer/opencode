/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Локальный кэш для декодированных вложений. Идемпотентно по sha1(байты).
const ATTACHMENT_DIR = "/tmp/opencode/attachments"

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
}

type FilePart = {
  type: "file"
  mime: string
  filename?: string
  // data: URL или http(s) URL
  url: string
  source?: { path?: string; text?: { value?: string } }
}

// data:<mime>;base64,<payload>  |  data:<mime>,<urlencoded>
function parseDataURL(uri: string): { mime: string; bytes: Buffer } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri)
  if (!match) return
  const mime = match[1] || "application/octet-stream"
  const bytes = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8")
  return { mime, bytes }
}

function extFor(mime: string, name?: string): string {
  if (name) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, "")
    if (ext) return ext
  }
  return EXT_BY_MIME[mime] ?? "bin"
}

// data dir = $XDG_DATA_HOME/opencode (|| ~/.local/share/opencode), с учётом OPENCODE_DB.
function dataDir(): string {
  const override = process.env.OPENCODE_DB
  if (override && override !== ":memory:" && path.isAbsolute(override)) return path.dirname(override)
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode")
}

function candidateDbs(): string[] {
  const override = process.env.OPENCODE_DB
  if (override) {
    if (override === ":memory:") return []
    if (path.isAbsolute(override)) return [override]
    return [path.join(dataDir(), override)]
  }
  try {
    return readdirSync(dataDir())
      .filter((f) => /^opencode.*\.db$/.test(f))
      .map((f) => path.join(dataDir(), f))
  } catch {
    return []
  }
}

// Читаем file-parts последнего user-сообщения с вложениями напрямую из SQLite projection.
// Канал (stable/dev/...) заранее неизвестен — сканируем все opencode*.db и берём тот,
// где есть parts для этой сессии. Read-only, WAL-безопасно.
function findFileParts(sessionID: string): FilePart[] {
  for (const dbPath of candidateDbs()) {
    let db
    try {
      db = new Database(dbPath, { readonly: true })
    } catch {
      continue
    }
    try {
      const inThisDb = db.query("SELECT 1 FROM part WHERE session_id = ? LIMIT 1").get(sessionID)
      if (!inThisDb) continue
      // message_id последнего сообщения с file-part
      const latest = db.query(
        "SELECT message_id FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'file' ORDER BY time_created DESC LIMIT 1",
      ).get(sessionID) as { message_id: string } | undefined
      if (!latest?.message_id) continue
      const rows = db.query(
        "SELECT data FROM part WHERE session_id = ? AND message_id = ? AND json_extract(data, '$.type') = 'file' ORDER BY time_created ASC",
      ).all(sessionID, latest.message_id) as { data: string }[]
      return rows.map((r) => JSON.parse(r.data) as FilePart)
    } catch {
      continue
    } finally {
      db.close()
    }
  }
  return []
}

function pickParts(parts: FilePart[], args: { index?: number; name?: string; all?: boolean }) {
  if (args.all) return parts.map((part, i) => ({ part, index: i + 1 }))
  if (args.name) {
    const idx = parts.findIndex((p) => p.filename === args.name)
    if (idx === -1)
      throw new Error(
        `No attachment named "${args.name}" (available: ${parts.map((p) => p.filename).join(", ")})`,
      )
    return [{ part: parts[idx]!, index: idx + 1 }]
  }
  const index = args.index ?? 1
  if (index < 1 || index > parts.length) throw new Error(`index ${index} out of range (1..${parts.length})`)
  return [{ part: parts[index - 1]!, index }]
}

async function materialize(part: FilePart, index: number) {
  const mime = part.mime || "application/octet-stream"
  const name = part.filename ?? `attachment-${index}`

  // 1) Исходный файл всё ещё на диске — отдаём путь как есть, без копирования.
  const srcPath = part.source?.path
  if (srcPath && existsSync(srcPath)) {
    return { path: srcPath, mime, name, from: "source-path" }
  }

  // 2) http(s) URL — отдаём как есть (vision-тул примет URL).
  if (/^https?:\/\//.test(part.url)) {
    return { path: part.url, mime, name, from: "remote" }
  }

  // 3) data: URL — декодируем в temp-файл, идемпотентно по хэшу.
  const parsed = parseDataURL(part.url)
  if (!parsed) throw new Error("Unsupported attachment url (expected data: or http:)")
  const hash = createHash("sha1").update(parsed.bytes).digest("hex").slice(0, 16)
  const outPath = path.join(ATTACHMENT_DIR, `${hash}.${extFor(mime, name)}`)
  await mkdir(ATTACHMENT_DIR, { recursive: true })
  await writeFile(outPath, parsed.bytes)
  return { path: outPath, mime, name, from: "decoded" }
}

export default tool({
  description: `Materialize an inline prompt attachment (image/PDF/SVG pasted or attached in the chat) into a real on-disk file path and return it.

WHEN TO CALL: when the user references an attached image or file that you cannot see — a \`[Image N]\` marker in their message, a "model does not support image input" error, or any request to read/analyze a pasted screenshot/attachment. The attachment bytes live inline in the session storage and are NOT on disk (from your point of view), so you and any file/URL-based tool cannot reach them directly.

WHAT YOU GET BACK: an absolute file path — either the original source path (if the file the user attached still exists on disk, e.g. a WSL/Windows path), or a freshly written copy under \`/tmp/opencode/attachments/\`, or an http URL for remote attachments.

NEXT STEP: pass that path to a vision-capable tool, e.g. zai-mcp-server_extract_text_from_screenshot (for text in the image), zai-mcp-server_analyze_image, zai-mcp-server_diagnose_error_screenshot, etc. Do NOT try to return the image to the model as media — the whole point is to route it through a vision tool.

The \`index\` argument is 1-based and matches the \`N\` in \`[Image N]\` within the latest user message. Use \`all: true\` to dump every attachment from that message. Implementation note: reads the session \`part\` projection read-only from the local SQLite DB (channel-agnostic — scans all \`opencode*.db\`), so it works in every run mode (TUI/CLI/ACP) without a network port.`,
  args: {
    index: tool.schema.number().optional().describe("1-based attachment index within the latest user message; matches [Image N]. Defaults to 1."),
    name: tool.schema.string().optional().describe("Select by original filename instead of index."),
    all: tool.schema
      .boolean()
      .optional()
      .describe("Materialize every attachment from the latest user message and return all paths."),
  },
  async execute(args, context) {
    const parts = findFileParts(context.sessionID)
    if (parts.length === 0) {
      return "No file/image attachments found in the latest user message of this session."
    }

    const picked = pickParts(parts, args)
    const results = []
    for (const { part, index } of picked) {
      const out = await materialize(part, index)
      results.push({ ...out, index, total: parts.length })
    }

    const lines = results.map(
      (r) => `[${r.index}/${r.total}] ${r.path}  (mime=${r.mime}, name=${JSON.stringify(r.name)}, source=${r.from})`,
    )
    const output =
      `Materialized ${results.length} attachment(s) from the latest user message:\n` +
      lines.join("\n") +
      `\n\nPass the path(s) above to a vision tool (e.g. zai-mcp-server_extract_text_from_screenshot).`

    return {
      title: `materialized ${results.length} attachment(s)`,
      output,
      metadata: { attachments: results },
    }
  },
})
