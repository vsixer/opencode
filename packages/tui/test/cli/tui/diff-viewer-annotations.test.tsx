/** @jsxImportSource @opentui/solid */
// Harness-сценарии аннотирования (test.md §2): полный testRender реального diff-viewer,
// драйв командами слоёв и mockInput (pressEnter/pressEscape/pressTab-управляемость FR-R3).
// FR-2: все футер-ассерты идут через footerCell (первая ячейка нижней строки кадра),
// не подстрокой по всему кадру; счётчик «замечаний: N» из футера удалён.
import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { onCleanup, createSignal } from "solid-js"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { DiffRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import diffViewerPlugin from "../../../src/feature-plugins/system/diff-viewer"
import { draftExists, getOrCreateDraft, resetDrafts, SESSIONLESS_OWNER } from "../../../src/feature-plugins/system/diff-viewer-annotations/drafts"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

const startRoute: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }

const PATCH = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const first = true
-const oldSecond = true
+const newSecond = true
 const third = true`

const TWO_HUNKS = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,2 +1,2 @@
 one
-two
+two!
@@ -10,2 +10,2 @@
 ten
-ten-old
+ten-new`

const SECOND_FILE = `--- b/other.ts
+++ b/other.ts
@@ -7,2 +7,2 @@
 seven
-seven-old
+seven-new`

const DELETED_PATCH = `--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-only line`

// Дальний контекст (c7–c9) скрыт компактом; c1 — вне окон обоих изменений.
const LONG_PATCH = `--- a/big.ts
+++ b/big.ts
@@ -1,12 +1,12 @@
 c1
 c2
 c3
-old4
+new4
 c5
 c6
 c7
 c8
 c9
 c10
 c11
-old12
+new12`

const session = {
  id: "session-1",
  slug: "session-1",
  projectID: "project-1",
  directory: "/repo/session",
  title: "Session",
  version: "1",
  time: { created: 0, updated: 0 },
} satisfies Session

const pluginMeta = {
  id: "diff-viewer",
  source: "internal",
  spec: "diff-viewer",
  target: "diff-viewer",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta

type ToastCall = { title?: string; message: string; variant?: string }
type MessageState = Array<{ id: string; role: string; text: string; type: string; time: { created: number } }> | undefined

type HarnessHandle = {
  app: Awaited<ReturnType<typeof testRender>>
  commands: Map<string, { run?: (input: never) => void }>
  current: () => TuiRouteCurrent | { name: string }
  promptCalls: () => Array<{ request: { parts: Array<{ type: string; text: string }> } }>
  setPrompt: (impl: () => Promise<unknown>) => void
  setMessages: (messages: MessageState) => void
  toasts: () => readonly ToastCall[]
}

async function renderAnnotationsViewer(
  vcsDiff: unknown[],
  options: { height?: number; width?: number; initialRoute?: TuiRouteCurrent; withDeletedFile?: boolean } = {},
): Promise<HarnessHandle> {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current = options.initialRoute ?? startRoute
  let renderDiff: TuiRouteDefinition["render"] | undefined
  const promptCalls: Array<{ request: { parts: Array<{ type: string; text: string }> } }> = []
  let promptImpl: () => Promise<unknown> = async () => ({})
  let messagesState: MessageState = []
  const toastCalls: ToastCall[] = []
  // Харнес-реализация диалогового слоя: replace рендерит переданный узел поверх
  // viewer (фикстурный ui.dialog — заглушка), clear убирает.
  const [dialogRender, setDialogRender] = createSignal<() => unknown>()
  const config = createTuiResolvedConfig()
  const diff = options.withDeletedFile ? [...vcsDiff, { file: "gone.ts", patch: DELETED_PATCH, additions: 0, deletions: 1, status: "deleted" }] : vcsDiff

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(offKeymap)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        vcs: {
          diff: async () => ({ data: diff }),
        },
        session: {
          diff: async () => ({ data: [] }),
          prompt: async (request: never) => {
            promptCalls.push({ request })
            return promptImpl()
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          get: () => session,
          messages: (() => messagesState) as unknown as TuiPluginApi["state"]["session"]["messages"],
        },
      },
      theme: { current: resolvedTheme } as unknown as TuiPluginApi["theme"],
    })
    const api = {
      ...base,
      ui: {
        ...base.ui,
        toast: (input: ToastCall) => {
          toastCalls.push(input)
        },
        dialog: {
          ...base.ui.dialog,
          clear: () => setDialogRender(undefined),
          replace: (render: () => unknown) => setDialogRender(() => render),
        },
      },
      route: {
        register(routes) {
          renderDiff = routes.find((route) => route.name === "diff")?.render
          return () => {}
        },
        navigate(name, params) {
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi

    void diffViewerPlugin.tui(api, undefined, pluginMeta)
    if (!options.initialRoute) commands.get("diff.open")?.run?.({} as never)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                {renderDiff?.({ params: "params" in current ? current.params : undefined })}
                {dialogRender()?.() as never}
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  // kittyKeyboard: ctrl+return кодируется однозначно (в legacy-режиме неотличим от
  // ctrl+j) — как в test/cli/tui/dialog-prompt.test.tsx.
  const app = await testRender(() => <Harness />, {
    width: options.width ?? 80,
    height: options.height ?? 24,
    kittyKeyboard: true,
  })
  for (let attempt = 0; attempt < 10 && !commands.has("diff.close"); attempt++) {
    await app.renderOnce()
    if (commands.has("diff.close")) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (vcsDiff.length > 0)
    await app.waitForFrame((frame) => frame.includes("const first") || frame.includes("one") || frame.includes("new4"))
  await app.flush()
  return {
    app,
    commands,
    current: () => current,
    promptCalls: () => promptCalls,
    setPrompt: (impl) => {
      promptImpl = impl
    },
    setMessages: (messages) => {
      messagesState = messages
    },
    toasts: () => toastCalls,
  }
}

function findTextarea(root: Renderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root
  return root.getChildren().map(findTextarea).find(Boolean)
}

type SideHandle = {
  getLineColors: () => { gutter: Map<number, unknown>; content: Map<number, unknown> }
  getLineNumbers: () => Map<number, number>
}

function collectDiffNodes(root: Renderable): DiffRenderable[] {
  if (root instanceof DiffRenderable) return [root]
  return root.getChildren().flatMap(collectDiffNodes)
}

// Структурный мост к сторонам рендерера — тот же SideLike, что в реализации.
function findDiffSides(app: Awaited<ReturnType<typeof testRender>>): Array<{ left: SideHandle; right: SideHandle }> {
  return collectDiffNodes(app.renderer.root).map((node) => {
    const bridge = node as unknown as { leftSide: SideHandle; rightSide: SideHandle }
    return { left: bridge.leftSide, right: bridge.rightSide }
  })
}

// Каналы цвета 0..255: RGBA-объекты рендерера (buffer) и темы (доли) приводятся к одной форме.
function channels(color: unknown): number[] {
  const value = color as { buffer?: ArrayLike<number>; r?: number; g?: number; b?: number }
  if (value && value.buffer) return [value.buffer[0], value.buffer[1], value.buffer[2]]
  return [value.r, value.g, value.b].map((channel) => Math.round((channel as number) * 255))
}

function closeColors(actual: unknown, expected: unknown): boolean {
  const left = channels(actual)
  const right = channels(expected)
  return left.every((channel, index) => Math.abs(channel - right[index]) <= 1)
}

// Фактическая тема теста: фикстура plugin api по умолчанию отдаёт один цвет на все
// ключи — декорациям нужны различимые cursor/mark значения, поэтому тема api
// проксируется на резолвнутую opencode-тему (ту же самую рисует ThemeProvider).
const resolvedTheme = resolveTheme(DEFAULT_THEMES.opencode, "dark")
const cursorBg = () => resolvedTheme.diffCursorLineBg
const markBg = () => resolvedTheme.diffAnnotationMarkBg

// Записи стороны с данным цветом gutter-карты (курсор/пометка задают gutter явно).
function entriesWithColor(side: SideHandle, color: unknown): number[] {
  const rows: number[] = []
  for (const [row, value] of side.getLineColors().gutter) {
    if (closeColors(value, color)) rows.push(row)
  }
  return rows
}

// Нижняя зона кадра → ячейка статуса (FR-2: номер строки либо «—»). Футер занимает
// до двух рядов (ячейка статуса + колонки подсказок): берём самый нижний ряд, чей
// первый токен — точное «\d+» или «—»; ряды контента диффа не подходят: у них
// первый токен содержит текст строки либо префикс знака.
function footerCell(app: Awaited<ReturnType<typeof testRender>>): string {
  const frame = app.captureCharFrame() as string
  const lines = frame.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 3); index--) {
    const token = lines[index].split(/\s+/)[0]
    if (/^(?:\d+|—)$/.test(token)) return token
  }
  return ""
}

async function run(handle: HarnessHandle, command: string) {
  handle.commands.get(command)!.run?.({} as never)
  await handle.app.flush()
}

async function until(predicate: () => boolean, timeoutMs = 8000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timeout")
    await Bun.sleep(50)
  }
}

