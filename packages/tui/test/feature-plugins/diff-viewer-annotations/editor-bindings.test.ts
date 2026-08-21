import { describe, expect, test } from "bun:test"
import { createTestKeymap } from "@opentui/keymap/testing"
import { helpKeyColumnWidth } from "../../../src/feature-plugins/system/diff-viewer-ui"

// UT-01 (D1, R1): биндинг alt+return матчит мета-модифицированный enter, которым
// kitty-протокол доставляет alt+enter.
describe("editor confirm binding — alt+return matches meta+enter (UT-01)", () => {
  test("meta+enter fires the alt+return binding", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    let fired = 0
    harness.keymap.registerLayer({
      commands: [{ name: "test.editor.submit", run() { fired++ } }],
      bindings: [{ key: "alt+return", cmd: "test.editor.submit" }],
    })
    harness.host.press("return", { meta: true })
    expect(fired).toBe(1)
    harness.cleanup()
  })

  test("plain enter and ctrl+enter do not fire the alt+return binding", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    let fired = 0
    harness.keymap.registerLayer({
      commands: [{ name: "test.editor.submit", run() { fired++ } }],
      bindings: [{ key: "alt+return", cmd: "test.editor.submit" }],
    })
    harness.host.press("return")
    harness.host.press("return", { ctrl: true })
    expect(fired).toBe(0)
    harness.cleanup()
  })
})

// UT-13 (Q2, FR-5.1): динамическая ширина Key-колонки модалки справки.
describe("help dialog — key column width (UT-13)", () => {
  test("wide enough for alt+enter with separator, floor of 6", () => {
    expect(helpKeyColumnWidth(["q", "alt+enter", "0-9", "<leader>d"])).toBe(10)
    expect(helpKeyColumnWidth(["q", "n", "p"])).toBe(6)
    expect(helpKeyColumnWidth([])).toBe(6)
  })
})
