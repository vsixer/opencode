import { afterEach, describe, expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { openFileInEditor } from "../src/editor"

// UT-73 (FR-5/FR-9/FR-10): резолв редактора из среды и статус-маппинг.
// Реальный spawn (/usr/bin/true игнорирует аргументы) — без моков, как в репо.

const originalVisual = process.env.VISUAL
const originalEditor = process.env.EDITOR
afterEach(() => {
  process.env.VISUAL = originalVisual
  process.env.EDITOR = originalEditor
})

function stubRenderer() {
  const calls: string[] = []
  const renderer = {
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
    requestRender: () => calls.push("requestRender"),
    currentRenderBuffer: { clear: () => calls.push("clear") },
  }
  return { renderer: renderer as unknown as CliRenderer, calls }
}

describe("openFileInEditor (UT-73)", () => {
  test("no VISUAL/EDITOR → \"no-editor\", no renderer lifecycle", async () => {
    delete process.env.VISUAL
    delete process.env.EDITOR
    const { renderer, calls } = stubRenderer()
    const status = await openFileInEditor({ file: "some.ts", line: 3, renderer })
    expect(status).toBe("no-editor")
    expect(calls).toEqual([])
  })

  test("EDITOR set → \"opened\" with full suspend/clear/resume/render lifecycle", async () => {
    delete process.env.VISUAL
    process.env.EDITOR = "true"
    const { renderer, calls } = stubRenderer()
    const status = await openFileInEditor({ file: "some.ts", line: 3, renderer })
    expect(status).toBe("opened")
    expect(calls[0]).toBe("suspend")
    expect(calls[calls.length - 1]).toBe("requestRender")
    expect(calls.filter((call) => call === "clear").length).toBe(2)
    expect(calls).toContain("resume")
  })

  test("VISUAL wins over EDITOR; no line → no +line arg (spawn still succeeds)", async () => {
    process.env.VISUAL = "true"
    process.env.EDITOR = "definitely-not-a-binary-ohc4X"
    const { renderer } = stubRenderer()
    const status = await openFileInEditor({ file: "some.ts", renderer })
    expect(status).toBe("opened")
  })
})