// Открытие редактора фокусирует textarea отложенно (onMount + setTimeout, паттерн
// dialog-prompt) — даём фокусу закрепиться перед вводом.
async function openEditor(handle: HarnessHandle) {
  await run(handle, "diff.annotate")
  await Bun.sleep(10)
  await handle.app.flush()
}

async function typeIntoFocused(handle: HarnessHandle, text: string) {
  await handle.app.mockInput.typeText(text)
  await handle.app.flush()
}

// alt+enter в kitty-режиме кодируется как meta+enter (H-01); ctrl+enter — no-op.
async function pressAltEnter(handle: HarnessHandle) {
  handle.app.mockInput.pressEnter({ meta: true })
  await handle.app.flush()
}

const withDiff = () => [{ file: "src/file.ts", patch: PATCH, additions: 1, deletions: 1, status: "modified" }]
const withTwoFiles = () => [
  { file: "src/file.ts", patch: PATCH, additions: 1, deletions: 1, status: "modified" },
  { file: "other.ts", patch: SECOND_FILE, additions: 1, deletions: 1, status: "modified" },
]
const withTwoHunks = () => [{ file: "src/file.ts", patch: TWO_HUNKS, additions: 2, deletions: 2, status: "modified" }]

// Курсор стартует на первой контентной строке файла (навигация служебные не
// посещает) — дополнительных движений не требуется.
async function cursorToFirstBodyLine(handle: HarnessHandle) {
  await handle.app.flush()
}

// Один diff.down — минус-строка 2 (левая сторона).
async function cursorToMinusLine(handle: HarnessHandle) {
  await run(handle, "diff.down")
}

async function createAnnotationAtCursor(handle: HarnessHandle, text: string) {
  await openEditor(handle)
  await typeIntoFocused(handle, text)
  await pressAltEnter(handle)
}

afterEach(() => resetDrafts())

