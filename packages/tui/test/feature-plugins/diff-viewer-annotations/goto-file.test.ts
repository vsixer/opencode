import { describe, expect, test } from "bun:test"
import { gotoFileTarget } from "../../../src/feature-plugins/system/diff-viewer-annotations/goto"

// UT-60 (FR-1.5/1.6): resolver цели goto-файла — 1-based номер против плоского
// списка файлов диффа.
describe("goto file — target resolution (UT-60)", () => {
  test("valid 1-based numbers resolve to 0-based file indexes", () => {
    expect(gotoFileTarget(1, 3)).toBe(0)
    expect(gotoFileTarget(3, 3)).toBe(2)
    expect(gotoFileTarget(12, 12)).toBe(11)
  })

  test("zero, out-of-range and empty input are invalid (quiet reset)", () => {
    expect(gotoFileTarget(0, 3)).toBeUndefined()
    expect(gotoFileTarget(4, 3)).toBeUndefined()
    expect(gotoFileTarget(9, 3)).toBeUndefined()
    expect(gotoFileTarget(undefined, 3)).toBeUndefined()
  })

  test("leading zeros keep numeric semantics", () => {
    expect(gotoFileTarget(3, 12)).toBe(2)
    expect(gotoFileTarget(Number("03"), 12)).toBe(2)
  })

  test("stale number after the file set shrank is invalid", () => {
    expect(gotoFileTarget(12, 3)).toBeUndefined()
    expect(gotoFileTarget(1, 0)).toBeUndefined()
  })
})
