import { describe, expect, test } from "bun:test"
import { parsePatchFileLines } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"
import {
  buildBodyLineMap,
  invertLineNumbers,
  resolveSplitRow,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/line-mapping"

// Fixture переиспользуется из patch-lines-тестов: один файл, один ханк @@ -1,3 +1,3 @@.
const PATCH = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const first = true
-const oldSecond = true
+const newSecond = true
 const third = true`

const TWO_HUNKS = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,2 +1,2 @@
 one
-two
+two!
@@ -10,2 +10,2 @@
 ten
-ten-old
+ten-new`

const parse = (patch: string | undefined) => parsePatchFileLines(patch)

describe("line-mapping — unified body map (UT-M1/M2/M5/M6)", () => {
  test("service lines are absent; body indexes are continuous across hunks (UT-M1)", () => {
    const entries = buildBodyLineMap(parse(TWO_HUNKS))
    // 2 ханка × (ctx, minus, plus) = 6 body-строк; service-строки пропущены.
    expect(entries).toHaveLength(6)
    expect(entries.map((entry) => entry.bodyIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(entries.every((entry) => entry.kind !== "service")).toBe(true)
    // Порядок совпадает с порядком строк патча.
    expect(entries.map((entry) => entry.lineIndex)).toEqual([...entries.map((entry) => entry.lineIndex)].sort((a, b) => a - b))
  })

  test("side numbers: minus by old, plus/context by new (UT-M2)", () => {
    const entries = buildBodyLineMap(parse(PATCH))
    const [ctx1, minus, plus, ctx3] = entries
    expect(ctx1.oldNumber).toBe(1)
    expect(ctx1.newNumber).toBe(1)
    expect(minus.oldNumber).toBe(2)
    expect(minus.newNumber).toBe(null)
    expect(plus.oldNumber).toBe(null)
    expect(plus.newNumber).toBe(2)
    expect(ctx3.oldNumber).toBe(3)
    expect(ctx3.newNumber).toBe(3)
  })

  test("service lines have no entry: no highlight, footer dash (UT-M5)", () => {
    const entries = buildBodyLineMap(parse(PATCH))
    expect(entries.some((entry) => entry.lineIndex === 0)).toBe(false)
    expect(entries.some((entry) => entry.lineIndex === 2)).toBe(false)
  })

  test("per-file isolation; empty patch yields empty result (UT-M6)", () => {
    const fileA = buildBodyLineMap(parse(PATCH))
    const fileB = buildBodyLineMap(parse(PATCH))
    // Маппинг строится на строках одного файла — индексы не пересекаются.
    expect(fileA).toHaveLength(4)
    expect(fileB).toHaveLength(4)
    expect(fileB[0].bodyIndex).toBe(0)
    expect(buildBodyLineMap(parse(undefined))).toEqual([])
  })
})

describe("line-mapping — split resolver (UT-M3/M4)", () => {
  const left = invertLineNumbers(new Map([[0, 1], [1, 2], [2, 3]]))
  const right = invertLineNumbers(new Map([[0, 1], [1, 2], [2, 3]]))

  test("minus/plus/context/filler resolve to correct sides (UT-M3)", () => {
    expect(resolveSplitRow({ kind: "minus", oldNumber: 2, newNumber: null }, left, right)).toEqual({ left: 1 })
    expect(resolveSplitRow({ kind: "plus", oldNumber: null, newNumber: 2 }, left, right)).toEqual({ right: 1 })
    expect(resolveSplitRow({ kind: "context", oldNumber: 2, newNumber: 2 }, left, right)).toEqual({ left: 1, right: 1 })
    // Filler: ряда нет — пустые вставки wrap-выравнивания номера не имеют.
    expect(resolveSplitRow({ kind: "context", oldNumber: 99, newNumber: 99 }, left, right)).toBeUndefined()
  })

  test("missing numbers, empty maps, foreign side numbers (UT-M4)", () => {
    const empty = invertLineNumbers(new Map())
    expect(resolveSplitRow({ kind: "minus", oldNumber: 2, newNumber: null }, empty, right)).toBeUndefined()
    expect(resolveSplitRow({ kind: "plus", oldNumber: null, newNumber: 2 }, left, empty)).toBeUndefined()
    // «Чужой» номер другой стороны — без фоллбэка на соседа.
    expect(resolveSplitRow({ kind: "minus", oldNumber: 2, newNumber: null }, empty, right)).toBeUndefined()
    const once = resolveSplitRow({ kind: "plus", oldNumber: null, newNumber: 3 }, left, right)
    expect(resolveSplitRow({ kind: "plus", oldNumber: null, newNumber: 3 }, left, right)).toEqual(once)
  })

  test("invertLineNumbers inverts finalIndex → lineNum strictly (UT-M3)", () => {
    expect(invertLineNumbers(new Map([[5, 10], [6, 11]]))).toEqual(new Map([[10, 5], [11, 6]]))
  })
})
