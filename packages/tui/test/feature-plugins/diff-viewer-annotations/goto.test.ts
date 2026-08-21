import { describe, expect, test } from "bun:test"
import { gotoTargetIndex, gotoTransition, parseGotoNumber } from "../../../src/feature-plugins/system/diff-viewer-annotations/goto"

// UT-03 (FR-4.x): чистая машина состояний goto-ввода.
describe("goto — state machine (UT-03)", () => {
  test("digits accumulate; 4,2 → \"42\"", () => {
    let state = gotoTransition(undefined, { kind: "digit", digit: "4" })
    expect(state).toEqual({ buffer: "4", consumed: true, committed: undefined })
    state = gotoTransition(state.buffer, { kind: "digit", digit: "2" })
    expect(state.buffer).toBe("42")
  })

  test("leading zeros parse to plain number: \"007\" → 7", () => {
    expect(parseGotoNumber("007")).toBe(7)
    expect(parseGotoNumber("")).toBeUndefined()
    let state = gotoTransition(undefined, { kind: "digit", digit: "0" })
    state = gotoTransition(state.buffer, { kind: "digit", digit: "0" })
    state = gotoTransition(state.buffer, { kind: "digit", digit: "7" })
    const committed = gotoTransition(state.buffer, { kind: "enter" })
    expect(committed).toEqual({ buffer: undefined, consumed: true, committed: 7 })
  })

  test("backspace removes last digit; empty buffer becomes inactive", () => {
    expect(gotoTransition("42", { kind: "backspace" }).buffer).toBe("4")
    expect(gotoTransition("4", { kind: "backspace" }).buffer).toBeUndefined()
    expect(gotoTransition(undefined, { kind: "backspace" }).consumed).toBe(false)
  })

  test("enter on empty buffer is a quiet exit; escape cancels", () => {
    expect(gotoTransition("", { kind: "enter" })).toEqual({ buffer: undefined, consumed: true, committed: undefined })
    expect(gotoTransition("42", { kind: "escape" }).buffer).toBeUndefined()
  })

  test("command key cancels and is swallowed; tab cancels without swallowing", () => {
    expect(gotoTransition("42", { kind: "command" })).toEqual({ buffer: undefined, consumed: true, committed: undefined })
    expect(gotoTransition("42", { kind: "tab" })).toEqual({ buffer: undefined, consumed: false, committed: undefined })
  })

  test("digits do not start the mode when inactive-reactive other keys pass through", () => {
    const passthrough = gotoTransition(undefined, { kind: "enter" })
    expect(passthrough.consumed).toBe(false)
    expect(passthrough.buffer).toBeUndefined()
  })
})

// UT-04 (FR-4.2/4.3): разрешение цели — строка новой стороны текущего файла.
describe("goto — target resolution (UT-04)", () => {
  const lines = [
    { fileIndex: 0, side: "old", lineNumber: 1 },
    { fileIndex: 0, side: "new", lineNumber: 1 },
    { fileIndex: 0, side: "new", lineNumber: 3 },
    { fileIndex: 1, side: "new", lineNumber: 3 },
    { fileIndex: 0, side: "new", lineNumber: null },
  ]

  test("exact new-side line of the current file resolves", () => {
    expect(gotoTargetIndex(lines, 0, 3)).toBe(2)
  })

  test("old-side numbers never match (goto is new-file only)", () => {
    expect(gotoTargetIndex(lines, 0, 1)).toBe(1)
  })

  test("number of another file, null numbers and gaps are no-move", () => {
    expect(gotoTargetIndex(lines, 1, 1)).toBe(-1)
    expect(gotoTargetIndex(lines, 0, 2)).toBe(-1)
    expect(gotoTargetIndex(lines, 0, 99)).toBe(-1)
  })
})
