/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { DiffViewerFileTree } from "../../../src/feature-plugins/system/diff-viewer-file-tree"
import { TestTuiContexts } from "../../fixture/tui-environment"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  flattenFileTree,
} from "../../../src/feature-plugins/system/diff-viewer-file-tree-utils"

const theme = {
  background: RGBA.fromHex("#000000"),
  backgroundPanel: RGBA.fromHex("#111111"),
  backgroundElement: RGBA.fromHex("#333333"),
  primary: RGBA.fromHex("#00ffff"),
  secondary: RGBA.fromHex("#0088ff"),
  selectedListItemText: RGBA.fromHex("#ffffff"),
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
}

describe("DiffViewerFileTree", () => {
  test.skip("renders sorted hierarchical file rows", async () => {
    const app = await testRender(
      () =>
        withTheme(() => (
          <DiffViewerFileTree
            width={32}
            files={[
              { file: "z-file.ts" },
              { file: "b/file.ts" },
              { file: "a/zeta.ts" },
              { file: "b/alpha.ts" },
              { file: "a/alpha.ts" },
            ]}
            loading={false}
            error={undefined}
            theme={theme}
            focused={true}
          />
        )),
      { width: 40, height: 20 },
    )

    try {
      await renderOnceSettled(app)
      const lines = visibleLines(app.captureCharFrame())

      expect(lines).toEqual([
        "▾ a",
        "│  ├─ alpha.ts               ?",
        "│  └─ zeta.ts                ?",
        "├─ ▾ b",
        "│  ├─ alpha.ts               ?",
        "│  └─ file.ts                ?",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps loading and error quiet while rendering an empty settled state", async () => {
    const loading = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={true} error={undefined} theme={theme} />
    ))
    const failed = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={new Error("nope")} theme={theme} />
    ))
    const empty = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={undefined} theme={theme} />
    ))

    expect(loading).not.toContain("Loading diff...")
    expect(loading).not.toContain("No files")
    expect(failed).not.toContain("Failed to load diff")
    expect(failed).not.toContain("No files")
    expect(empty).toContain("No files")
  })

  test("does not render text markers for highlighted rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const src = buildFileTree(files).nodes.find((node) => node.kind === "directory" && node.name === "src")!

    const focused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree
          width={32}
          files={files}
          loading={false}
          error={undefined}
          theme={theme}
          focused
          highlightedNode={src.id}
        />
      )),
    )
    const unfocused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree width={32} files={files} loading={false} error={undefined} theme={theme} />
      )),
    )

    expect(focused).toContain("▾ src/config")
    expect(unfocused).toContain("▾ src/config")
    expect(focused.some((line) => line.includes("*"))).toBe(false)
    expect(unfocused.some((line) => line.includes("*"))).toBe(false)
  })

  test("renders collapsed and expanded directory rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const tree = buildFileTree(files)
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const collapsed = allExpandedFileTreeDirectories(tree)
    collapsed.delete(src.id)

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            width={32}
            files={files}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={collapsed}
          />
        )),
      ),
    ).toEqual(["▸ src/config"])

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            files={files}
            width={32}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={allExpandedFileTreeDirectories(tree)}
            fileNumberByNodeId={fileNumbers(files)}
          />
        )),
      ),
    ).toEqual([" ▾ src/config", "1 │  └─ tui.ts               ?", "2 └─ README.md               ?"])
  })

  // Номер файла — единой колонкой в начале строки, перед префиксом; внутри
  // колонки — выравнивание по правому краю (ширина по разрядности общего
  // количества файлов).
  test("multi-digit file numbers stay right-aligned in one leading column", async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ file: `f${i}.ts` }))
    const tree = buildFileTree(files)
    const numbers = fileNumbers(files)
    const app = await testRender(
      () =>
        withTheme(() => (
          <DiffViewerFileTree
            width={32}
            files={files}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={allExpandedFileTreeDirectories(tree)}
            fileNumberByNodeId={numbers}
          />
        )),
      { width: 40, height: 16 },
    )
    let frame: string[]
    try {
      await renderOnceSettled(app)
      frame = visibleLines(await captureSettledFrame(app))
    } finally {
      app.renderer.destroy()
    }
    // Однозначные номера выровнены по правому краю колонки (ширина по «12»):
    // «1  ├─ …» и «10 ├─ …» — одна колонка перед префиксом.
    expect(frame.some((line) => line.startsWith("1   f0.ts"))).toBe(true)
    expect(frame.some((line) => line.startsWith("9  ├─ f6.ts"))).toBe(true)
    expect(frame.some((line) => line.startsWith("10 ├─ f7.ts"))).toBe(true)
    expect(frame.some((line) => line.startsWith("12 └─ f9.ts"))).toBe(true)
  })

  // TC-630 (FR-1.1/1.2): 1-based номера строк-файлов из плоского порядка
  // patchFileIndexes; каталоги без номеров; сворачивание номера не меняет.
  test("shows stable file numbers that survive directory collapsing (TC-630)", async () => {
    const files = [
      { file: "a/one.ts" },
      { file: "a/two.ts" },
      { file: "b/deep/three.ts" },
      { file: "b/deep/four.ts" },
      { file: "b/five.ts" },
      { file: "top.ts" },
      { file: "zz.ts" },
    ]
    const tree = buildFileTree(files)
    const numbers = fileNumbers(files)
    const collapsed = allExpandedFileTreeDirectories(tree)
    const aDir = tree.nodes.find((node) => node.kind === "directory" && node.name === "a")!
    collapsed.delete(aDir.id)

    // Кадр выше дефолтного renderFrame: все 9 строк дерева должны быть видны.
    const renderTall = async (expanded: ReadonlySet<number>) => {
      const app = await testRender(
        () =>
          withTheme(() => (
            <DiffViewerFileTree
              width={32}
              files={files}
              loading={false}
              error={undefined}
              theme={theme}
              expandedNodes={expanded}
              fileNumberByNodeId={numbers}
            />
          )),
        { width: 40, height: 16 },
      )
      try {
        await renderOnceSettled(app)
        return visibleLines(await captureSettledFrame(app))
      } finally {
        app.renderer.destroy()
      }
    }
    const expandedFrame = await renderTall(allExpandedFileTreeDirectories(tree))
    const collapsedFrame = await renderTall(collapsed)

    // Файлы нумеруются по полному плоскому порядку (внутри каталога — по алфавиту),
    // каталоги — без номеров.
    expect(expandedFrame.some((line) => line.includes("one.ts") && line.includes("1"))).toBe(true)
    expect(expandedFrame.some((line) => line.includes("two.ts") && line.includes("2"))).toBe(true)
    expect(expandedFrame.some((line) => line.includes("four.ts") && line.includes("3"))).toBe(true)
    expect(expandedFrame.some((line) => line.includes("five.ts") && line.includes("5"))).toBe(true)
    expect(expandedFrame.some((line) => line.includes("top.ts") && line.includes("6"))).toBe(true)
    // Строка-каталог номера не содержит
    const dirRow = expandedFrame.find((line) => line.includes("▾ b"))!
    expect(dirRow).toBeDefined()
    expect(dirRow.replace(/[^\d]/g, "")).toBe("")
    // Сворачивание «a» прячет one/two, но номера four/five/top не сдвинулись.
    expect(collapsedFrame.some((line) => line.includes("one.ts"))).toBe(false)
    expect(collapsedFrame.some((line) => line.includes("four.ts") && line.includes("3"))).toBe(true)
    expect(collapsedFrame.some((line) => line.includes("top.ts") && line.includes("6"))).toBe(true)
  })

  test("renders no numbers when fileNumberByNodeId is absent", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const tree = buildFileTree(files)
    const frame = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree
          width={32}
          files={files}
          loading={false}
          error={undefined}
          theme={theme}
          expandedNodes={allExpandedFileTreeDirectories(tree)}
        />
      )),
    )
    expect(frame.some((line) => line.includes("tui.ts"))).toBe(true)
    expect(frame.join("\n").replace(/[^\d]/g, "")).toBe("")
  })
})

// Плоский 1-based порядок файлов — тот же, из которого viewer строит
// patchFileIndexes: flattenFileTree без expanded-набора.
function fileNumbers(files: { file: string }[]) {
  const numbers = new Map<number, number>()
  const rows = flattenFileTree(buildFileTree(files))
  let number = 0
  for (const row of rows) {
    if (row.fileIndex === undefined) continue
    number += 1
    numbers.set(row.id, number)
  }
  return numbers
}

async function renderFrame(component: () => JSX.Element) {
  const app = await testRender(() => withTheme(component), { width: 40, height: 10 })
  try {
    await renderOnceSettled(app)
    return await captureSettledFrame(app)
  } finally {
    app.renderer.destroy()
  }
}

async function renderOnceSettled(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await app.renderOnce()
}

async function captureSettledFrame(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const frame = app.captureCharFrame()
    if (frame.trim().length > 0) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
  }
  return app.captureCharFrame()
}

function withTheme(component: () => JSX.Element) {
  return (
    <TestTuiContexts>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">{component()}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function visibleLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) => line.replace(/^ ?│ ?/, "").replace(/[ │]*$/, ""))
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
    .filter((line) => line.length > 0 && !/^┌|^└|^─+$/.test(line))
}
