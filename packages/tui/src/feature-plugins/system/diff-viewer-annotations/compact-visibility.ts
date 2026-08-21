import { parsePatchFileLines, type PatchFileLine } from "./patch-lines"

// Компактный режим (FR-8.3/8.4): маска видимости строк файла и трансформация
// patch-текста. Изменённые и служебные строки всегда видимы; контекст видим
// в окне ±COMPACT_CONTEXT_RADIUS от изменённой строки — окна, разделённые
// меньшим промежутком, объединяются без «дыр».

export const COMPACT_CONTEXT_RADIUS = 2

export function compactVisibilityMask(lines: readonly PatchFileLine[]): boolean[] {
  const changed = lines.map((line) => line.kind === "plus" || line.kind === "minus")
  return lines.map((line, index) => {
    if (line.kind !== "context") return true
    for (let distance = 1; distance <= COMPACT_CONTEXT_RADIUS; distance++) {
      if (changed[index - distance] || changed[index + distance]) return true
    }
    return false
  })
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

// Трансформация patch-текста под маску. Скрытые строки вырезаются, а ханки
// дробятся на суб-ханки с пересчитанными заголовками: нумерация сторон каждой
// оставшейся строки сохраняется точной, иначе рендерер и модель якорей разъедутся.
export function compactPatchText(patch: string | undefined): string | undefined {
  if (!patch) return patch
  const parsed = parsePatchFileLines(patch)
  const mask = compactVisibilityMask(parsed)
  if (mask.every(Boolean)) return patch
  const raw = patch.split("\n")
  const out: string[] = []
  let index = 0
  while (index < raw.length) {
    const header = HUNK_HEADER.exec(raw[index])
    if (!header) {
      out.push(raw[index])
      index++
      continue
    }
    const suffix = header[3] ?? ""
    let oldStart = Number(header[1])
    let newStart = Number(header[2])
    let oldCount = 0
    let newCount = 0
    index++
    let subLines: string[] = []
    let subOldStart = 0
    let subNewStart = 0
    let subOldCount = 0
    let subNewCount = 0
    let subOpen = false
    const flushSub = () => {
      if (subLines.length === 0) return
      out.push(`@@ -${subOldStart},${subOldCount} +${subNewStart},${subNewCount} @@${suffix}`)
      out.push(...subLines)
      subLines = []
      subOpen = false
    }
    while (index < raw.length && !HUNK_HEADER.test(raw[index])) {
      const line = parsed[index]
      if (!line || line.kind === "service") {
        // «\ No newline» относится к предыдущей строке: остаётся в её суб-ханке.
        if (subOpen) subLines.push(raw[index])
        else out.push(raw[index])
        index++
        continue
      }
      if (!mask[index]) {
        // Скрытая строка двигает только сквозные счётчики ханка.
        if (line.kind === "minus") oldCount++
        else if (line.kind === "plus") newCount++
        else {
          oldCount++
          newCount++
        }
        index++
        continue
      }
      // Непрерывность нумерации внутри открытого суб-ханка: рендерер считает
      // строки последовательно от заголовка суб-ханка, поэтому ожидаемые номера —
      // только из уже испущенных строк этого суб-ханка.
      const fits =
        line.kind === "minus"
          ? line.lineNumber === subOldStart + subOldCount
          : line.kind === "plus"
            ? line.lineNumber === subNewStart + subNewCount
            : line.lineNumber === subNewStart + subNewCount &&
              line.lineNumber - (newStart + newCount - (oldStart + oldCount)) === subOldStart + subOldCount
      if (subOpen && !fits) flushSub()
      if (!subOpen) {
        subOldStart = oldStart + oldCount
        subNewStart = newStart + newCount
        subOldCount = 0
        subNewCount = 0
        subOpen = true
      }
      subLines.push(raw[index])
      if (line.kind === "minus") {
        subOldCount++
        oldCount++
      } else if (line.kind === "plus") {
        subNewCount++
        newCount++
      } else {
        subOldCount++
        subNewCount++
        oldCount++
        newCount++
      }
      index++
    }
    flushSub()
  }
  return out.join("\n")
}
