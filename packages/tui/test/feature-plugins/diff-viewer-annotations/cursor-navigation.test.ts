import { describe, expect, test } from "bun:test"
import {
  buildFlatPatchLines,
  firstNavigableRowOfFile,
  nearestNavigableIndex,
  nextNavigableIndex,
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

const makeFile = (file: string, patch: string | undefined): DiffFile => ({
  file,
  patch,
  additions: 1,
  deletions: 1,
  status: "modified",
})

const flat = buildFlatPatchLines([
  { file: makeFile("a.ts", fileA), fileIndex: 0 },
  { file: makeFile("b.ts", fileB), fileIndex: 1 },
])

// UT-02 (Q1): первая контентная строка файла — не заголовок.
describe("patch-cursor — firstNavigableRowOfFile (UT-02)", () => {
  test("first body line of a file, not its header", () => {
    const first = firstNavigableRowOfFile(flat, 0)
    expect(first).toBe(3)
    expect(flat[first!].text).toBe("one")
  })

  test("deleted file lands on its first minus line", () => {
    const deleted = buildFlatPatchLines([{ file: { ...makeFile("gone.ts", "--- a/gone\n+++ b/gone\n@@ -1,1 +0,0 @@\n-gone"), status: "deleted" }, fileIndex: 0 }])
    const first = firstNavigableRowOfFile(deleted, 0)
    expect(first).toBe(3)
    expect(deleted[first!].kind).toBe("minus")
  })

  test("file without content lines has no candidate", () => {
    const binary = buildFlatPatchLines([{ file: makeFile("bin.dat", "Binary files differ"), fileIndex: 0 }])
    expect(firstNavigableRowOfFile(binary, 0)).toBeUndefined()
  })
})

describe("patch-cursor — nextNavigableIndex", () => {
  test("service lines are skipped in one step, including file boundaries", () => {
    // fileA: 0..2 служебные, 3 «one», 4 minus, 5 plus, 6 «three»;
    // fileB: 7..9 служебные, 10 «five», 11 minus, 12 plus.
    expect(flat[6].text).toBe("three")
    expect(flat[7].kind).toBe("service")
    expect(nextNavigableIndex(flat, 6, 1)).toBe(10)
    expect(nextNavigableIndex(flat, 10, -1)).toBe(6)
    expect(nextNavigableIndex(flat, 3, -1)).toBeUndefined()
    expect(nextNavigableIndex(flat, 12, 1)).toBeUndefined()
  })
})

// UT-11 (FR-8.9, INV-2): кламп «ближайшая контентная строка того же файла».
describe("patch-cursor — nearestNavigableIndex tie-breaks (UT-11)", () => {
  const twoHunks = (first: string, second: string) =>
    buildFlatPatchLines([
      { file: makeFile("a.ts", `--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n${first}\n@@ -3,1 +3,1 @@\n${second}`), fileIndex: 0 },
    ])

  test("equal distance up/down prefers down", () => {
    // Индекс 4 — «@@» второго ханка: вверх контекст (3), вниз контекст (5).
    const lines = twoHunks(" ctx", " ctx2")
    expect(lines[4].kind).toBe("service")
    expect(nearestNavigableIndex(lines, 4)).toBe(5)
  })

  test("changed beats context at equal distance", () => {
    expect(nearestNavigableIndex(twoHunks(" ctx", "+chg"), 4)).toBe(5)
    expect(nearestNavigableIndex(twoHunks("+chg", " ctx"), 4)).toBe(3)
  })

  test("falls back to any file when the current file has no body lines", () => {
    const mixed = buildFlatPatchLines([
      { file: makeFile("bin.dat", "Binary files differ"), fileIndex: 0 },
      { file: makeFile("a.ts", fileA), fileIndex: 1 },
    ])
    expect(nearestNavigableIndex(mixed, 0)).not.toBeUndefined()
  })
})
