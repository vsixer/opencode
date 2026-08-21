import type { PatchFileLine, PatchLineKind } from "./patch-lines"

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// Body-строка файла с номерами ОБЕИХ сторон: minus/context имеют old-номер,
// plus/context — new-номер (контекст — оба). lineIndex — индекс строки в патче,
// bodyIndex — сквозной индекс body-строки (service-строки пропущены) = ряд рендера
// в unified-режиме; ключ красит все визуальные ряды переноса (AC-3).
export type BodyLineEntry = {
  readonly kind: PatchLineKind
  readonly lineIndex: number
  readonly bodyIndex: number
  readonly oldNumber: number | null
  readonly newNumber: number | null
}

// Разбор тела патча файла: сквозные body-индексы + номера old/new по ханкам.
// Заголовки ханков дают стартовые номера сторон; инкременты повторяют логику
// patch-lines (минус двигает old, плюс — new, контекст — оба).
export function buildBodyLineMap(lines: readonly PatchFileLine[]): BodyLineEntry[] {
  const entries: BodyLineEntry[] = []
  let oldStart = 0
  let newStart = 0
  let oldCount = 0
  let newCount = 0
  let inHunk = false
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (line.kind !== "service" && inHunk) {
      const oldNumber = line.kind === "minus" || line.kind === "context" ? oldStart + oldCount : null
      const newNumber = line.kind === "plus" || line.kind === "context" ? newStart + newCount : null
      if (line.kind === "minus" || line.kind === "context") oldCount++
      if (line.kind === "plus" || line.kind === "context") newCount++
      entries.push({ kind: line.kind, lineIndex, bodyIndex: entries.length, oldNumber, newNumber })
      continue
    }
    const header = line.kind === "service" ? HUNK_HEADER.exec(line.text) : null
    if (header) {
      oldStart = Number(header[1])
      newStart = Number(header[2])
      oldCount = 0
      newCount = 0
      inHunk = true
    }
  }
  return entries
}

// Инверсия карты стороны рендерера (finalIndex → номер строки) в номер → finalIndex.
// Номера строго возрастают в пределах стороны файла, инверсия однозначна.
export function invertLineNumbers(numbers: ReadonlyMap<number, number>): Map<number, number> {
  const inverted = new Map<number, number>()
  for (const [finalIndex, lineNum] of numbers) inverted.set(lineNum, finalIndex)
  return inverted
}

export type SplitRow = { readonly left?: number; readonly right?: number }

// Split-резолвция ряда: minus → левая сторона по old-номеру, plus → правая по new,
// контекст → обе стороны. Отсутствующий номер/пустая карта → undefined без фоллбэка
// на соседнюю сторону (filler/empty после wrap-выравнивания ряда не имеют).
export function resolveSplitRow(
  entry: Pick<BodyLineEntry, "kind" | "oldNumber" | "newNumber">,
  left: ReadonlyMap<number, number>,
  right: ReadonlyMap<number, number>,
): SplitRow | undefined {
  if (entry.kind === "minus") {
    const row = entry.oldNumber === null ? undefined : left.get(entry.oldNumber)
    return row === undefined ? undefined : { left: row }
  }
  if (entry.kind === "plus") {
    const row = entry.newNumber === null ? undefined : right.get(entry.newNumber)
    return row === undefined ? undefined : { right: row }
  }
  if (entry.kind !== "context") return undefined
  const leftRow = entry.oldNumber === null ? undefined : left.get(entry.oldNumber)
  const rightRow = entry.newNumber === null ? undefined : right.get(entry.newNumber)
  if (leftRow === undefined && rightRow === undefined) return undefined
  return { left: leftRow, right: rightRow }
}
