import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

// Структурная негатив-проверка: мышиный контур аннотирования удалён из кода.
// Дублирует grep-гейт локальным прогоном; клики дерева файлов (file-tree) —
// вне контура и исключены (FR-1.3).

const src = (...parts: string[]) =>
  readFileSync(path.join(import.meta.dir, "../../../src/feature-plugins/system", ...parts), "utf8")

describe("mouse circuit removal (TC-560)", () => {
  test("diff-viewer wrapper box has no mouse props", () => {
    const source = src("diff-viewer.tsx")
    expect(source).not.toMatch(/onMouseMove|onMouseUp|onMouseOut/)
  })

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

describe("help and docs are mouse-free (TC-561)", () => {
  test("feature sources mention no mouse interactions", () => {
    for (const file of ["diff-viewer.tsx", "diff-viewer-ui.tsx"]) {
      const source = src(file)
      expect(source, file).not.toMatch(/мышь|клик|hover|mouse/i)
    }
  })
})
