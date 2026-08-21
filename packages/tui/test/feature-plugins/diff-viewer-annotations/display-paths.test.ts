import { describe, expect, test } from "bun:test"
import {
  displayPathLabels,
  numberColumnWidth,
  pathBasename,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/display-paths"

// UT-61 (FR-3.1–3.3): минимальная дизамбигуация basename в листинге.
describe("displayPathLabels (UT-61)", () => {
  test("no collision — bare basenames", () => {
    const labels = displayPathLabels(["src/a.ts", "lib/b.ts"])
    expect(labels.get("src/a.ts")).toBe("a.ts")
    expect(labels.get("lib/b.ts")).toBe("b.ts")
  })

  test("pair collision — both participants get the prefix", () => {
    const labels = displayPathLabels(["src/model/store.ts", "app/store.ts", "lib/other.ts"])
    expect(labels.get("src/model/store.ts")).toBe("model/store.ts")
    expect(labels.get("app/store.ts")).toBe("app/store.ts")
    expect(labels.get("lib/other.ts")).toBe("other.ts")
  })

  test("triple collision — all three distinguishable", () => {
    const labels = displayPathLabels(["x/a/i.ts", "x/b/i.ts", "y/i.ts"])
    expect(labels.get("x/a/i.ts")).toBe("a/i.ts")
    expect(labels.get("x/b/i.ts")).toBe("b/i.ts")
    expect(labels.get("y/i.ts")).toBe("y/i.ts")
  })

  test("deep collision — one shared segment is not enough", () => {
    const labels = displayPathLabels(["a/c/x.ts", "b/c/x.ts"])
    expect(labels.get("a/c/x.ts")).toBe("a/c/x.ts")
    expect(labels.get("b/c/x.ts")).toBe("b/c/x.ts")
  })

  test("partial group — non-conflicting namesake stays bare", () => {
    const labels = displayPathLabels(["p/req.ts", "q/req.ts", "req.ts"])
    expect(labels.get("p/req.ts")).toBe("p/req.ts")
    expect(labels.get("q/req.ts")).toBe("q/req.ts")
    expect(labels.get("req.ts")).toBe("req.ts")
  })

  test("degenerate inputs: empty, single, no directory, duplicates", () => {
    expect(displayPathLabels([]).size).toBe(0)
    expect(displayPathLabels(["store.ts"]).get("store.ts")).toBe("store.ts")
    expect(displayPathLabels(["a/x.ts", "a/x.ts"]).get("a/x.ts")).toBe("x.ts")
    expect(pathBasename("plain.ts")).toBe("plain.ts")
  })

  test("deterministic across orderings", () => {
    const one = displayPathLabels(["x/a/i.ts", "x/b/i.ts", "y/i.ts"])
    const two = displayPathLabels(["y/i.ts", "x/b/i.ts", "x/a/i.ts"])
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort())
  })
})

// UT-62 (FR-4.3): ширина колонки номеров — clamp 2…5 по максимальному номеру.
describe("numberColumnWidth (UT-62)", () => {
  test("max 9 → 2; max 1000 → 4", () => {
    expect(numberColumnWidth([1, 5, 9])).toBe(2)
    expect(numberColumnWidth([1000, 3, 12])).toBe(4)
  })

  test("boundaries: 99 → 2; 100 → 3; clamp at 5", () => {
    expect(numberColumnWidth([99])).toBe(2)
    expect(numberColumnWidth([100])).toBe(3)
    expect(numberColumnWidth([9999999])).toBe(5)
  })

  test("empty list and unbound-only rows fall back to the minimum", () => {
    expect(numberColumnWidth([])).toBe(2)
    expect(numberColumnWidth([undefined, undefined])).toBe(2)
  })
})
