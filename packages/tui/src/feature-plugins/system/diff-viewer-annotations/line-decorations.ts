// Snapshot-merge движок цветовых декораций поверх DiffRenderable (план §3.2).
// Рендерер непрозрачен по wrap-геометрии, поэтому декорации применяются через
// собственный per-line API сторон (LineNumberRenderable) с сохранением pristine-карт.

// Форма карт стороны: два раздельных_live-карты gutter/content (как их хранит
// рендерер); значения — распарсенные RGBA.
export type LineColorForm = {
  gutter: Map<number, unknown>
  content: Map<number, unknown>
}

// Конфиг записи для setLineColors: оба поля заполняются всегда (ловушка
// parseLineColor: {gutter} без content превращается в darken(gutter)).
export type LineColorConfig = { gutter?: unknown; content?: unknown }

// Структурный мост к сторонам рендерера: поля публичны в рантайме, private только
// в d.ts (версия @opentui/core зафиксирована). Стороны появляются асинхронно
// (rebuild) — отсутствие трактуется как «пока нет», а не как ошибка.
export type SideLike = {
  setLineColors: (map: Map<number, LineColorConfig>) => void
  getLineColors: () => LineColorForm
  getLineNumbers: () => Map<number, number>
}

// Левая сторона обязательна, правая опциональна: в unified-режиме rightSide
// откреплена от дерева и может отсутствовать вовсе — декорации unified
// применяются только к левой.
export function diffSides(node: unknown): { left: SideLike; right?: SideLike } | undefined {
  const bridge = node as { leftSide?: unknown; rightSide?: unknown } | null
  if (!bridge || !isSideLike(bridge.leftSide)) return undefined
  const right = isSideLike(bridge.rightSide) ? bridge.rightSide : undefined
  return { left: bridge.leftSide, right }
}

function isSideLike(value: unknown): value is SideLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SideLike).setLineColors === "function" &&
    typeof (value as SideLike).getLineColors === "function" &&
    typeof (value as SideLike).getLineNumbers === "function"
  )
}

let sidesWarned = false

// Однократный warn при окончательном провале feature-detection (после ретраев):
// декорации полностью ОТКЛЮЧАЮТСЯ, частичная деградация через публичный
// node.setLineColors запрещена (replace-семантика стёрла бы дефолтную раскраску).
export function noteSidesUnsupportedOnce() {
  if (sidesWarned) return
  sidesWarned = true
  console.warn("diff-viewer-annotations: DiffRenderable sides unavailable, line decorations disabled")
}

// Только для тестов: сброс однократного warn.
export function resetSidesWarn() {
  sidesWarned = false
}

// getLineColors() возвращает ЖИВЫЕ карты — снапшот всегда копии-контейнеры
// (значения RGBA иммутабельны и переиспользуются по ссылке).
export function cloneLineColors(form: LineColorForm): LineColorForm {
  return { gutter: new Map(form.gutter), content: new Map(form.content) }
}

export function deepEqualValues(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    const leftBuffer = (left as { buffer?: ArrayLike<number> }).buffer
    const rightBuffer = (right as { buffer?: ArrayLike<number> }).buffer
    if (leftBuffer && rightBuffer) {
      return (
        leftBuffer.length === rightBuffer.length &&
        Array.from(leftBuffer).every((value, index) => value === rightBuffer[index])
      )
    }
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => deepEqualValues((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
    )
  }
  return false
}

export function deepEqualMaps(left: ReadonlyMap<number, unknown>, right: ReadonlyMap<number, unknown>): boolean {
  if (left.size !== right.size) return false
  for (const [row, value] of left) {
    if (!right.has(row) || !deepEqualValues(value, right.get(row))) return false
  }
  return true
}

export function deepEqualLineColors(left: LineColorForm, right: LineColorForm): boolean {
  return deepEqualMaps(left.gutter, right.gutter) && deepEqualMaps(left.content, right.content)
}

// Оверлей декорации: content === undefined означает «сохранить pristine-контент ряда»
// (пометка красит только gutter).
export type LineDecoration = {
  readonly rows: readonly number[]
  readonly gutter: unknown
  readonly content?: unknown
}

// Ряды помеченных строк — факт наличия, не количество (spec §11): дедупликация
// сохраняет первый порядок появления.
export function uniqueRows(rows: Iterable<number>): number[] {
  return [...new Set(rows)]
}

// Итог = pristine + оверлеи в форме единой карты конфигов для setLineColors
// (позднейшие вытесняют ранние: конфиг курсора вытесняет пометку на том же ряду).
export function mergeLineColors(pristine: LineColorForm, overlays: readonly LineDecoration[]): Map<number, LineColorConfig> {
  const merged = new Map<number, LineColorConfig>()
  for (const row of new Set([...pristine.gutter.keys(), ...pristine.content.keys()])) {
    const gutter = pristine.gutter.get(row) ?? pristine.content.get(row)
    const content = pristine.content.get(row) ?? pristine.gutter.get(row)
    merged.set(row, { gutter, content })
  }
  for (const overlay of overlays) {
    for (const row of overlay.rows) {
      const existing = merged.get(row)
      merged.set(row, {
        gutter: overlay.gutter,
        content: overlay.content ?? existing?.content ?? overlay.gutter,
      })
    }
  }
  return merged
}

function overlaysEqual(left: readonly LineDecoration[], right: readonly LineDecoration[]): boolean {
  if (left.length !== right.length) return false
  return left.every((a, index) => {
    const b = right[index]
    return (
      a.gutter === b.gutter &&
      a.content === b.content &&
      a.rows.length === b.rows.length &&
      a.rows.every((row, i) => row === b.rows[i])
    )
  })
}

// Слияние для одной стороны с детектором внешнего rebuild'а: если карты рендерера
// отличаются от нашего последнего применения (сравнение в одной распарсенной форме),
// pristine переснимается с нуля и итог применяется заново. Повторное применение
// того же состояния без внешних изменений — no-op (защита от лишних setLineColors).
export type SideMerger = {
  apply: (overlays: readonly LineDecoration[]) => void
}

export function createSideMerger(side: SideLike): SideMerger {
  let pristine = cloneLineColors(side.getLineColors())
  let lastApplied: LineColorForm | undefined
  let lastOverlays: readonly LineDecoration[] | undefined
  return {
    apply(overlays) {
      const current = side.getLineColors()
      const externalRebuild = !lastApplied || !deepEqualLineColors(current, lastApplied)
      if (externalRebuild) pristine = cloneLineColors(current)
      if (!externalRebuild && lastOverlays && overlaysEqual(lastOverlays, overlays)) return
      side.setLineColors(mergeLineColors(pristine, overlays))
      // lastApplied читается из рендера, а не из входных данных (митигация U3).
      lastApplied = cloneLineColors(side.getLineColors())
      lastOverlays = overlays
    },
  }
}
