import { describe, expect, test } from "bun:test"
import { FINGERPRINT_K, rebind } from "../../../src/feature-plugins/system/diff-viewer-annotations/fingerprint"
import type { SideLine } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"

const side = (lines: readonly string[]): SideLine[] => lines.map((text, index) => ({ lineNumber: index + 1, text, hunk: 1 }))

// UT-06 (FR-Y2/Y3, AC-30, риск R8): rebind детерминирован; тайбрейк — ближайший к
// originLine, при равенстве — меньший номер.
describe("fingerprint — rebind determinism (UT-06)", () => {
  const lines = ["alpha", "beta", "gamma", "delta", "beta", "gamma", "epsilon"]

  test("empty window, bad offset or too-short side is not found", () => {
    expect(rebind(side(lines), [], 0, 3).found).toBe(false)
    expect(rebind(side(lines), ["beta", "gamma"], 5, 3).found).toBe(false)
    expect(rebind(side(["x"]), ["beta", "gamma"], 0, 1).found).toBe(false)
  })

  test("same input always yields the same result", () => {
    const first = rebind(side(lines), ["beta", "gamma"], 1, 3)
    const second = rebind(side(lines), ["beta", "gamma"], 1, 3)
    expect(first).toEqual(second)
    // якорь «gamma» (offset 1), originLine 3 → совпадения на строках 3 и 6, ближайшее 3
    expect(first).toEqual({ found: true, newLine: 3 })
  })

  test("tie-break prefers the match nearest to originLine", () => {
    // якорь «beta» (offset 0), originLine 4: кандидаты 2 и 5 → 5
    expect(rebind(side(lines), ["beta", "gamma"], 0, 4)).toEqual({ found: true, newLine: 5 })
    expect(rebind(side(lines), ["beta", "gamma"], 0, 1)).toEqual({ found: true, newLine: 2 })
  })

  test("equidistant candidates resolve to the lower line number", () => {
    const equidistant = side(["dupe", "x", "dupe"])
    expect(rebind(equidistant, ["dupe"], 0, 2)).toEqual({ found: true, newLine: 1 })
  })

  test("window at the side start matches from the first line", () => {
    expect(rebind(side(["a", "b", "c"]), ["a", "b"], 0, 1)).toEqual({ found: true, newLine: 1 })
    expect(FINGERPRINT_K).toBe(3)
  })
})
