import { describe, expect, test } from "bun:test"
import { parsePatchFileLines } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"
import {
  lineRows,
  unifiedRowsBefore,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-cursor"

// Счётчик рядов unified-рендера: service-строки ряда не занимают, wrap-строка
// занимает несколько рядов.
const PATCH = `--- a/f.ts
+++ b/f.ts
@@ -1,4 +1,4 @@
 one
-two
+${"x".repeat(90)}
 three
@@ -10,2 +10,2 @@
 ten
-ten-old
+ten-new`

describe("unified row mapping", () => {
  const parsed = parsePatchFileLines(PATCH)
  // parsed: 0..2 service (---, +++, @@), 3 one, 4 two, 5 xxx..., 6 three,
  // 7 service (@@), 8 ten, 9 ten-old, 10 ten-new
  const wrapColumn = 80

  test("service lines occupy no rows; rows accumulate over body lines only", () => {
    expect(unifiedRowsBefore(parsed, 3, wrapColumn)).toBe(0)
    // до «ten» (index 8): one + two + wrap(xxx, 2 ряда) + three = 5 рядов;
    // заголовок второго ханка (index 7, service) ряда не занимает
    expect(unifiedRowsBefore(parsed, 7, wrapColumn)).toBe(5)
    expect(unifiedRowsBefore(parsed, 8, wrapColumn)).toBe(5)
  })

  test("wrap rows of one logical line", () => {
    const rows = lineRows("x".repeat(90), wrapColumn)
    expect(rows).toBe(2)
    expect(unifiedRowsBefore(parsed, 6, wrapColumn)).toBe(4)
  })
})