test("annotate creates a draft record; footer keeps the bare line number (AC-05/06/08)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await until(() => footerCell(viewer.app) === "1")
    await openEditor(viewer)
    // дефект A: textarea сфокусирована при открытии — символы печатаются немедленно (FR-O3)
    await typeIntoFocused(viewer, "first note")
    const textarea = findTextarea(viewer.app.renderer.root)
    expect(textarea?.plainText).toBe("first note")
    await pressAltEnter(viewer)
    expect(getOrCreateDraft("session-1").count()).toBe(1)
    // номер в футере не изменился
    expect(footerCell(viewer.app)).toBe("1")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("whitespace input cancels creation; occupied line opens edit with prefill (AC-07/13)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await openEditor(viewer)
    await pressAltEnter(viewer)
    expect(getOrCreateDraft("session-1").count()).toBe(0)

    // занятая строка: enter открывает правку с префиллом (FR-N7/N8)
    await openEditor(viewer)
    const textarea = findTextarea(viewer.app.renderer.root)
    expect(textarea?.plainText).toBe("")
    await typeIntoFocused(viewer, "kept")
    await pressAltEnter(viewer)
    expect(getOrCreateDraft("session-1").count()).toBe(1)

    await openEditor(viewer)
    const prefilled = findTextarea(viewer.app.renderer.root)
    expect(prefilled?.plainText).toBe("kept")
    await run(viewer, "diff.annotate.editor.cancel")
    expect(getOrCreateDraft("session-1").count()).toBe(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("enter is a no-op on fully deleted files; navigation skips service lines (AC-09/10/11)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff(), { withDeletedFile: true })
  try {
    // курсор стартует на первой контентной строке, служебные заголовки недостижимы
    await until(() => footerCell(viewer.app) === "1")
    await openEditor(viewer)
    expect(findTextarea(viewer.app.renderer.root)).not.toBeUndefined()
    await run(viewer, "diff.annotate.editor.cancel")

    // хвост списка: контент первого файла (4 строки) — затем сразу минус-строка
    // gone.ts, заголовки второго файла перескакиваются одним нажатием (FR-1.x)
    for (let i = 0; i < 4; i++) await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "1")
    await openEditor(viewer)
    expect(findTextarea(viewer.app.renderer.root)).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("viewer keys are muted while the editor overlay is open (FR-K8/E3)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await openEditor(viewer)
    // j печатается в textarea, курсор viewer не движется
    await typeIntoFocused(viewer, "jk a")
    const textarea = findTextarea(viewer.app.renderer.root)
    expect(textarea?.plainText).toBe("jk a")
    await pressAltEnter(viewer)
    expect(getOrCreateDraft("session-1").count()).toBe(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("annotations panel lists records, jump and close are keyboard-driven (AC-16/17)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "panel note")

    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("panel note"))
    expect(viewer.commands.has("diff.annotate.panel.close")).toBe(true)
    expect(viewer.commands.has("diff.annotate.panel.jump")).toBe(true)
    // повторная «a» закрывает панель (FR-K7)
    await run(viewer, "diff.annotate.panel.close")
    await viewer.app.flush()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("ctrl+d without annotation is a silent no-op; with annotation it confirms (FR-K5, AC-08)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await run(viewer, "diff.annotate_delete")
    await viewer.app.flush()
    const frame = viewer.app.captureCharFrame()
    expect(frame.includes("Удалить замечание?")).toBe(false)

    await createAnnotationAtCursor(viewer, "doomed")
    expect(getOrCreateDraft("session-1").count()).toBe(1)

    await run(viewer, "diff.annotate_delete")
    await viewer.app.waitForFrame((frame) => frame.includes("Удалить замечание?"))
    // pressEnter подтверждает, pressEscape отклоняет (AC-08)
    await run(viewer, "diff.annotate.confirm.accept")
    expect(getOrCreateDraft("session-1").count()).toBe(0)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("closing with an empty draft closes immediately; with a draft it shows the 4-option dialog (FR-X1/X2)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await run(viewer, "diff.close")
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    viewer.app.renderer.destroy()
  }

  const viewer2 = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer2)
    await createAnnotationAtCursor(viewer2, "keep me")
    expect(getOrCreateDraft("session-1").count()).toBe(1)

    await run(viewer2, "diff.close")
    // диалог открыт — навигации не было, маршрут по-прежнему diff
    expect((viewer2.current() as { name: string }).name).toBe("diff")
    await viewer2.app.waitForFrame((frame) => frame.includes("Сохранить"))
    expect(viewer2.commands.has("diff.annotate.exit.choose")).toBe(true)
    expect(viewer2.commands.has("diff.annotate.exit.cancel")).toBe(true)
    // escape = отмена: остаёмся в viewer, черновик цел
    await run(viewer2, "diff.annotate.exit.cancel")
    await viewer2.app.flush()
    expect(draftExists("session-1")).toBe(true)
    expect(getOrCreateDraft("session-1").count()).toBe(1)
  } finally {
    viewer2.app.renderer.destroy()
  }
})

test("discard is irreversible and closes the viewer (FR-X4/X5, AC-21)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "gone")
    await run(viewer, "diff.close")
    // начальный фокус — «Отправить» (живая сессия); j/j → «Отбросить»
    await run(viewer, "diff.annotate.exit.next")
    await run(viewer, "diff.annotate.exit.next")
    await run(viewer, "diff.annotate.exit.choose")
    await viewer.app.flush()
    expect(viewer.current()).toEqual(startRoute)
    expect(draftExists("session-1")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("cursor highlight is applied per renderer line and moves with the cursor (TC-40, AC-1/FR-1)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    // Едиственная запись с курсор-конфигом; ключ = ряд line-mapping (bodyIndex 0).
    await until(() => findDiffSides(viewer.app).some((sides) => entriesWithColor(sides.left, cursorBg()).length === 1))
    const sides = findDiffSides(viewer.app)[0]
    expect(entriesWithColor(sides.left, cursorBg())).toEqual([0])
    expect(closeColors(sides.left.getLineColors().content.get(0), sides.left.getLineColors().gutter.get(0))).toBe(true)
    await run(viewer, "diff.down")
    // Ключ сдвинулся ровно на 1; прежний ряд не перекрашен тотально.
    await until(() => findDiffSides(viewer.app).some((sides) => entriesWithColor(sides.left, cursorBg()).length === 1))
    expect(entriesWithColor(findDiffSides(viewer.app)[0].left, cursorBg())).toEqual([1])
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("footer holds a bare number: no path prefix, no counter, no label (TC-41, AC-2/FR-2)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoFiles())
  try {
    await until(() => /^\d+$|—/.test(footerCell(viewer.app)))
    expect(footerCell(viewer.app)).toMatch(/^(?:\d+|—)$/)
    const frame = viewer.app.captureCharFrame()
    expect(frame.includes("замечаний")).toBe(false)
    expect(frame.includes("annotations")).toBe(false)
    expect(frame.includes("src/file.ts:")).toBe(false)
    // переключение файла n: номер валиден (row 0 файла — служебная строка → «—»)
    await run(viewer, "diff.next_file")
    await until(() => viewer.app.captureCharFrame().includes("other.ts"))
    expect(footerCell(viewer.app)).toMatch(/^(?:\d+|—)$/)
    // панель не меняет футер-контракт
    await run(viewer, "diff.annotations_panel")
    await viewer.app.flush()
    expect(footerCell(viewer.app)).toMatch(/^(?:\d+|—)$/)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("] lands on the first content line of the hunk, never on the header (TC-42, AC-1/2)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoHunks())
  try {
    await run(viewer, "diff.next_hunk")
    // Курсор всегда на контентной строке: заголовок ханка пропускается, футер — номер.
    await until(() => /^\d+$/.test(footerCell(viewer.app)))
    const sides = findDiffSides(viewer.app)[0]
    expect(entriesWithColor(sides.left, cursorBg())).toHaveLength(1)
    await run(viewer, "diff.down")
    await until(() => /^\d+$/.test(footerCell(viewer.app)))
    expect(entriesWithColor(findDiffSides(viewer.app)[0].left, cursorBg())).toHaveLength(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("empty diff keeps the viewer open with no footer number cell (TC-43, FR-2)", async () => {
  const viewer = await renderAnnotationsViewer([])
  try {
    await viewer.app.flush()
    expect(viewer.commands.has("diff.close")).toBe(true)
    expect(footerCell(viewer.app)).not.toMatch(/^(?:\d+|—)$/)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("annotated line gets a gutter mark; deletion removes it (TC-44, AC-4/FR-3)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToMinusLine(viewer)
    await createAnnotationAtCursor(viewer, "mark me")
    // Курсор вытесняет пометку на своей строке (план §6) — уводим курсор вверх.
    await run(viewer, "diff.up")
    // Минус-строка: bodyIndex 1, левая сторона; пометка gutter-тином, content нетронут.
    await until(() => entriesWithColor(findDiffSides(viewer.app)[0].left, markBg()).includes(1))
    const sides = findDiffSides(viewer.app)[0]
    expect(closeColors(sides.left.getLineColors().gutter.get(1), markBg())).toBe(true)
    expect(closeColors(sides.left.getLineColors().gutter.get(1), cursorBg())).toBe(false)
    // Пометка красит только gutter: контент ряда не перекрашен акцентным тинтом.
    expect(closeColors(sides.left.getLineColors().content.get(1), markBg())).toBe(false)

    // Возврат курсора на помеченную строку: ctrl+d находит аннотацию.
    await run(viewer, "diff.down")
    await run(viewer, "diff.annotate_delete")
    await run(viewer, "diff.annotate.confirm.accept")
    await until(() => !entriesWithColor(findDiffSides(viewer.app)[0].left, markBg()).includes(1))
  } finally {
    viewer.app.renderer.destroy()
  }
}, 10000)

test("editing an annotation keeps exactly one mark on the line (TC-45, AC-4/FR-3)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToMinusLine(viewer)
    await createAnnotationAtCursor(viewer, "one")
    // Курсор уведён с помеченной строки — пометка видна.
    await run(viewer, "diff.up")
    await until(() => entriesWithColor(findDiffSides(viewer.app)[0].left, markBg()).length === 1)
    // Правка текста не меняет факт помечки (spec §11).
    await run(viewer, "diff.down")
    await openEditor(viewer)
    await typeIntoFocused(viewer, "edited")
    await pressAltEnter(viewer)
    await until(() => getOrCreateDraft("session-1").visibleAnnotations()[0]?.text === "oneedited")
    await run(viewer, "diff.up")
    // пометка = факт наличия, не количество
    await until(() => entriesWithColor(findDiffSides(viewer.app)[0].left, markBg()).length === 1)
    expect(entriesWithColor(findDiffSides(viewer.app)[0].left, markBg())).toEqual([1])
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("cursor movement clamps at both ends without wrap-around (TC-48/49, AC-7/8/FR-4)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await until(() => footerCell(viewer.app) === "1")
    const start = footerCell(viewer.app)
    for (let i = 0; i < 5; i++) await run(viewer, "diff.up")
    for (let i = 0; i < 2; i++) await run(viewer, "diff.page.up")
    expect(footerCell(viewer.app)).toBe(start)
    // j — ровно одна контентная строка: контекст 1 → минус 2 → плюс 2 → контекст 3
    await run(viewer, "diff.down")
    expect(footerCell(viewer.app)).toBe("2")
    await run(viewer, "diff.down")
    expect(footerCell(viewer.app)).toBe("2")
    await run(viewer, "diff.down")
    expect(footerCell(viewer.app)).toBe("3")

    // до конца: последняя строка «3» (контекст), стоп без перескока в начало
    for (let i = 0; i < 20; i++) await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "3")
    for (let i = 0; i < 5; i++) await run(viewer, "diff.down")
    for (let i = 0; i < 2; i++) await run(viewer, "diff.page.down")
    expect(footerCell(viewer.app)).toBe("3")
    await run(viewer, "diff.up")
    expect(footerCell(viewer.app)).toBe("2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("] at the last hunk is a no-op; cursor stays in bounds (TC-50, AC-9/FR-4)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoHunks())
  try {
    await run(viewer, "diff.next_hunk")
    await until(() => /^\d+$/.test(footerCell(viewer.app)))
    const frame = viewer.app.captureCharFrame()
    for (let i = 0; i < 3; i++) await run(viewer, "diff.next_hunk")
    expect(footerCell(viewer.app)).toMatch(/^(?:\d+|—)$/)
    // no-op: кадр содержательно тот же (тот же файл/та же позиция заголовка ханка)
    expect(viewer.app.captureCharFrame().includes("ten-old")).toBe(frame.includes("ten-old"))
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("n at the last file keeps it; N (diff.previous_file) returns to the first (TC-51/TC-714, AC-9/AC-4)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoFiles())
  try {
    await run(viewer, "diff.next_file")
    await until(() => viewer.app.captureCharFrame().includes("other.ts"))
    for (let i = 0; i < 3; i++) await run(viewer, "diff.next_file")
    await viewer.app.flush()
    expect(viewer.app.captureCharFrame().includes("other.ts")).toBe(true)
    expect(footerCell(viewer.app)).toMatch(/^(?:\d+|—)$/)
    await run(viewer, "diff.previous_file")
    await until(() => viewer.app.captureCharFrame().includes("src/file.ts"))
  } finally {
    viewer.app.renderer.destroy()
  }
})

// Итерация 007: quarter-скролл J/K, N вместо p, открытие файла во внешнем
// редакторе (e). Реальный spawn перехватывается скриптом-редактором, пишущим
// свои аргументы в файл — без моков, в духе харнеса.

const FIXTURE_DIR = path.join("test", "tmp-editor-fixture")
const EDITOR_SCRIPT = path.join(FIXTURE_DIR, "editor.sh")
const EDITOR_ARGS = path.join(FIXTURE_DIR, "args.txt")
const RENAMED_PATCH = `--- a/test/tmp-editor-fixture/old.ts
+++ b/test/tmp-editor-fixture/renamed.ts
@@ -1,1 +1,1 @@
 one
-old line
+new4`

function setupEditorFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(path.join(FIXTURE_DIR, "renamed.ts"), "new line\n")
  // Скрипт-«редактор»: пишет аргументы запуска в args.txt и выходит — полный
  // suspend/spawn/resume-цикл выполняется по-настоящему.
  writeFileSync(EDITOR_SCRIPT, `#!/bin/sh\nprintf '%s\\n' "$@" > ${path.resolve(EDITOR_ARGS)}\n`)
  chmodSync(EDITOR_SCRIPT, 0o755)
}

function readEditorArgs(): string[] {
  try {
    return readFileSync(EDITOR_ARGS, "utf8").trim().split("\n").filter((line) => line.length > 0)
  } catch {
    return []
  }
}

test("J/K quarter-scroll in cursor mode clamps at both edges (TC-710/TC-712, AC-1..AC-3)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoHunks())
  try {
    expect(footerCell(viewer.app)).toBe("1")
    await run(viewer, "diff.scroll.down")
    await until(() => footerCell(viewer.app) !== "1")
    const after = footerCell(viewer.app)
    expect(after).not.toBe("1")
    for (let i = 0; i < 8; i++) await run(viewer, "diff.scroll.down")
    // Хвост списка: последняя контентная строка второго ханка — «11», кламп держит.
    await until(() => footerCell(viewer.app) === "11")
    for (let i = 0; i < 12; i++) await run(viewer, "diff.scroll.up")
    await until(() => footerCell(viewer.app) === "1")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("N/J/K/e cancel goto-file input; p no longer bound anywhere (TC-716, AC-5)", async () => {
  // Широкий кадр: ячейка «goto file: N» не переносится (паттерн TC-61x).
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    await typeIntoFocused(viewer, "3")
    await until(() => gotoFileInFrame(viewer.app, "3"))
    // e отменяет ввод и поглощается: ни spawn, ни toast (реальный ввод, паттерн TC-614).
    await typeIntoFocused(viewer, "e")
    await until(() => gotoFileAbsent(viewer.app))
    expect(viewer.toasts()).toHaveLength(0)
    // Повторный старт и отмена: буфер снова гаснет без side-эффектов.
    await run(viewer, "diff.gotofile.digit.2")
    await until(() => gotoFileInFrame(viewer.app, "2"))
    await viewer.app.mockInput.pressEscape()
    await until(() => gotoFileAbsent(viewer.app))
    // p больше не в cancel-листе и не является командной клавишей предыдущего файла.
    const [keybinds, dv, integration] = await Promise.all([
      Bun.file("src/config/keybind.ts").text(),
      Bun.file("src/feature-plugins/system/diff-viewer.tsx").text(),
      Bun.file("src/feature-plugins/system/diff-viewer-annotations/integration.tsx").text(),
    ])
    expect(keybinds).not.toContain('keybind("p"')
    for (const source of [dv, integration]) {
      expect(source).toContain("n,N,J,K,e,],[")
      expect(source).not.toContain("n,p,],[")
    }
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("e opens the existing (renamed/new) side of the diff file with +line (TC-717, AC-7/AC-10)", async () => {
  setupEditorFixture()
  const savedVisual = process.env.VISUAL
  const savedEditor = process.env.EDITOR
  process.env.VISUAL = path.resolve(EDITOR_SCRIPT)
  delete process.env.EDITOR
  const viewer = await renderAnnotationsViewer([
    {
      file: "test/tmp-editor-fixture/old.ts",
      patch: RENAMED_PATCH,
      additions: 1,
      deletions: 1,
      status: "modified",
    },
  ])
  try {
    await run(viewer, "diff.open_file")
    await until(() => readEditorArgs().length > 0, 8000)
    const args = readEditorArgs()
    // Курсор на первой контентной строке (+1); цель — новая сторона из +++ b/.
    expect(args).toContain("+1")
    expect(args[args.length - 1]).toBe("test/tmp-editor-fixture/renamed.ts")
    expect(viewer.toasts()).toHaveLength(0)
  } finally {
    process.env.VISUAL = savedVisual
    process.env.EDITOR = savedEditor
    viewer.app.renderer.destroy()
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
  }
})

test("e on a deleted file with no side on disk → toast, no launch (TC-718, AC-9)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff(), { withDeletedFile: true })
  try {
    // Второй (последний) файл — gone.ts.
    await run(viewer, "diff.next_file")
    await until(() => viewer.app.captureCharFrame().includes("only line"))
    await run(viewer, "diff.open_file")
    await until(() => viewer.toasts().some((toast) => toast.title === "File not found"))
    expect(viewer.toasts().some((toast) => toast.title === "No external editor")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("e without VISUAL/EDITOR → visible message, no launch (TC-719, AC-11)", async () => {
  // Файл существует на диске — резолв стороны проходит, гейт ловит отсутствие редактора.
  setupEditorFixture()
  const savedVisual = process.env.VISUAL
  const savedEditor = process.env.EDITOR
  delete process.env.VISUAL
  delete process.env.EDITOR
  const viewer = await renderAnnotationsViewer([
    {
      file: "test/tmp-editor-fixture/old.ts",
      patch: RENAMED_PATCH,
      additions: 1,
      deletions: 1,
      status: "modified",
    },
  ])
  try {
    await run(viewer, "diff.open_file")
    expect(viewer.toasts().some((toast) => toast.title === "No external editor")).toBe(true)
    expect(viewer.toasts().some((toast) => toast.title === "File not found")).toBe(false)
  } finally {
    process.env.VISUAL = savedVisual
    process.env.EDITOR = savedEditor
    viewer.app.renderer.destroy()
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
  }
})

test("e under an open overlay is inert — no external editor from under the overlay (TC-720, AC-12)", async () => {
  setupEditorFixture()
  const savedVisual = process.env.VISUAL
  const savedEditor = process.env.EDITOR
  process.env.VISUAL = path.resolve(EDITOR_SCRIPT)
  delete process.env.EDITOR
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await openEditor(viewer)
    await viewer.app.mockInput.typeText("e")
    await Bun.sleep(100)
    expect(readEditorArgs()).toHaveLength(0)
    expect(viewer.toasts()).toHaveLength(0)
  } finally {
    process.env.VISUAL = savedVisual
    process.env.EDITOR = savedEditor
    viewer.app.renderer.destroy()
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
  }
})

test("send closes the viewer immediately; one prompt call; resolve consumes the draft (TC-53/54/57, AC-10/FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "send me")
    await run(viewer, "diff.close")
    // начальный фокус 0 — «Отправить» (FR-X3); промис не резолвится — закрытие не ждёт его
    viewer.setPrompt(() => new Promise(() => {}))
    await run(viewer, "diff.annotate.exit.choose")
    const closed = () => (viewer.current() as { name: string }).name === "session"
    await viewer.app.waitFor(closed)
    expect(viewer.promptCalls()).toHaveLength(1)
    const text = viewer.promptCalls()[0].request.parts[0].text
    expect(text).toContain("Замечания по diff (1)")
    expect(text).toContain("send me")

    // повторный enter до resolve — гард sendInitiated, дубля нет (TC-54)
    await run(viewer, "diff.annotate.exit.choose")
    expect(viewer.promptCalls()).toHaveLength(1)

    // resolve недоступен у зависшего промиса — черновик жив до доказательства;
    // здесь проверяем resolve-путь отдельным прогоном ниже.
    expect(draftExists("session-1")).toBe(true)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("resolve consumes the draft; no toast (TC-57, AC-10/FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "resolved")
    await run(viewer, "diff.close")
    await run(viewer, "diff.annotate.exit.choose")
    await viewer.app.waitFor(() => (viewer.current() as { name: string }).name === "session")
    await until(() => !draftExists("session-1"))
    expect(viewer.toasts()).toHaveLength(0)
  } finally {
    viewer.app.renderer.destroy()
  }
}, 10000)

test("rejection with the message already fixed consumes the draft (TC-56, AC-11/FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "fixed but failed")
    await run(viewer, "diff.close")
    viewer.setPrompt(async () => {
      throw new Error("run crashed")
    })
    await run(viewer, "diff.annotate.exit.choose")
    await viewer.app.waitFor(() => (viewer.current() as { name: string }).name === "session")
    // сообщение уже в истории: фиксация была, сломался прогон
    const text = viewer.promptCalls()[0].request.parts[0].text
    viewer.setMessages([{ id: "m1", role: "user", text, type: "user", time: { created: 0 } }])
    await until(() => !draftExists("session-1"), 5000)
    expect(viewer.toasts()).toHaveLength(0)
  } finally {
    viewer.app.renderer.destroy()
  }
}, 10000)

test("rejection with no message keeps the draft and shows a toast (TC-55, AC-11/FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "retry me")
    await run(viewer, "diff.close")
    viewer.setPrompt(async () => {
      throw new Error("network down")
    })
    await run(viewer, "diff.annotate.exit.choose")
    await viewer.app.waitFor(() => (viewer.current() as { name: string }).name === "session")
    // истории нет и не появится: после догона — toast, черновик цел
    await until(() => viewer.toasts().some((toast) => toast.title === "Ошибка отправки замечаний"), 9000)
    expect(draftExists("session-1")).toBe(true)
    expect(getOrCreateDraft("session-1").count()).toBe(1)
  } finally {
    viewer.app.renderer.destroy()
  }
}, 15000)

test("undefined message store is inconclusive: no toast until confirmed absence (TC-58, FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "lazy store")
    await run(viewer, "diff.close")
    viewer.setPrompt(async () => {
      throw new Error("boom")
    })
    await run(viewer, "diff.annotate.exit.choose")
    await viewer.app.waitFor(() => (viewer.current() as { name: string }).name === "session")
    viewer.setMessages(undefined)
    await Bun.sleep(1500)
    expect(viewer.toasts()).toHaveLength(0)
    expect(draftExists("session-1")).toBe(true)
    // стор догнал, сообщения нет → toast, черновик цел
    viewer.setMessages([])
    await until(() => viewer.toasts().some((toast) => toast.title === "Ошибка отправки замечаний"), 9000)
    expect(draftExists("session-1")).toBe(true)
  } finally {
    viewer.app.renderer.destroy()
  }
}, 15000)

test("reopen with a hung send classifies against history and consumes the draft (TC-59, FR-5)", async () => {
  const first = await renderAnnotationsViewer(withDiff())
  let text = ""
  try {
    await cursorToFirstBodyLine(first)
    await createAnnotationAtCursor(first, "hung send")
    await run(first, "diff.close")
    first.setPrompt(() => new Promise(() => {}))
    await run(first, "diff.annotate.exit.choose")
    await first.app.waitFor(() => (first.current() as { name: string }).name === "session")
    text = first.promptCalls()[0].request.parts[0].text
  } finally {
    first.app.renderer.destroy()
  }

  // сообщение зафиксировано уже после закрытия: переоткрытие запускает догоняющую
  // классификацию по живому sendInitiated в записи реестра.
  const second = await renderAnnotationsViewer(withDiff())
  try {
    second.setMessages([{ id: "m1", role: "user", text, type: "user", time: { created: 0 } }])
    await second.app.waitForFrame((frame) => frame.includes("const first"))
    await until(() => !draftExists("session-1"), 5000)
  } finally {
    second.app.renderer.destroy()
  }
}, 10000)

test("busy session does not delay closing (TC-60, AC-12/FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "busy")
    await run(viewer, "diff.close")
    viewer.setPrompt(() => new Promise(() => {}))
    await run(viewer, "diff.annotate.exit.choose")
    await viewer.app.waitFor(() => (viewer.current() as { name: string }).name === "session")
    expect(viewer.promptCalls()).toHaveLength(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("exit dialog has no sending machine: no waiting or error frames (TC-61, FR-5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "dialog")
    await run(viewer, "diff.close")
    await viewer.app.waitForFrame((frame) => frame.includes("Сохранить"))
    const frame = viewer.app.captureCharFrame()
    expect(frame.includes("Отправка…")).toBe(false)
    expect(frame.includes("Ошибка отправки")).toBe(false)
    await run(viewer, "diff.annotate.exit.cancel")
    await viewer.app.flush()
    expect((viewer.current() as { name: string }).name).toBe("diff")
    expect(getOrCreateDraft("session-1").count()).toBe(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("sessionless viewer cannot send; save-draft keeps the sessionless draft (FR-C4/X3, AC-23/34)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff(), {
    initialRoute: { name: "diff", params: { mode: "git", returnRoute: startRoute } },
  })
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "no session")
    await run(viewer, "diff.close")
    // «Отправить» недоступна с пояснением; начальный фокус — «Сохранить черновик» (FR-X3)
    await viewer.app.waitForFrame((frame) => frame.includes("нет сессии-владельца"))
    await run(viewer, "diff.annotate.exit.choose")
    const closed = () => (viewer.current() as { name: string }).name === "session"
    await viewer.app.waitFor(closed)
    expect(viewer.promptCalls()).toHaveLength(0)
    expect(draftExists(SESSIONLESS_OWNER)).toBe(true)
    expect(getOrCreateDraft(SESSIONLESS_OWNER).count()).toBe(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("reopening the viewer with a live draft asks for a fresh snapshot; decline cancels opening (FR-S5, AC-31)", async () => {
  const draft = getOrCreateDraft("session-1")
  draft.openCreate({ filePath: "src/file.ts", side: "old", line: 2, hunk: 1, window: ["const first = true", "const oldSecond = true"], anchorOffset: 1 })
  draft.confirmEditor("survivor")

  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("Обновить снапшот диффа?"))
    expect(viewer.commands.has("diff.annotate.confirm.decline")).toBe(true)
    // pressEscape отклоняет: открытие отменяется, черновик нетронут (FR-S5/S3)
    await run(viewer, "diff.annotate.confirm.decline")
    const back = () => (viewer.current() as { name: string }).name === "session"
    await viewer.app.waitFor(back)
    expect(getOrCreateDraft("session-1").count()).toBe(1)
    expect(getOrCreateDraft("session-1").visibleAnnotations()[0].text).toBe("survivor")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("saved draft reopened with a fresh snapshot restores marks in renderer maps (TC-47, AC-6/FR-3)", async () => {
  const first = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToMinusLine(first)
    await createAnnotationAtCursor(first, "survivor mark")
    // Курсор вытесняет пометку — уводим перед проверкой.
    await run(first, "diff.up")
    await until(() => entriesWithColor(findDiffSides(first.app)[0].left, markBg()).includes(1))
    // escape → диалог → tab до «Сохранить черновик» → enter
    await run(first, "diff.close")
    await first.app.waitForFrame((frame) => frame.includes("Сохранить"))
    await run(first, "diff.annotate.exit.next")
    await run(first, "diff.annotate.exit.choose")
    await first.app.waitFor(() => (first.current() as { name: string }).name === "session")
    expect(draftExists("session-1")).toBe(true)
  } finally {
    first.app.renderer.destroy()
  }

  const second = await renderAnnotationsViewer(withDiff())
  try {
    await second.app.waitForFrame((frame) => frame.includes("Обновить снапшот диффа?"))
    await run(second, "diff.annotate.confirm.accept")
    await until(() => entriesWithColor(findDiffSides(second.app)[0].left, markBg()).includes(1), 5000)
  } finally {
    second.app.renderer.destroy()
  }
}, 10000)

test("diff.open from the diff route is an idempotent no-op (TC-62, AC-14/FR-6)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await until(() => (viewer.current() as { name: string }).name === "diff")
    await run(viewer, "diff.open")
    expect((viewer.current() as { name: string }).name).toBe("diff")
    await run(viewer, "diff.close")
    await viewer.app.waitFor(() => (viewer.current() as { name: string }).name === "session")
    // returnRoute не переписан на diff-роут — возврат в сессию, не зацикливание
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("help dialog lists the open-viewer shortcut (TC-63, AC-14/FR-6)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await run(viewer, "diff.help")
    // Дерево файлов просвечивает сквозь диалог (наложение слоёв): строка
    // «Open diff viewer» может быть частично перекрыта глифами дерева —
    // проверяем фрагменты независимо, как в gotoInFrame.
    await viewer.app.waitForFrame((frame) => frame.includes("diff viewer"))
  } finally {
    viewer.app.renderer.destroy()
  }
})

// Узкая ячейка футера переносит «goto: N» и смешивает с колонками подсказок —
// проверяем оба осколка независимо.
function gotoInFrame(app: Awaited<ReturnType<typeof testRender>>, digits: string): boolean {
  const frame = app.captureCharFrame()
  return frame.includes("goto") && frame.includes(`: ${digits}`)
}

test("goto line: digits buffer in footer, enter jumps, escape cancels without closing (FR-4.x)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await until(() => footerCell(viewer.app) === "1")
    await run(viewer, "diff.goto.digit.3")
    await until(() => gotoInFrame(viewer.app, "3"))
    await run(viewer, "diff.goto.commit")
    await viewer.app.flush()
    await until(() => footerCell(viewer.app) === "3")
    // escape в активном режиме поглощается слоем goto — viewer не закрывается
    await run(viewer, "diff.goto.digit.9")
    await until(() => gotoInFrame(viewer.app, "9"))
    await viewer.app.mockInput.pressEscape()
    await viewer.app.flush()
    await until(() => footerCell(viewer.app) === "3")
    expect((viewer.current() as { name: string }).name).toBe("diff")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("compact view is default-on; «c» toggles back to the full patch (FR-8.x)", async () => {
  const viewer = await renderAnnotationsViewer([
    { file: "big.ts", patch: LONG_PATCH, additions: 2, deletions: 2, status: "modified" },
  ], { width: 200 })
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("new4"))
    // дальний контекст скрыт, ближний — виден
    expect(viewer.app.captureCharFrame().includes("c7")).toBe(false)
    expect(viewer.app.captureCharFrame().includes("c6")).toBe(true)
    await run(viewer, "diff.compact_toggle")
    await viewer.app.waitForFrame((frame) => frame.includes("c7"))
    // повторный тумгл возвращает компакт
    await run(viewer, "diff.compact_toggle")
    await viewer.app.waitForFrame((frame) => !frame.includes("c7"))
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("enter on a file in the tree shows it and moves focus to the patch pane (FR-3.x)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoFiles())
  try {
    await until(() => footerCell(viewer.app) === "1")
    await run(viewer, "diff.switch_focus")
    await run(viewer, "diff.annotate")
    await viewer.app.flush()
    // фокус в патчах: j двигает курсор (футер 1 → 2), а не выделение дерева
    await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

// Кадровый ряд (0-based) первого вхождения текста — для якорных ассертов.
function frameRow(app: Awaited<ReturnType<typeof testRender>>, text: string): number {
  const lines = (app.captureCharFrame() as string).split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  return row
}

test("letters typed in the annotation editor never trigger panel commands (TC-510, FR-2.1/2.2)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "target")
    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("target"))
    // «e» панели открывает редактор над листингом
    await run(viewer, "diff.annotate.panel.edit")
    await until(() => findTextarea(viewer.app.renderer.root) !== undefined)
    // Протекавшие раньше клавиши: d (удалить), j/k (навигация), a (закрыть),
    // e (правка) — теперь просто текст в поле ввода.
    await typeIntoFocused(viewer, "djkae")
    await viewer.app.flush()
    // Правка префиллится текстом записи — введённое добавляется к нему
    expect(findTextarea(viewer.app.renderer.root)?.plainText).toBe("targetdjkae")
    // Ни confirm удаления, ни закрытия панели, ни второго редактора
    expect(viewer.app.captureCharFrame().includes("Удалить замечание?")).toBe(false)
    expect(viewer.app.captureCharFrame().includes("Замечания")).toBe(true)
    await run(viewer, "diff.annotate.editor.cancel")
    await until(() => findTextarea(viewer.app.renderer.root) === undefined)
    expect(viewer.app.captureCharFrame().includes("Замечания")).toBe(true)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("enter is a newline in the editor; escape cancels and returns ownership to the panel (TC-511, FR-2.3/2.5)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "multiline")
    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("multiline"))
    await run(viewer, "diff.annotate.panel.edit")
    await until(() => findTextarea(viewer.app.renderer.root) !== undefined)
    // enter — перевод строки, не подтверждение листинга
    await typeIntoFocused(viewer, "ab")
    viewer.app.mockInput.pressEnter()
    await viewer.app.flush()
    expect(findTextarea(viewer.app.renderer.root)?.plainText).toBe("multilineab\n")
    // escape закрывает редактор без сохранения; панель снова владеет клавиатурой
    await run(viewer, "diff.annotate.editor.cancel")
    await until(() => findTextarea(viewer.app.renderer.root) === undefined)
    expect(viewer.app.captureCharFrame().includes("Замечания")).toBe(true)
    await run(viewer, "diff.annotate.panel.close")
    await viewer.app.flush()
    expect(viewer.app.captureCharFrame().includes("Замечания")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("ctrl+d is a no-op in the editor and confirm layers (TC-512/TC-521, FR-2.4)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await openEditor(viewer)
    await until(() => findTextarea(viewer.app.renderer.root) !== undefined)
    // Слой редактора глотает ctrl+d — app_exit недостижим
    expect(viewer.commands.has("diff.annotate.editor.noop")).toBe(true)
    await run(viewer, "diff.annotate.editor.noop")
    expect(viewer.app.captureCharFrame().includes("Сохранить")).toBe(false)
    await run(viewer, "diff.annotate.editor.cancel")

    // Тот же гайд в confirm-диалоге удаления; панель под ним остаётся живой:
    // escape отменяет только подтверждение, не листинг
    await createAnnotationAtCursor(viewer, "doomed")
    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("doomed"))
    await run(viewer, "diff.annotate.panel.delete")
    await viewer.app.waitForFrame((frame) => frame.includes("Удалить замечание?"))
    expect(viewer.commands.has("diff.annotate.confirm.noop")).toBe(true)
    await run(viewer, "diff.annotate.confirm.noop")
    expect(getOrCreateDraft("session-1").count()).toBe(1)
    await run(viewer, "diff.annotate.confirm.decline")
    expect(getOrCreateDraft("session-1").count()).toBe(1)
    await viewer.app.flush()
    expect(viewer.app.captureCharFrame().includes("Замечания")).toBe(true)
    expect(viewer.app.captureCharFrame().includes("Удалить замечание?")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("panel closes after an editor opened on top of it — the remark-3 scenario (TC-520, FR-3.1/3.2)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "note")
    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("note"))
    // Правка из панели: редактор над листингом; набираем «e» в поле —
    // раньше клавиша протекала в слой листинга и дублировала editor в стеке.
    await run(viewer, "diff.annotate.panel.edit")
    await until(() => findTextarea(viewer.app.renderer.root) !== undefined)
    await typeIntoFocused(viewer, "e")
    await viewer.app.flush()
    expect(findTextarea(viewer.app.renderer.root)?.plainText).toBe("notee")
    // Одно escape полностью убирает редактор
    await run(viewer, "diff.annotate.editor.cancel")
    await until(() => findTextarea(viewer.app.renderer.root) === undefined)
    // Листинг остаётся верхним surface и закрывается одним жестом
    await run(viewer, "diff.annotate.panel.close")
    await viewer.app.flush()
    expect(viewer.app.captureCharFrame().includes("Замечания")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("empty annotations panel opens and closes (TC-522, FR-3.4)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff())
  try {
    await cursorToFirstBodyLine(viewer)
    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("Пусто"))
    await run(viewer, "diff.annotate.panel.close")
    await viewer.app.flush()
    expect(viewer.app.captureCharFrame().includes("Пусто")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("compact toggle keeps the anchor line at its screen position (TC-230)", async () => {
  const viewer = await renderAnnotationsViewer([{ file: "src/big.ts", patch: LONG_PATCH, additions: 2, deletions: 2, status: "modified" }], { height: 12 })
  try {
    await until(() => viewer.app.captureCharFrame().includes("new4"))
    for (let i = 0; i < 3; i++) await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "4")
    const anchorRowBefore = frameRow(viewer.app, "new4")
    await run(viewer, "diff.compact_toggle")
    // Якорный скролл применяется двумя кадрами — даём кадрам пройти.
    await Bun.sleep(150)
    await viewer.app.flush()
    expect(frameRow(viewer.app, "new4")).toBe(anchorRowBefore)
    // Обратный тумгл тоже сохраняет экранную позицию якоря.
    await run(viewer, "diff.compact_toggle")
    await Bun.sleep(150)
    await viewer.app.flush()
    expect(frameRow(viewer.app, "new4")).toBe(anchorRowBefore)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("compact toggle from a line hidden in compact mode relocates deterministically (TC-231)", async () => {
  const viewer = await renderAnnotationsViewer([{ file: "src/big.ts", patch: LONG_PATCH, additions: 2, deletions: 2, status: "modified" }], { height: 12 })
  try {
    await until(() => viewer.app.captureCharFrame().includes("new4"))
    await run(viewer, "diff.compact_toggle")
    await Bun.sleep(150)
    await viewer.app.flush()
    // Курсор на c7 — строке, скрытой компакт-режимом (c2 → c7 — шесть шагов).
    for (let i = 0; i < 6; i++) await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "7")
    const anchorRowBefore = frameRow(viewer.app, "c7")
    await run(viewer, "diff.compact_toggle")
    await Bun.sleep(150)
    await viewer.app.flush()
    // Курсор relocated на видимую контентную строку, экранная позиция якоря
    // сохранена в пределах клампа (верх скролла).
    expect(Number(footerCell(viewer.app))).toBeGreaterThan(0)
    const relocated = Number(footerCell(viewer.app))
    expect(Math.abs(frameRow(viewer.app, `c${relocated}`) - anchorRowBefore)).toBeLessThanOrEqual(1)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("bracket hotkeys navigate hunks with swapped semantics and stop at boundaries (TC-240)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoHunks())
  try {
    await until(() => viewer.app.captureCharFrame().includes("ten-new"))
    await run(viewer, "diff.next_hunk")
    await until(() => viewer.app.captureCharFrame().includes("ten-new"))
    // Граница: за последним ханком further next не двигает курсор с конца.
    await run(viewer, "diff.next_hunk")
    await run(viewer, "diff.next_hunk")
    await viewer.app.flush()
    // previous возвращает к первому ханку.
    await run(viewer, "diff.previous_hunk")
    await until(() => viewer.app.captureCharFrame().includes("two!"))
    // Курсор жив: навигация по-прежнему идёт по контентным строкам (INV-1/3).
    await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("footer help reflects the swapped bracket bindings (TC-241)", async () => {
  const viewer = await renderAnnotationsViewer(withTwoHunks(), { width: 200 })
  try {
    await until(() => viewer.app.captureCharFrame().includes("two!"))
    const hints = (viewer.app.captureCharFrame() as string).replace(/\s+/g, " ")
    expect(hints.includes("[ next hunk")).toBe(true)
    expect(hints.includes("] previous hunk")).toBe(true)
  } finally {
    viewer.app.renderer.destroy()
  }
})

// ---------------------------------------------------------------------------
// Goto-файл в дереве (итерация 006): цифровой буфер в фокусе дерева, зеркальный
// goto-строке. Кадровые ассерты — «goto file» отдельно от «goto» строки.
// ---------------------------------------------------------------------------

// Широкий кадр (width 200): ячейка «goto file: N» футера не переносится,
// матчим контигуозно.
function frameText(app: Awaited<ReturnType<typeof testRender>>): string {
  return (app.captureCharFrame() as string | undefined) ?? ""
}

function gotoFileInFrame(app: Awaited<ReturnType<typeof testRender>>, digits: string): boolean {
  return frameText(app).includes(`goto file: ${digits}`)
}

function gotoFileAbsent(app: Awaited<ReturnType<typeof testRender>>): boolean {
  return !frameText(app).includes("goto file:")
}

const withThreeFiles = () => [
  { file: "src/file.ts", patch: PATCH, additions: 1, deletions: 1, status: "modified" },
  { file: "other.ts", patch: SECOND_FILE, additions: 1, deletions: 1, status: "modified" },
  { file: "z/last.ts", patch: TWO_HUNKS, additions: 2, deletions: 2, status: "modified" },
]

// 12 файлов в трёх каталогах; плоский порядок (алфавит внутри каталога):
// dir0: f0,f3,f6,f9 · dir1: f1,f10,f4,f7 · dir2: f2,f5,f8,f11 — №12 = f11.ts.
const withTwelveFiles = () =>
  Array.from({ length: 12 }, (_, i) => ({
    file: `dir${i % 3}/f${i}.ts`,
    patch: PATCH,
    additions: 1,
    deletions: 1,
    status: "modified" as const,
  }))

// Фокус в дереве + подтверждённая готовность диффа.
async function focusFileTree(handle: HarnessHandle) {
  await until(() => footerCell(handle.app) === "1")
  await run(handle, "diff.switch_focus")
  await handle.app.flush()
}

test("goto file: valid number jumps, reveals the file and moves focus to patches (TC-610/AC-1)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    await run(viewer, "diff.gotofile.digit.2")
    await until(() => gotoFileInFrame(viewer.app, "2"))
    await run(viewer, "diff.gotofile.commit")
    await viewer.app.flush()
    await until(() => gotoFileAbsent(viewer.app))
    // Фокус ушёл в патчи: j двигает курсор (номер в футере 1 → 2)
    await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: multi-digit number does not fire early (TC-611/AC-2)", async () => {
  const viewer = await renderAnnotationsViewer(withTwelveFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    await run(viewer, "diff.gotofile.digit.1")
    await until(() => gotoFileInFrame(viewer.app, "1"))
    await run(viewer, "diff.gotofile.append.2")
    await until(() => gotoFileInFrame(viewer.app, "12"))
    await run(viewer, "diff.gotofile.commit")
    await viewer.app.flush()
    await until(() => gotoFileAbsent(viewer.app))
    // Файл №12 раскрыт и выбран; фокус в патчах
    expect(viewer.app.captureCharFrame().includes("f11.ts")).toBe(true)
    await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: zero, out-of-range and empty input are a quiet reset (TC-612/AC-6/7)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    for (const digit of ["9", "0"]) {
      await run(viewer, `diff.gotofile.digit.${digit}`)
      await until(() => gotoFileInFrame(viewer.app, digit))
      await run(viewer, "diff.gotofile.commit")
      await viewer.app.flush()
      // Тихий сброс: буфер скрыт, фокус остался в дереве
      await until(() => gotoFileAbsent(viewer.app))
    }
    // enter на пустом буфере — no-op без ошибок
    await run(viewer, "diff.gotofile.commit")
    await viewer.app.flush()
    expect(gotoFileAbsent(viewer.app)).toBe(true)
    // Фокус в дереве: switch_focus возвращает в патчи, j там двигает курсор
    await run(viewer, "diff.switch_focus")
    await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: escape mid-input cancels without side effects (TC-613/AC-8)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    await run(viewer, "diff.gotofile.digit.1")
    await until(() => gotoFileInFrame(viewer.app, "1"))
    await viewer.app.mockInput.pressEscape()
    await viewer.app.flush()
    await until(() => gotoFileAbsent(viewer.app))
    expect((viewer.current() as { name: string }).name).toBe("diff")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: command key typed during input cancels and is swallowed (TC-614/AC-11)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    // Цифра запускает режим через реальный ввод
    await typeIntoFocused(viewer, "3")
    await until(() => gotoFileInFrame(viewer.app, "3"))
    // Навигационная клавиша viewer отменяет ввод и поглощается: буфер исчез,
    // viewer не закрылся и не перешёл к файлу
    await typeIntoFocused(viewer, "j")
    await until(() => gotoFileAbsent(viewer.app))
    expect((viewer.current() as { name: string }).name).toBe("diff")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: digits beyond the buffer cap are silently ignored (TC-615/AC-13)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    for (let i = 0; i < 9; i++) await run(viewer, "diff.gotofile.append.9")
    await until(() => gotoFileInFrame(viewer.app, "9999999"))
    expect(viewer.app.captureCharFrame().includes(": 99999999")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: backspace to empty exits the mode; new digit starts fresh (TC-616/AC-23)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    await run(viewer, "diff.gotofile.digit.1")
    await run(viewer, "diff.gotofile.append.2")
    await until(() => gotoFileInFrame(viewer.app, "12"))
    await run(viewer, "diff.gotofile.backspace")
    await until(() => gotoFileInFrame(viewer.app, "1"))
    await run(viewer, "diff.gotofile.backspace")
    await until(() => gotoFileAbsent(viewer.app))
    // Третий backspace — выход без побочных эффектов; новый ввод — новый буфер
    await run(viewer, "diff.gotofile.backspace")
    await run(viewer, "diff.gotofile.digit.2")
    await until(() => gotoFileInFrame(viewer.app, "2"))
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: numbers survive directory collapsing (flat order) (TC-617/AC-14)", async () => {
  const viewer = await renderAnnotationsViewer([
    { file: "a/x.ts", patch: PATCH, additions: 1, deletions: 1, status: "modified" },
    { file: "a/y.ts", patch: TWO_HUNKS, additions: 2, deletions: 2, status: "modified" },
    { file: "z.ts", patch: SECOND_FILE, additions: 1, deletions: 1, status: "modified" },
  ], { width: 200 })
  try {
    await focusFileTree(viewer)
    // Выделение на первом файле a/x.ts → collapse уходит на родителя a,
    // повторный collapse сворачивает каталог
    await run(viewer, "diff.collapse")
    await run(viewer, "diff.collapse")
    await viewer.app.flush()
    // №2 по плоскому порядку — a/y.ts, несмотря на свёрнутый каталог
    await run(viewer, "diff.gotofile.digit.2")
    await until(() => gotoFileInFrame(viewer.app, "2"))
    await run(viewer, "diff.gotofile.commit")
    await viewer.app.flush()
    await until(() => gotoFileAbsent(viewer.app))
    await run(viewer, "diff.down")
    await until(() => footerCell(viewer.app) === "2")
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: hidden tree (single file) keeps digits inert; goto line still works (TC-618/AC-15)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff(), { width: 200 })
  try {
    await until(() => footerCell(viewer.app) === "1")
    await typeIntoFocused(viewer, "3")
    await viewer.app.flush()
    expect(gotoFileAbsent(viewer.app)).toBe(true)
    // goto-строка в фокусе патчей продолжает работать
    await run(viewer, "diff.goto.digit.3")
    await until(() => gotoInFrame(viewer.app, "3"))
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: mutual exclusion with goto line; focus loss resets the buffer (TC-619/AC-21/22)", async () => {
  const viewer = await renderAnnotationsViewer(withThreeFiles(), { width: 200 })
  try {
    await focusFileTree(viewer)
    await typeIntoFocused(viewer, "3")
    await until(() => gotoFileInFrame(viewer.app, "3"))
    // Уход фокуса в патчи сбрасывает буфер дерева; goto-строка активна
    await run(viewer, "diff.switch_focus")
    await until(() => gotoFileAbsent(viewer.app))
    await run(viewer, "diff.goto.digit.4")
    await until(() => gotoInFrame(viewer.app, "4"))
    expect(gotoFileAbsent(viewer.app)).toBe(true)
    // Назад в дерево: старый буфер не восстановился, новый ввод — новый буфер
    await run(viewer, "diff.switch_focus")
    await until(() => !viewer.app.captureCharFrame().includes("goto: 4"))
    await run(viewer, "diff.gotofile.digit.3")
    await until(() => gotoFileInFrame(viewer.app, "3"))
    expect(viewer.app.captureCharFrame().includes("goto: 3")).toBe(false)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("goto file: overlays own the input; opening one resets a live buffer (TC-620/AC-9/10)", async () => {
  const viewer = await renderAnnotationsViewer(withDiff(), { width: 200 })
  try {
    await cursorToFirstBodyLine(viewer)
    await createAnnotationAtCursor(viewer, "target")
    await run(viewer, "diff.annotations_panel")
    await viewer.app.waitForFrame((frame) => frame.includes("target"))
    // Оверлей владеет вводом: цифры не попадают в goto-буфер
    await typeIntoFocused(viewer, "12")
    await viewer.app.flush()
    expect(gotoFileAbsent(viewer.app)).toBe(true)
    // Живой буфер сбрасывается открытием оверлея и не возобновляется
    await run(viewer, "diff.annotate.panel.close")
    await focusFileTree(viewer)
    await typeIntoFocused(viewer, "3")
    await until(() => gotoFileInFrame(viewer.app, "3"))
    await run(viewer, "diff.annotations_panel")
    await viewer.app.flush()
    await until(() => gotoFileAbsent(viewer.app))
    await run(viewer, "diff.annotate.panel.close")
    await viewer.app.flush()
    expect(gotoFileAbsent(viewer.app)).toBe(true)
  } finally {
    viewer.app.renderer.destroy()
  }
})
