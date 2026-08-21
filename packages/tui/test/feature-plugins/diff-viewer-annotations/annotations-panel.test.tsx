/** @jsxImportSource @opentui/solid */
// Изолированный рендер AnnotationsPanel (test.md 006): футер подсказок и чистый
// хедер, basename-заголовки групп с коллизиями, чистая колонка номеров строк.
import { describe, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { AnnotationsPanel } from "../../../src/feature-plugins/system/diff-viewer-annotations/annotations-panel"
import type { Annotation, AnnotationStore } from "../../../src/feature-plugins/system/diff-viewer-annotations/store"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

const resolvedTheme = resolveTheme(DEFAULT_THEMES.opencode, "dark")

// Панель читает из стора только visibleAnnotations — минимальная заглушка без
// дублирования логики стора в тесте.
function fakeStore(annotations: Annotation[]): AnnotationStore {
  return { visibleAnnotations: () => annotations } as unknown as AnnotationStore
}

function annotation(input: {
  id: string
  filePath: string
  line: number
  text: string
  side?: "old" | "new"
  state?: "bound" | "unbound"
}): Annotation {
  return {
    id: input.id,
    anchor: {
      filePath: input.filePath,
      side: input.side ?? "new",
      line: input.line,
      originLine: input.line,
      hunk: 0,
      window: [],
      anchorOffset: 0,
    },
    text: input.text,
    state: input.state ?? "bound",
  }
}

async function renderPanel(
  annotations: Annotation[],
  files: string[],
  width = 40,
): Promise<string> {
  const config = createTuiResolvedConfig()
  const api = createTuiPluginApi({ theme: { current: resolvedTheme } as unknown as TuiPluginApi["theme"] })
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <AnnotationsPanel
                  api={api}
                  store={fakeStore(annotations)}
                  files={() => files.map((file) => ({ file }))}
                  active={() => true}
                  onEdit={() => {}}
                  onDelete={() => {}}
                  onJump={() => {}}
                  onClose={() => {}}
                />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width, height: 14 })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await app.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("AnnotationsPanel (TC-631..634)", () => {
  test("hints live in the panel footer, header holds only title and counter (TC-631)", async () => {
    const frame = await renderPanel(
      [annotation({ id: "1", filePath: "src/a.ts", line: 3, text: "note" })],
      ["src/a.ts"],
    )
    const lines = frame.split("\n")
    expect(lines.some((line) => line.includes("Замечания (1)"))).toBe(true)
    const hintRow = lines.findIndex((line) => line.includes("j/k"))
    expect(hintRow).toBeGreaterThan(-1)
    // Футер панели — последняя содержательная строка внутри рамки (под ней
    // только нижняя граница).
    const borderLike = /^[ ┌┐└┘│─]*$/
    const contentRows: Array<[string, number]> = []
    lines.forEach((line, i) => {
      if (line.trim().length > 0 && !borderLike.test(line)) contentRows.push([line, i])
    })
    expect(contentRows[contentRows.length - 1]![1]).toBe(hintRow)
    // Хедер подсказок не содержит
    expect(lines.findIndex((line) => line.includes("Замечания") && line.includes("j/k"))).toBe(-1)
  })

  test("hints truncate on narrow width without wrapping or layout break (TC-631/AC-20)", async () => {
    const frame = await renderPanel(
      [annotation({ id: "1", filePath: "src/a.ts", line: 3, text: "note" })],
      ["src/a.ts"],
      24,
    )
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(24)
    // начало подсказок видно, хвост усечён
    expect(frame.includes("j/k")).toBe(true)
    expect(frame.includes("закрыть")).toBe(false)
  })

  test("empty state: header and hint render on separate rows without overlap", async () => {
    const frame = await renderPanel([], ["src/a.ts"], 100)
    const lines = frame.split("\n")
    const headerRow = lines.findIndex((line) => line.includes("Замечания (0)"))
    const emptyRow = lines.findIndex((line) => line.includes("Пусто — нажмите Enter на строке патча."))
    expect(headerRow).toBeGreaterThan(-1)
    expect(emptyRow).toBeGreaterThan(-1)
    expect(emptyRow).toBe(headerRow + 1)
    // Интерлив-дефект: перекрытие строк смешивало символы обеих строк
    expect(lines[headerRow]!.includes("Пусто")).toBe(false)
  })

  test("group headers show bare basenames; collisions get minimal prefixes (TC-632)", async () => {
    const frame = await renderPanel(
      [
        annotation({ id: "1", filePath: "src/a.ts", line: 1, text: "one" }),
        annotation({ id: "2", filePath: "lib/b.ts", line: 2, text: "two" }),
      ],
      ["src/a.ts", "lib/b.ts"],
    )
    expect(frame.includes("a.ts")).toBe(true)
    expect(frame.includes("b.ts")).toBe(true)
    expect(frame.includes("src/a.ts")).toBe(false)
  })

  test("pair collision: both participants prefixed (TC-632/AC-16)", async () => {
    // Широкий кадр: 40% ширины должно вместить «model/store.ts» целиком.
    const frame = await renderPanel(
      [
        annotation({ id: "1", filePath: "src/model/store.ts", line: 1, text: "one" }),
        annotation({ id: "2", filePath: "app/store.ts", line: 2, text: "two" }),
      ],
      ["src/model/store.ts", "app/store.ts"],
      90,
    )
    expect(frame.includes("model/store.ts")).toBe(true)
    expect(frame.includes("app/store.ts")).toBe(true)
  })

  test("triple collision: all three distinguishable (TC-632/AC-17)", async () => {
    const frame = await renderPanel(
      [
        annotation({ id: "1", filePath: "x/a/i.ts", line: 1, text: "one" }),
        annotation({ id: "2", filePath: "x/b/i.ts", line: 2, text: "two" }),
        annotation({ id: "3", filePath: "y/i.ts", line: 3, text: "three" }),
      ],
      ["x/a/i.ts", "x/b/i.ts", "y/i.ts"],
    )
    expect(frame.includes("a/i.ts")).toBe(true)
    expect(frame.includes("b/i.ts")).toBe(true)
    expect(frame.includes("y/i.ts")).toBe(true)
  })

  test("number column: bare numbers, old numbers on minus lines, «—» for unbound (TC-633/AC-5/19)", async () => {
    const frame = await renderPanel(
      [
        annotation({ id: "1", filePath: "src/a.ts", line: 42, text: "note new" }),
        annotation({ id: "2", filePath: "src/a.ts", line: 7, text: "note old", side: "old" }),
        annotation({ id: "3", filePath: "src/a.ts", line: 9, text: "note unbound", state: "unbound" }),
      ],
      ["src/a.ts"],
    )
    expect(frame.includes("42")).toBe(true)
    expect(frame.includes("7")).toBe(true)
    expect(frame.includes("—")).toBe(true)
    expect(frame.includes("нов:")).toBe(false)
    expect(frame.includes("стар:")).toBe(false)
    expect(frame.includes("не привязана")).toBe(false)
  })

  test("unbound file outside the diff falls back to basename (TC-634)", async () => {
    const frame = await renderPanel(
      [
        annotation({ id: "1", filePath: "src/a.ts", line: 1, text: "one" }),
        annotation({ id: "2", filePath: "gone/legacy.ts", line: 5, text: "two", state: "unbound" }),
      ],
      ["src/a.ts"],
    )
    expect(frame.includes("legacy.ts")).toBe(true)
    expect(frame.includes("gone/legacy.ts")).toBe(false)
    expect(frame.includes("a.ts")).toBe(true)
  })
})
