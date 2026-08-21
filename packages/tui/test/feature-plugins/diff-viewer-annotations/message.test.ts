import { describe, expect, test } from "bun:test"
import { assembleMessage, type MessageAnnotation } from "../../../src/feature-plugins/system/diff-viewer-annotations/message"
import type { DiffFile } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"

const files: readonly DiffFile[] = [
  {
    file: "src/a.ts",
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+two!\n three",
    additions: 1,
    deletions: 1,
    status: "modified",
  },
]

const bound = (over: Partial<MessageAnnotation>): MessageAnnotation => ({
  filePath: "src/a.ts",
  side: "new",
  originLine: 2,
  line: 2,
  hunk: 1,
  window: ["one", "two!", "three"],
  anchorOffset: 1,
  text: "замечание",
  bound: true,
  ...over,
})

// UT-09 (FR-P3/P4/P5, AC-24/25): группировка, стороны номеров, unbound-блок.
describe("message — assembleMessage (UT-09)", () => {
  test("empty draft produces empty message", () => {
    expect(assembleMessage([], files)).toBe("")
  })

  test("bound annotations group by file → hunk → line with side-aware numbering", () => {
    const text = assembleMessage(
      [
        bound({ side: "old", line: 2, originLine: 2, window: ["one", "two", "three"], text: "зря удалили" }),
        bound({ line: 2, text: "новая строка" }),
      ],
      files,
    )
    expect(text).toContain("Замечания по diff (2)")
    expect(text).toContain("## src/a.ts (hunk #1, старая строка 2)")
    expect(text).toContain("## src/a.ts (hunk #1, новая строка 2)")
    expect(text).toContain("зря удалили")
    expect(text).toContain("новая строка")
    // сниппет с маркером якорной строки
    expect(text).toContain("> two")
    // unbound-блока нет
    expect(text).not.toContain("Не удалось надёжно привязать")
  })

  test("unbound annotations land in the marked block with the creation snapshot", () => {
    const text = assembleMessage([bound({ bound: false, text: "потерянное" })], files)
    expect(text).toContain("Не удалось надёжно привязать к строке")
    expect(text).toContain("src/a.ts")
    expect(text).toContain("Исходный снимок строк на момент создания")
    expect(text).toContain("потерянное")
  })

  test("unbound-only draft still assembles", () => {
    const text = assembleMessage([bound({ bound: false })], files)
    expect(text).toContain("Замечания по diff (1)")
    expect(text).toContain("Не удалось надёжно привязать")
  })
})
