import { describe, expect, test } from "bun:test"
import {
  annotatableBodyLine,
  buildFlatPatchLines,
  clampCursor,
  isBodyLine,
  lineRows,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-cursor"
import type { DiffFile } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"

const fileA = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+two!
 three`

const fileB = `--- b/b.ts
+++ b/b.ts
@@ -5,2 +5,2 @@
 five
-six
+six!`

const makeFile = (file: string, patch: string | undefined, status: DiffFile["status"] = "modified"): DiffFile => ({
  file,
  patch,
  additions: 1,
  deletions: 1,
  status,
})

// UT-03 (FR-I4/I5, AC-04/33): плоский список видимых строк через границы файлов/ханков.
describe("patch-cursor — flat list and clamping (UT-03)", () => {
  test("flat list spans files and hunk boundaries; service lines traversable", () => {
    const flat = buildFlatPatchLines([
      { file: makeFile("a.ts", fileA), fileIndex: 0 },
      { file: makeFile("b.ts", fileB), fileIndex: 1 },
    ])
    expect(flat).toHaveLength(13)
    expect(flat[0]).toMatchObject({ fileIndex: 0, lineIndex: 0, kind: "service" })
    expect(flat[3]).toMatchObject({ fileIndex: 0, lineIndex: 3, kind: "context", lineNumber: 1 })
    expect(flat[4]).toMatchObject({ fileIndex: 0, kind: "minus", side: "old", lineNumber: 2 })
    expect(flat[5]).toMatchObject({ fileIndex: 0, kind: "plus", side: "new", lineNumber: 2 })
    // второй файл продолжает плоский список без сброса lineIndex внутри файла
    expect(flat[7]).toMatchObject({ fileIndex: 1, lineIndex: 0, kind: "service" })
    expect(flat[10]).toMatchObject({ fileIndex: 1, lineIndex: 3, kind: "context", lineNumber: 5 })
  })

  test("clampCursor clamps at both ends", () => {
    expect(clampCursor(-3, 10)).toBe(0)
    expect(clampCursor(15, 10)).toBe(9)
    expect(clampCursor(4, 10)).toBe(4)
    expect(clampCursor(0, 0)).toBe(0)
  })

  test("file without patch contributes no lines (collapsed content is not traversable)", () => {
    const flat = buildFlatPatchLines([{ file: makeFile("empty.ts", undefined), fileIndex: 0 }])
    expect(flat).toEqual([])
  })
})

// UT-04 (FR-K1/N4/N5/N6, AC-09/10/11): предикат аннотируемости — матрица §11 spec.
describe("patch-cursor — annotatability predicate (UT-04)", () => {
  const flat = buildFlatPatchLines([
    { file: makeFile("a.ts", fileA), fileIndex: 0 },
    { file: makeFile("gone.ts", "--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-only", "deleted"), fileIndex: 1 },
  ])

  test("plus/minus/context body lines of a modified file are annotatable", () => {
    expect(annotatableBodyLine(flat[3])).toBe(true) // context
    expect(annotatableBodyLine(flat[4])).toBe(true) // minus — «зря удалили» валидно
    expect(annotatableBodyLine(flat[5])).toBe(true) // plus
  })

  test("service lines are not annotatable", () => {
    expect(isBodyLine(flat[0])).toBe(false)
    expect(annotatableBodyLine(flat[0])).toBe(false) // ---
    expect(annotatableBodyLine(flat[2])).toBe(false) // @@
  })

  test("body lines of a fully deleted file are not annotatable", () => {
    const goneLine = flat.find((line) => line.filePath === "gone.ts" && line.kind === "minus")
    expect(goneLine).toBeDefined()
    expect(annotatableBodyLine(goneLine!)).toBe(false)
  })
})

// UT-05 (FR-I5, риск R1): оценка строк→рядов.
describe("patch-cursor — rows estimation (UT-05)", () => {
  test("no wrap: 1:1", () => {
    expect(lineRows("", 40)).toBe(1)
    expect(lineRows("short line", 40)).toBe(1)
    expect(lineRows("x".repeat(40), 40)).toBe(1)
  })

  test("char-wrap: multiplicity of wrap column", () => {
    expect(lineRows("x".repeat(41), 40)).toBe(2)
    expect(lineRows("x".repeat(80), 40)).toBe(2)
    expect(lineRows("x".repeat(120), 40)).toBe(3)
  })
})

// UT-C2 (FR-4, дефект (d) spec §10): инвариант клампа — отрицательных и запредельных
// значений не существует конструктивно, при len=0 всегда 0.
describe("patch-cursor — clamp invariant (UT-C2)", () => {
  test("every input in [-5 … len+5] stays within [0, max(0, len-1)]", () => {
    for (const length of [0, 10]) {
      for (let index = -5; index <= length + 5; index++) {
        const clamped = clampCursor(index, length)
        expect(clamped).toBeGreaterThanOrEqual(0)
        expect(clamped).toBeLessThanOrEqual(Math.max(0, length - 1))
        if (length === 0) expect(clamped).toBe(0)
      }
    }
    expect(clampCursor(-1, 10)).toBe(0)
    expect(clampCursor(10, 10)).toBe(9)
    expect(clampCursor(3, 10)).toBe(3)
  })
})
