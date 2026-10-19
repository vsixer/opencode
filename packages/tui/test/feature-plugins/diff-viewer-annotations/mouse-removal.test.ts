import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

// Структурная негатив-проверка: движок аннотирования остаётся чисто клавиатурным —
// в нём нет мышиных обработчиков и обратного маппинга рядов. Мышиный контур
// оболочки viewer (меню файла, подсказки) принадлежит upstream-фиче и движок
// не касается.
const src = (...parts: string[]) =>
  readFileSync(path.join(import.meta.dir, "../../../src/feature-plugins/system", ...parts), "utf8")

describe("annotation engine is mouse-free (TC-560)", () => {
  test("annotation integration has no mouse handlers or reverse row mapping", () => {
    for (const file of [
      "diff-viewer-annotations/integration.tsx",
      "diff-viewer-annotations/patch-cursor.ts",
      "diff-viewer-annotations/annotations-panel.tsx",
      "diff-viewer-annotations/annotation-editor.tsx",
    ]) {
      const source = src(file)
      // case-sensitive: `hover` не должен совпадать с `pushOverlay` (hOver)
      expect(source, file).not.toMatch(/onMouseMove|onMouseUp|onMouseOut|mockMouse|hover/)
      expect(source, file).not.toMatch(/wrapColumnFor|unifiedLineIndexAtRow/)
    }
  })

  test("harness does not expose mockMouse", () => {
    const source = readFileSync(path.join(import.meta.dir, "../../cli/tui/diff-viewer-annotations.test.tsx"), "utf8")
    expect(source).not.toMatch(/mockMouse/)
  })
})
