// Модель строк патча: классификация строк (тело/служебные), стороны (старая/новая),
// side-последовательности для валидации якорей против отображаемого снапшота.

export type PatchSide = "new" | "old"
export type PatchLineKind = "plus" | "minus" | "context" | "service"

export type DiffFile = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

// Строка патча одного файла. lineNumber — номер в соответствующей стороне файла
// (FR-N2: minus → старая версия, plus/context → новая); null у служебных строк.
// hunk — 1-базирующийся индекс ханка; null для строк вне ханков (заголовки файла).
export type PatchFileLine = {
  readonly kind: PatchLineKind
  readonly side: PatchSide
  readonly lineNumber: number | null
  readonly hunk: number | null
  readonly text: string
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// Разбор unified-патча файла в последовательность строк. Строки вне ханков считаются
// служебными (заголовки diff --git / index / --- / +++ / new file mode и т.п.); внутри
// ханков служебными остаются только маркеры «\ No newline». Пустой/отсутствующий патч → [].
export function parsePatchFileLines(patch: string | undefined): PatchFileLine[] {
  if (!patch) return []
  const out: PatchFileLine[] = []
  let hunk = 0
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      hunk++
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
      out.push({ kind: "service", side: "new", lineNumber: null, hunk, text: raw })
      continue
    }
    if (!inHunk || raw.startsWith("\\")) {
      out.push({ kind: "service", side: "new", lineNumber: null, hunk: inHunk ? hunk : null, text: raw })
      continue
    }
    const prefix = raw[0] ?? " "
    const text = raw.slice(1)
    if (prefix === "+") {
      out.push({ kind: "plus", side: "new", lineNumber: newLine++, hunk, text })
    } else if (prefix === "-") {
      out.push({ kind: "minus", side: "old", lineNumber: oldLine++, hunk, text })
    } else {
      // Контекст: « »-префикс или пустая строка; идентификация — по новой версии (FR-N2).
      out.push({ kind: "context", side: "new", lineNumber: newLine, hunk, text })
      oldLine++
      newLine++
    }
  }
  return out
}

// Строка стороны файла с номером и ханком — вход перепривязки якорей.
export type SideLine = { readonly lineNumber: number; readonly text: string; readonly hunk: number }

// Side-последовательность файла: старая сторона = minus + контекст, новая = plus + контекст.
// Файл status:"deleted" не имеет plus-строк → новая сторона пуста (целей для привязки нет).
export function sideLines(lines: readonly PatchFileLine[], side: PatchSide): SideLine[] {
  return lines.flatMap((line) => {
    if (line.kind === "service" || line.lineNumber === null || line.hunk === null) return []
    const belongs =
      side === "old" ? line.kind === "minus" || line.kind === "context" : line.kind === "plus" || line.kind === "context"
    if (!belongs) return []
    return [{ lineNumber: line.lineNumber, text: line.text, hunk: line.hunk }]
  })
}

// Окно отпечатка: K строк той же стороны выше + якорь + K ниже, строго в пределах ханка
// (у границ ханка окно обрезается). Возвращает тексты окна и позицию якоря в нём;
// пустой массив текстов — якорь не найден в этой стороне.
export function buildSideWindow(
  lines: readonly PatchFileLine[],
  side: PatchSide,
  lineNumber: number,
  hunk: number,
  k: number,
): { texts: string[]; anchorOffset: number } {
  const sequence = sideLines(lines, side)
  const anchor = sequence.findIndex((line) => line.hunk === hunk && line.lineNumber === lineNumber)
  if (anchor === -1) return { texts: [], anchorOffset: 0 }
  let start = anchor
  while (start > 0 && anchor - start < k && sequence[start - 1].hunk === hunk) start--
  let end = anchor + 1
  while (end < sequence.length && end - anchor <= k && sequence[end].hunk === hunk) end++
  return { texts: sequence.slice(start, end).map((line) => line.text), anchorOffset: anchor - start }
}
