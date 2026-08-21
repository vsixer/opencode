import { describe, expect, test } from "bun:test"
import { parsePatchFileLines, sideLines, buildSideWindow } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"

// UT-01 (FR-N1/N2/N3, AC-10/11/24): парсинг патча — типы строк, side-номера, hunk-индекс.
const PATCH = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,5 +1,5 @@
 const first = true
-const oldFirst = true
+const newFirst = true
 const second = true
 const third = true`

const DELETED_PATCH = `--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first one
-file two
\\ No newline at end of file`

const BINARY_PATCH = `diff --git a/logo.png b/logo.png
index 1234567..89abcde 100644
Binary files a/logo.png and b/logo.png differ`

describe("patch-lines — parsePatchFileLines (UT-01)", () => {
  test("empty or missing patch yields no lines", () => {
    expect(parsePatchFileLines(undefined)).toEqual([])
    expect(parsePatchFileLines("")).toEqual([])
  })

  test("classifies service lines and body lines with sides and hunk index", () => {
    const lines = parsePatchFileLines(PATCH)
    expect(lines).toHaveLength(8)
    // заголовки файла — служебные, вне ханков
    expect(lines[0]).toMatchObject({ kind: "service", hunk: null, text: "--- a/src/file.ts" })
    expect(lines[1]).toMatchObject({ kind: "service", hunk: null, text: "+++ b/src/file.ts" })
    // заголовок ханка — служебный, открывает ханк 1
    expect(lines[2]).toMatchObject({ kind: "service", hunk: 1, lineNumber: null })
    // контекст идентифицируется номером новой версии
    expect(lines[3]).toMatchObject({ kind: "context", side: "new", lineNumber: 1, hunk: 1 })
    // minus идентифицируется номером старой версии
    expect(lines[4]).toMatchObject({ kind: "minus", side: "old", lineNumber: 2, hunk: 1 })
    // plus идентифицируется номером новой версии
    expect(lines[5]).toMatchObject({ kind: "plus", side: "new", lineNumber: 2, hunk: 1 })
    expect(lines[6]).toMatchObject({ kind: "context", side: "new", lineNumber: 3 })
  })

  test("no-newline marker and binary placeholders are service lines", () => {
    const deleted = parsePatchFileLines(DELETED_PATCH)
    expect(deleted[2]).toMatchObject({ kind: "service", hunk: 1 })
    expect(deleted[3]).toMatchObject({ kind: "minus", side: "old", lineNumber: 1 })
    expect(deleted[4]).toMatchObject({ kind: "minus", side: "old", lineNumber: 2 })
    // «\ No newline at end of file» — служебная строка внутри ханка
    expect(deleted[5]).toMatchObject({ kind: "service", hunk: 1, lineNumber: null })

    const binary = parsePatchFileLines(BINARY_PATCH)
    expect(binary.every((line) => line.kind === "service")).toBe(true)
    expect(binary).toHaveLength(3)
  })
})

// UT-02 (FR-O4, AC-10/17): side-последовательности; удалённый файл → новая сторона пуста.
describe("patch-lines — sideLines (UT-02)", () => {
  test("old side = minus + context, new side = plus + context, in file order", () => {
    const lines = parsePatchFileLines(PATCH)
    expect(sideLines(lines, "old").map((line) => [line.lineNumber, line.text])).toEqual([
      [1, "const first = true"],
      [2, "const oldFirst = true"],
      [3, "const second = true"],
      [4, "const third = true"],
    ])
    expect(sideLines(lines, "new").map((line) => [line.lineNumber, line.text])).toEqual([
      [1, "const first = true"],
      [2, "const newFirst = true"],
      [3, "const second = true"],
      [4, "const third = true"],
    ])
  })

  test("deleted file has empty new side — no targets for binding", () => {
    const lines = parsePatchFileLines(DELETED_PATCH)
    expect(sideLines(lines, "new")).toEqual([])
    expect(sideLines(lines, "old")).toHaveLength(2)
  })
})

describe("patch-lines — buildSideWindow (clamping in hunk)", () => {
  test("window clamps at hunk boundaries and reports the anchor offset", () => {
    const lines = parsePatchFileLines(PATCH)
    // якорь на minus строке 2 (старая сторона): K=1 → строка выше + якорь + строки ниже
    const narrow = buildSideWindow(lines, "old", 2, 1, 1)
    expect(narrow).toEqual({ texts: ["const first = true", "const oldFirst = true", "const second = true"], anchorOffset: 1 })
    // якорь на первой строке стороны — окно обрезано сверху, якорь в позиции 0
    const atStart = buildSideWindow(lines, "old", 1, 1, 3)
    expect(atStart.anchorOffset).toBe(0)
    expect(atStart.texts[0]).toBe("const first = true")
    // несуществующий якорь → пустое окно
    expect(buildSideWindow(lines, "old", 99, 1, 3).texts).toEqual([])
  })
})
