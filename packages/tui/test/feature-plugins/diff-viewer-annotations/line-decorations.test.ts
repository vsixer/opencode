import { describe, expect, mock, test } from "bun:test"
import {
  cloneLineColors,
  createSideMerger,
  deepEqualLineColors,
  deepEqualMaps,
  diffSides,
  mergeLineColors,
  noteSidesUnsupportedOnce,
  resetSidesWarn,
  uniqueRows,
  type LineColorConfig,
  type LineColorForm,
  type SideLike,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/line-decorations"

const RED = { r: 1, g: 0, b: 0, a: 1 }
const BLUE = { r: 0, g: 0, b: 1, a: 1 }
const GREEN = { r: 0, g: 1, b: 0, a: 1 }

// Мок стороны: рендерер хранит ДВЕ live-карты (gutter/content); setLineColors
// «парсит» единую карту конфигов в обе.
function mockSide(initial: LineColorForm = { gutter: new Map(), content: new Map() }) {
  const calls: Array<Map<number, LineColorConfig>> = []
  const live: LineColorForm = { gutter: new Map(initial.gutter), content: new Map(initial.content) }
  const side: SideLike = {
    setLineColors(map) {
      live.gutter.clear()
      live.content.clear()
      for (const [row, config] of map) {
        if (config.gutter !== undefined) live.gutter.set(row, config.gutter)
        if (config.content !== undefined) live.content.set(row, config.content)
      }
      calls.push(new Map(map))
    },
    getLineColors: () => live,
    getLineNumbers: () => new Map([[0, 1], [1, 2], [2, 3]]),
  }
  return { side, calls, live }
}

describe("line-decorations — snapshot is a copy of live maps (UT-D1)", () => {
  test("mutating the live maps after snapshot leaves pristine intact", () => {
    const { live } = mockSide({ gutter: new Map([[0, RED]]), content: new Map([[0, RED]]) })
    const snapshot = cloneLineColors(live)
    live.gutter.set(0, BLUE)
    live.gutter.set(1, BLUE)
    live.content.clear()
    expect(snapshot.gutter.get(0)).toBe(RED)
    expect(snapshot.gutter.has(1)).toBe(false)
    expect(snapshot.content.get(0)).toBe(RED)
  })
})

describe("line-decorations — merge (UT-D2)", () => {
  const pristine: LineColorForm = {
    gutter: new Map([[0, RED], [1, RED]]),
    content: new Map([[0, RED], [1, RED]]),
  }

  test("cursor displaces mark; mark returns after cursor leaves; untouched rows preserved", () => {
    const mark = { rows: [1], gutter: BLUE }
    const cursor = { rows: [1], gutter: GREEN, content: GREEN }
    const withBoth = mergeLineColors(pristine, [mark, cursor])
    expect(withBoth.get(1)).toEqual({ gutter: GREEN, content: GREEN })
    const withMarkOnly = mergeLineColors(pristine, [mark])
    // Пометка красит только gutter: content остался pristine-контентом ряда.
    expect(withMarkOnly.get(1)).toEqual({ gutter: BLUE, content: RED })
    expect(withMarkOnly.get(0)).toEqual({ gutter: RED, content: RED })
    expect(mergeLineColors(pristine, []).get(0)).toEqual({ gutter: RED, content: RED })
  })
})

describe("line-decorations — apply (UT-D3)", () => {
  test("single setLineColors call with full map; both fields explicit; mark content preserved", () => {
    const { side, calls } = mockSide({
      gutter: new Map([[0, RED], [1, RED]]),
      content: new Map([[0, RED], [1, RED]]),
    })
    const merger = createSideMerger(side)
    merger.apply([{ rows: [1], gutter: BLUE }])
    expect(calls).toHaveLength(1)
    const applied = calls[0]
    expect(applied.get(1)).toEqual({ gutter: BLUE, content: RED })
    expect(applied.get(0)).toEqual({ gutter: RED, content: RED })
    expect(Object.keys(applied.get(1) as object).sort()).toEqual(["content", "gutter"])
  })
})

describe("line-decorations — rebuild detector (UT-D4)", () => {
  test("external overwrite re-snapshots pristine; own apply does not self-pollute", () => {
    const { side, calls, live } = mockSide({ gutter: new Map([[0, RED]]), content: new Map([[0, RED]]) })
    const merger = createSideMerger(side)
    merger.apply([{ rows: [0], gutter: BLUE }])
    expect(calls).toHaveLength(1)
    // (б) повторное применение без внешних вмешательств — no-op: pristine не
    // переснимается, setLineColors не вызывается (самозагрязнения нет).
    merger.apply([{ rows: [0], gutter: BLUE }])
    expect(calls).toHaveLength(1)
    // (а) внешний актёр перезаписал карты.
    live.gutter.set(0, GREEN)
    live.content.set(0, GREEN)
    merger.apply([{ rows: [1], gutter: BLUE }])
    const last = calls[calls.length - 1]
    // pristine переснят: ряд 0 остался внешним значением, ряд 1 — наш оверлей.
    expect(last.get(0)).toEqual({ gutter: GREEN, content: GREEN })
    expect(last.get(1)).toEqual({ gutter: BLUE, content: BLUE })
  })
})

describe("line-decorations — comparison stays in parsed form (UT-D5)", () => {
  test("no false rebuild signal: lastApplied is read back from the renderer", () => {
    const { side, calls } = mockSide()
    const merger = createSideMerger(side)
    merger.apply([{ rows: [0], gutter: BLUE }])
    const first = calls[0]
    // Повторное применение — no-op (detect=false), форма значений идентична.
    merger.apply([{ rows: [0], gutter: BLUE }])
    expect(calls).toHaveLength(1)
    expect(calls[calls.length - 1]).toEqual(first)
  })

  test("deepEqual helpers compare structurally", () => {
    expect(deepEqualMaps(new Map([[0, { buffer: [1, 2, 3] }]]), new Map([[0, { buffer: [1, 2, 3] }]]))).toBe(true)
    expect(deepEqualMaps(new Map([[0, RED]]), new Map([[0, BLUE]]))).toBe(false)
    expect(deepEqualMaps(new Map([[0, RED]]), new Map([[1, RED]]))).toBe(false)
    const form = { gutter: new Map([[0, RED]]), content: new Map([[0, RED]]) }
    expect(deepEqualLineColors(form, { gutter: new Map([[0, { ...RED }]]), content: new Map([[0, RED]]) })).toBe(true)
  })
})

describe("line-decorations — feature detection (UT-D6)", () => {
  test("missing sides or methods disable decorations; a single warn on final failure", () => {
    resetSidesWarn()
    // diffSides тих: стороны строятся асинхронно, отсутствие — не ошибка.
    expect(diffSides({})).toBeUndefined()
    expect(diffSides({ leftSide: {}, rightSide: {} })).toBeUndefined()
    expect(diffSides(undefined)).toBeUndefined()
    const warn = mock((_message: string) => {})
    const original = console.warn
    console.warn = warn as unknown as typeof console.warn
    try {
      noteSidesUnsupportedOnce()
      noteSidesUnsupportedOnce()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = original
    }
    resetSidesWarn()
  })

  test("valid sides are bridged", () => {
    const { side } = mockSide()
    expect(diffSides({ leftSide: side, rightSide: side })).toBeDefined()
  })
})

describe("line-decorations — mark rows builder (UT-D7)", () => {
  test("duplicate rows collapse; distinct rows stay distinct; order deterministic", () => {
    expect(uniqueRows([1, 1, 2])).toEqual([1, 2])
    expect(uniqueRows([3, 1, 3])).toEqual([3, 1])
    expect(uniqueRows([])).toEqual([])
  })
})
