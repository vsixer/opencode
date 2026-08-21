import { describe, expect, test } from "bun:test"
import {
  closePanelStack,
  popOverlayTop,
  pushEditorOverlay,
  syncEditorOverlay,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/overlay-stack"

const overlay = (kind: string) => ({ kind })
const makeEditor = () => overlay("editor")
const kinds = (stack: readonly { kind: string }[]) => stack.map((item) => item.kind)

// Инвариант закрытия листинга: стек оверлеев восстанавливается из любого
// деградированного состояния — панель закрывается всегда.

describe("overlay-stack — push editor idempotency (UT-30)", () => {
  test("push over non-editor top appends exactly one editor", () => {
    expect(kinds(pushEditorOverlay([overlay("panel")], overlay("editor")))).toEqual(["panel", "editor"])
    expect(kinds(pushEditorOverlay([], overlay("editor")))).toEqual(["editor"])
  })

  test("push over an editor top is a no-op — no duplicates", () => {
    const stack = [overlay("panel"), overlay("editor")]
    expect(pushEditorOverlay(stack, overlay("editor"))).toBe(stack)
  })
})

describe("overlay-stack — closePanel truncation (UT-31)", () => {
  test("closes the panel and everything above it", () => {
    expect(closePanelStack([overlay("panel")])).toEqual([])
    expect(kinds(closePanelStack([overlay("panel"), overlay("editor")]))).toEqual([])
    expect(kinds(closePanelStack([overlay("panel"), overlay("confirm")]))).toEqual([])
  })

  test("no panel in the stack — unchanged", () => {
    const stack = [overlay("editor")]
    expect(closePanelStack(stack)).toBe(stack)
  })

  test("popOverlayTop stays LIFO: mismatched kind is a no-op", () => {
    const stack = [overlay("panel"), overlay("editor"), overlay("confirm")]
    expect(popOverlayTop(stack, "editor")).toBe(stack)
    expect(kinds(popOverlayTop(stack, "confirm"))).toEqual(["panel", "editor"])
  })
})

describe("overlay-stack — self-heal sync with editor state (UT-32)", () => {
  test("closed editor: residual editors vanish", () => {
    expect(kinds(syncEditorOverlay([overlay("panel"), overlay("editor"), overlay("editor")], false, makeEditor))).toEqual([
      "panel",
    ])
    expect(syncEditorOverlay([overlay("editor")], false, makeEditor)).toEqual([])
  })

  test("open editor: exactly one editor on top", () => {
    expect(kinds(syncEditorOverlay([overlay("panel")], true, makeEditor))).toEqual(["panel", "editor"])
    expect(kinds(syncEditorOverlay([overlay("panel"), overlay("editor"), overlay("editor")], true, makeEditor))).toEqual([
      "panel",
      "editor",
    ])
  })

  test("already-correct stack is returned as-is", () => {
    const stack = [overlay("panel"), overlay("editor")]
    expect(syncEditorOverlay(stack, true, makeEditor)).toBe(stack)
    const noEditor = [overlay("panel")]
    expect(syncEditorOverlay(noEditor, false, makeEditor)).toBe(noEditor)
  })
})
