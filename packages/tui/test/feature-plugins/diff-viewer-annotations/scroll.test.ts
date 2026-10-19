import { describe, expect, test } from "bun:test"
import { quarterViewport } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-cursor"

// UT-71 (FR-1): четверть экрана с минимумом в 1 ряд.
describe("quarterViewport (UT-71)", () => {
  test("quarter of typical heights", () => {
    expect(quarterViewport(24)).toBe(6)
    expect(quarterViewport(40)).toBe(10)
    expect(quarterViewport(21)).toBe(5)
  })

  test("minimum is 1 row for tiny viewports", () => {
    expect(quarterViewport(1)).toBe(1)
    expect(quarterViewport(3)).toBe(1)
    expect(quarterViewport(5)).toBe(1)
  })
})
