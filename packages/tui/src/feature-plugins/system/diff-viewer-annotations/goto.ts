// Goto-строка (FR-4.x): чистая машина состояний ввода номера и разрешение цели.
// Буфер — строка набранных цифр; undefined — режим неактивен.

export type GotoBuffer = string | undefined

export type GotoEvent =
  | { readonly kind: "digit"; readonly digit: string }
  | { readonly kind: "enter" }
  | { readonly kind: "escape" }
  | { readonly kind: "backspace" }
  | { readonly kind: "tab" }
  | { readonly kind: "command" }

export type GotoResult = {
  readonly buffer: GotoBuffer
  // consumed — поглощать ли клавишу: командные клавиши отменяют ввод и глотаются,
  // Tab отменяет без поглощения (FR-4.8/4.9).
  readonly consumed: boolean
  // committed — номер, зафиксированный Enter; пустой буфер = тихое завершение.
  readonly committed: number | undefined
}

// Потолок длины защищает от бессмысленного ввода и переполнения number.
const MAX_DIGITS = 7

export function gotoTransition(buffer: GotoBuffer, event: GotoEvent): GotoResult {
  if (buffer === undefined) {
    if (event.kind === "digit") return { buffer: event.digit, consumed: true, committed: undefined }
    return { buffer: undefined, consumed: false, committed: undefined }
  }
  switch (event.kind) {
    case "digit":
      if (buffer.length >= MAX_DIGITS) return { buffer, consumed: true, committed: undefined }
      return { buffer: buffer + event.digit, consumed: true, committed: undefined }
    case "enter":
      return { buffer: undefined, consumed: true, committed: parseGotoNumber(buffer) }
    case "escape":
    case "command":
      return { buffer: undefined, consumed: true, committed: undefined }
    case "tab":
      return { buffer: undefined, consumed: false, committed: undefined }
    case "backspace":
      return { buffer: buffer.length <= 1 ? undefined : buffer.slice(0, -1), consumed: true, committed: undefined }
  }
}

export function parseGotoNumber(buffer: string): number | undefined {
  if (buffer.length === 0) return undefined
  return Number(buffer)
}

// Цель goto-файла: 1-based номер против плоского списка файлов диффа.
// Возвращает 0-based индекс файла; 0, выход за диапазон и пустой ввод —
// невалидны (тихий сброс без смены состояния).
export function gotoFileTarget(number: number | undefined, fileCount: number): number | undefined {
  if (number === undefined || number < 1 || number > fileCount) return undefined
  return number - 1
}

// Цель перехода: строка новой стороны текущего файла с точным номером
// (FR-4.2/4.3); старые номера, чужие файлы и строки между ханками не матчатся.
export function gotoTargetIndex(
  lines: readonly { readonly fileIndex: number; readonly side: string; readonly lineNumber: number | null }[],
  fileIndex: number,
  target: number,
): number {
  return lines.findIndex(
    (line) => line.fileIndex === fileIndex && line.side === "new" && line.lineNumber === target,
  )
}
