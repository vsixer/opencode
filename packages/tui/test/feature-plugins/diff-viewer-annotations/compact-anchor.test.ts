import { describe, expect, test } from "bun:test"
import { anchorScrollTop } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-cursor"

// Якорный офсет при тумгле compact: якорная строка сохраняет экранную позицию,
// офсет клампится в границы прокрутки, скрытие строк не сдвигает якорь.

describe("anchor scroll (compact toggle)", () => {
  test("anchor keeps its screen offset mid-content", () => {
    expect(anchorScrollTop(50, 5, 20, 100)).toBe(45)
  })

  test("clamped at top and bottom", () => {
    expect(anchorScrollTop(3, 5, 20, 100)).toBe(0)
    expect(anchorScrollTop(95, 0, 20, 100)).toBe(80)
  })

  test("content shorter than viewport pins to top", () => {
    expect(anchorScrollTop(10, 2, 20, 15)).toBe(0)
  })
})
