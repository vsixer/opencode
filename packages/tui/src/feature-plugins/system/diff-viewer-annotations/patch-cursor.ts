import { parsePatchFileLines, type DiffFile, type PatchFileLine, type PatchSide } from "./patch-lines"

// Плоская модель навигации: видимые строки патчей всех файлов одним списком.
// Порядок совпадает с порядком рендера (строка патча = строка терминала при 1:1,
// см. jumpRelativeHunk в diff-viewer). Свёрнутое (singlePatch) содержимое не входит —
// список строится из visiblePatchFiles.

export type FlatPatchLine = PatchFileLine & {
  readonly fileIndex: number
  readonly lineIndex: number
  readonly filePath: string
  readonly fileStatus: DiffFile["status"]
}

export function buildFlatPatchLines(
  files: readonly { readonly file: DiffFile; readonly fileIndex: number }[],
): FlatPatchLine[] {
  return files.flatMap((entry) =>
    parsePatchFileLines(entry.file.patch).map((line, lineIndex) => ({
      ...line,
      fileIndex: entry.fileIndex,
      lineIndex,
      filePath: entry.file.file,
      fileStatus: entry.file.status,
    })),
  )
}

// Курсорная арифметика: движение с клампом на концах списка (FR-I4/I5).
export function clampCursor(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(length - 1, Math.max(0, index))
}

// Четверть экрана для quarter-скролла: минимум 1 ряд (FR-1).
export function quarterViewport(height: number): number {
  return Math.max(1, Math.round(height / 4))
}

// Оценка высоты строки в рядах терминала с учётом char-wrap. 1:1 без переноса;
// кратность длине колонки при переносе (риск R1: калибруется тестами, запас ±1 ряд
// в ensureVisible).
export function lineRows(text: string, wrapColumn: number): number {
  if (wrapColumn <= 0) return 1
  return Math.max(1, Math.ceil(text.length / wrapColumn))
}

// Тело патча: plus/minus/context (не служебная строка).
export function isBodyLine(line: Pick<PatchFileLine, "kind">): boolean {
  return line.kind !== "service"
}

// Первая контентная строка файла: первая body-строка файла в плоском списке.
// Файл без контентных строк (binary/заголовки) не даёт кандидата.
export function firstNavigableRowOfFile(lines: readonly FlatPatchLine[], fileIndex: number): number | undefined {
  const index = lines.findIndex((line) => line.fileIndex === fileIndex && isBodyLine(line))
  return index === -1 ? undefined : index
}

// Следующая контентная строка в направлении delta: служебные строки
// (заголовки файла/ханков) перескакиваются одним шагом.
export function nextNavigableIndex(
  lines: readonly FlatPatchLine[],
  from: number,
  delta: number,
): number | undefined {
  const step = delta < 0 ? -1 : 1
  for (let index = from + step; index >= 0 && index < lines.length; index += step) {
    if (isBodyLine(lines[index])) return index
  }
  return undefined
}

const kindRank = (line: Pick<PatchFileLine, "kind">) => (line.kind === "context" ? 0 : 1)

// Ближайшая контентная строка (FR-8.9, INV-2): тай-брейки на равной удалённости —
// изменённая > контекстной, ниже > выше. Сначала ищется в файле исходного индекса,
// затем в остальном списке (кламп начального курсора).
export function nearestNavigableIndex(lines: readonly FlatPatchLine[], index: number): number | undefined {
  const fileIndex = lines[clampCursor(index, lines.length)]?.fileIndex
  return nearestNavigableInFile(lines, index, fileIndex) ?? nearestNavigableInFile(lines, index, undefined)
}

function nearestNavigableInFile(
  lines: readonly FlatPatchLine[],
  index: number,
  fileIndex: number | undefined,
): number | undefined {
  let best: number | undefined
  let bestDistance = Infinity
  let bestRank = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fileIndex !== undefined && line.fileIndex !== fileIndex) continue
    if (!isBodyLine(line)) continue
    const distance = Math.abs(i - index)
    const rank = kindRank(line)
    // Итерация по возрастанию индекса: «ниже > выше» даёт замену на равных.
    if (distance <= bestDistance && (distance < bestDistance || rank >= bestRank)) {
      best = i
      bestDistance = distance
      bestRank = rank
    }
  }
  return best
}

// Предикат аннотируемости строки (чистая часть §10): тело ∧ файл не удалён целиком.
// Остальные условия (дифф загружен, фокус patches, строка свободна) — контекстные.
export function annotatableBodyLine(
  line: Pick<FlatPatchLine, "kind" | "fileStatus" | "lineNumber">,
): line is FlatPatchLine & { lineNumber: number } {
  return isBodyLine(line) && line.fileStatus !== "deleted" && line.lineNumber !== null
}

// Ряды unified-рендера до строки lineIndex: рендерер выводит только body-строки
// (заголовки файла/ханка и «\ No newline» ряда не занимают), поэтому счётчик
// идёт по телу с учётом char-wrap.
export function unifiedRowsBefore(lines: readonly PatchFileLine[], lineIndex: number, wrapColumn: number): number {
  let rows = 0
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    if (isBodyLine(lines[i])) rows += lineRows(lines[i].text, wrapColumn)
  }
  return rows
}

// Скролл, сохраняющий экранной позиции якорную строку: контентная координата
// минус экранный офсет якоря, зажатый в границы прокрутки.
export function anchorScrollTop(contentY: number, anchorOffset: number, viewportHeight: number, scrollHeight: number) {
  const maxScroll = Math.max(0, scrollHeight - viewportHeight)
  return Math.min(Math.max(0, contentY - anchorOffset), maxScroll)
}

// Колонка переноса unified-рендера: ширина узла <diff> минус гуттер
// (номерная колонка + знак строки).
export const NUMBER_COLUMNS = 6

export function unifiedWrapColumn(diffWidth: number): number {
  return Math.max(1, diffWidth - NUMBER_COLUMNS)
}
