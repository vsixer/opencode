import { describe, expect, test } from "bun:test"
import { quarterViewport } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-cursor"
import { moveFileTreeSelection } from "../../../src/feature-plugins/system/diff-viewer-file-tree-utils"

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

// TC-713 (FR-1): в фокусе дерева J/K двигают выделение на ±2 строки с клампом.
describe("moveFileTreeSelection with ±2 offset (TC-713)", () => {
  const rows = [1, 2, 3, 4].map((id) => ({ id, depth: 0, kind: "file" as const, name: `f${id}` }))

  test("shifts selection by two rows down and up", () => {
    expect(moveFileTreeSelection(rows, 1, 2)).toBe(3)
    expect(moveFileTreeSelection(rows, 3, -2)).toBe(1)
  })

  test("clamps at both edges without wrap-around (AC-3)", () => {
    expect(moveFileTreeSelection(rows, 3, 2)).toBe(4)
    expect(moveFileTreeSelection(rows, 4, 2)).toBe(4)
    expect(moveFileTreeSelection(rows, 1, -2)).toBe(1)
  })
})
