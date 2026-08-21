import { existsSync } from "node:fs"
import path from "node:path"

// Выбор стороны diff-файла для открытия во внешнем редакторе: приоритет новой
// стороне (переименование → новый путь), затем старой, затем самому file;
// существование на диске — финальный арбитр (FR-7/FR-8).

export type EditableFile = { readonly path: string } | { readonly missing: true }

function headerPath(raw: string): string | undefined {
  // Git дописывает после пути таб и таймстамп — отрезаем.
  const target = raw.trim().slice(4).split("\t")[0]!.trim()
  if (target === "/dev/null") return undefined
  const unquoted = target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) return unquoted.slice(2) || undefined
  return unquoted || undefined
}

export function resolveEditableFile(input: {
  readonly file: string
  readonly patch?: string
  readonly cwd?: string
  readonly exists?: (path: string) => boolean
}): EditableFile {
  const exists =
    input.exists ?? ((candidate: string) => existsSync(path.resolve(input.cwd ?? process.cwd(), candidate)))
  let oldSide: string | undefined
  let newSide: string | undefined
  for (const raw of (input.patch ?? "").split("\n")) {
    // Заголовки сторон стоят до первого ханка; тело ханка не разбираем.
    if (raw.startsWith("@@")) break
    if (oldSide === undefined && raw.startsWith("--- ")) oldSide = headerPath(raw)
    if (newSide === undefined && raw.startsWith("+++ ")) newSide = headerPath(raw)
    if (oldSide !== undefined && newSide !== undefined) break
  }
  for (const candidate of [newSide, oldSide, input.file]) {
    if (candidate !== undefined && exists(candidate)) return { path: candidate }
  }
  return { missing: true }
}
