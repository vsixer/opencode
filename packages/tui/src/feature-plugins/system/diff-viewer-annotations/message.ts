import type { DiffFile, PatchSide } from "./patch-lines"

// Входная модель аннотации для сборки исходящего сообщения. originLine — номер строки на
// момент создания (якорь сниппета); line — текущий после перепривязки; для unbound
// совпадает с originLine.
export type MessageAnnotation = {
  readonly filePath: string
  readonly side: PatchSide
  readonly originLine: number
  readonly line: number
  readonly hunk: number | null
  readonly window: readonly string[]
  readonly anchorOffset: number
  readonly text: string
  readonly bound: boolean
}

// Сниппет окна с маркером якорной строки (">") — по зафиксированной позиции якоря.
function formatSnippet(window: readonly string[], anchorOffset: number): string {
  return window.map((line, i) => `  ${i === anchorOffset ? ">" : " "} ${line}`).join("\n")
}

function sideLabel(side: PatchSide): string {
  return side === "old" ? "старая" : "новая"
}

// Чистая сборка единого сообщения (FR-P3/P4/P5). Привязанные — группировка файл →
// ханк → строка, запись = путь + номер строки (сторона по FR-N2) + сниппет + текст.
// Непривязанные — отдельный помеченный блок со снимком создания. Пустой массив → "".
// Молчаливое отбрасывание и блокировка отправки запрещены.
export function assembleMessage(annotations: readonly MessageAnnotation[], files: readonly DiffFile[]): string {
  if (annotations.length === 0) return ""

  const bound = annotations.filter((a) => a.bound)
  const unbound = annotations.filter((a) => !a.bound)

  const sections: string[] = [`Замечания по diff (${annotations.length})`, ""]

  const byFile = new Map<string, MessageAnnotation[]>()
  for (const a of bound) {
    const list = byFile.get(a.filePath) ?? []
    list.push(a)
    byFile.set(a.filePath, list)
  }
  for (const file of [...byFile.keys()].sort()) {
    for (const a of (byFile.get(file) ?? []).sort((x, y) => (x.hunk ?? 0) - (y.hunk ?? 0) || x.line - y.line)) {
      const where =
        a.hunk !== null ? `(hunk #${a.hunk}, ${sideLabel(a.side)} строка ${a.line})` : `(${sideLabel(a.side)} строка ${a.line})`
      sections.push(`## ${file} ${where}`, "")
      sections.push(formatSnippet(a.window, a.anchorOffset), "")
      sections.push(`Замечание: ${a.text}`, "")
    }
  }

  if (unbound.length > 0) {
    sections.push("## Не удалось надёжно привязать к строке", "")
    for (const a of unbound) {
      sections.push(a.filePath, "")
      sections.push("Исходный снимок строк на момент создания:", "")
      for (const line of a.window) sections.push(`  ${line}`)
      sections.push("", `Замечание: ${a.text}`, "")
    }
  }

  return sections
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
