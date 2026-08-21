/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import {
  TextAttributes,
  type BorderSides,
  type BoxRenderable,
  type DiffRenderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { LANGUAGE_EXTENSIONS } from "../../util/filetype"
import { useBindings, useCommandShortcut } from "../../keymap"
import { useTheme } from "../../context/theme"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { DiffViewerFileTree } from "./diff-viewer-file-tree"
import { Panel, PanelGroup, Separator, helpKeyColumnWidth } from "./diff-viewer-ui"
import { createDiffAnnotations } from "./diff-viewer-annotations/integration"
import { compactPatchText } from "./diff-viewer-annotations/compact-visibility"
import { gotoFileTarget, gotoTransition } from "./diff-viewer-annotations/goto"
import type { DiffFile } from "./diff-viewer-annotations/patch-lines"
import { quarterViewport } from "./diff-viewer-annotations/patch-cursor"
import { resolveEditableFile } from "./diff-viewer-annotations/editor-target"
import { openFileInEditor } from "../../editor"
import { DialogSelect } from "../../ui/dialog-select"
import { getScrollAcceleration } from "../../util/scroll"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  type FileTreeRow,
  flattenFileTree,
  moveFileTreeSelection,
  moveFileTreeSelectionToFirstChild,
  moveFileTreeSelectionToParent,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  setFileTreeDirectoryExpanded,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  toggleFileTreeDirectory,
} from "./diff-viewer-file-tree-utils"

const ROUTE = "diff"
const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 32
const PLAIN_TEXT_FILETYPE = "opencode-plain-text"
const VCS_DIFF_CONTEXT_LINES = 12
const KV_SHOW_FILE_TREE = "diff_viewer_show_file_tree"
const KV_SINGLE_PATCH = "diff_viewer_single_patch"
const KV_VIEW = "diff_viewer_view"
type DiffMode = "git" | "branch" | "last-turn"
type DiffViewerFocus = "patches" | "files"
type DiffView = "split" | "unified"
type SelectedHunk = { readonly fileIndex: number; readonly hunkIndex: number; readonly scrollTop: number }

// Компактный режим включается при каждом открытии viewer, но переживает внутреннюю
// смену источника («o»): ручка живёт между монтированиями компонента маршрута.
let compactOnOpen = true

const normalizeDiffs = (diffs: readonly (VcsFileDiff | SnapshotFileDiff)[]): DiffFile[] =>
  diffs.flatMap((item) =>
    item.file
      ? [
          {
            file: item.file,
            patch: item.patch,
            additions: item.additions,
            deletions: item.deletions,
            status: item.status ?? "modified",
          } satisfies DiffFile,
        ]
      : [],
  )

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function storedView(value: unknown): DiffView | undefined {
  if (value === "split" || value === "unified") return value
}

function diffSourceLabel(mode: DiffMode) {
  if (mode === "last-turn") return "last turn"
  if (mode === "branch") return "main branch"
  return "working tree"
}

function DiffViewer(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const themeState = useTheme()
  const theme = () => props.api.theme.current
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | {
          mode?: DiffMode
          sessionID?: string
          messageID?: string
          returnRoute?: TuiRouteCurrent
        }
      | undefined
  const mode = () => params()?.mode ?? "git"
  const diffInput = createMemo(() => {
    const sessionID = params()?.sessionID
    return {
      mode: mode(),
      sessionID,
      messageID: params()?.messageID,
      directory: sessionID ? props.api.state.session.get(sessionID)?.directory : undefined,
    }
  })
  const [diff] = createResource(diffInput, async (input) => {
    if (input.mode === "last-turn") {
      const sessionID = input.sessionID
      if (!sessionID) return []
      const result = await props.api.client.session.diff(
        { sessionID, messageID: input.messageID },
        { throwOnError: true },
      )
      return normalizeDiffs(result.data ?? [])
    }

    const result = await props.api.client.vcs.diff(
      { directory: input.directory, mode: input.mode, context: VCS_DIFF_CONTEXT_LINES },
      { throwOnError: true },
    )
    return normalizeDiffs(result.data ?? [])
  })
  const files = createMemo(() => diff() ?? [])
  const [focus, setFocus] = createSignal<DiffViewerFocus>("patches")
  const [fileTreeEnabled, setFileTreeEnabled] = createSignal(
    props.api.kv.get<boolean>(KV_SHOW_FILE_TREE, true) !== false,
  )
  const showFileTree = createMemo(() => showDiffViewerFileTree(fileTreeEnabled(), files().length))
  const [singlePatch, setSinglePatch] = createSignal(props.api.kv.get<boolean>(KV_SINGLE_PATCH, false) === true)
  const patchPaneWidth = createMemo(() => dimensions().width - (showFileTree() ? 33 : 0) - 4)
  const patchLeftBorder = createMemo<BorderSides[]>(() => (showFileTree() ? ["left"] : []))
  const splitAvailable = createMemo(() => patchPaneWidth() >= MIN_SPLIT_WIDTH)
  const defaultView = createMemo(() => {
    if (props.api.tuiConfig.diff_style === "stacked") return "unified"
    return splitAvailable() ? "split" : "unified"
  })
  const [viewOverride, setViewOverride] = createSignal<DiffView | undefined>(storedView(props.api.kv.get(KV_VIEW)))
  const view = createMemo(() => (splitAvailable() ? (viewOverride() ?? defaultView()) : "unified"))
  const fileTree = createMemo(() => buildFileTree(files()))
  const [expandedFileNodes, setExpandedFileNodes] = createSignal<ReadonlySet<number>>(new Set())
  const [highlightedFileNode, setHighlightedFileNode] = createSignal<number | undefined>()
  const [lastHighlightedFileNode, setLastHighlightedFileNode] = createSignal<number | undefined>()
  const [activePatchFileIndex, setActivePatchFileIndex] = createSignal<number | undefined>()
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | undefined>()
  const [reviewedFileNames, setReviewedFileNames] = createSignal<ReadonlySet<string>>(new Set())
  const patchScrollAcceleration = createMemo(() => getScrollAcceleration(props.api.tuiConfig))
  const fileRows = createMemo(() => flattenFileTree(fileTree(), expandedFileNodes()))
  const patchFileIndexes = createMemo(() => orderedPatchFileIndexes(flattenFileTree(fileTree())))
  // Стабильная 1-based нумерация строк-файлов: позиция в полном плоском порядке
  // (без expandedFileNodes) — сворачивание каталогов номера не меняет.
  const fileNumberByNodeId = createMemo(() => {
    const numbers = new Map<number, number>()
    let number = 0
    for (const row of flattenFileTree(fileTree())) {
      if (row.fileIndex === undefined) continue
      number += 1
      numbers.set(row.id, number)
    }
    return numbers
  })
  // Буфер goto-файла живёт во владельце дерева/фокуса; активен только в фокусе
  // дерева (взаимоисключение с goto-строкой, живущей в фокусе патчей).
  const [gotoFileBuffer, setGotoFileBuffer] = createSignal<string | undefined>(undefined)
  const focusRunner = (input: Record<DiffViewerFocus, () => void>) => () => input[focus()]()
  const switchFocusShortcut = useCommandShortcut("diff.switch_focus")
  const nextHunkShortcut = useCommandShortcut("diff.next_hunk")
  const previousHunkShortcut = useCommandShortcut("diff.previous_hunk")
  const nextFileShortcut = useCommandShortcut("diff.next_file")
  const previousFileShortcut = useCommandShortcut("diff.previous_file")
  const scrollDownShortcut = useCommandShortcut("diff.scroll.down")
  const scrollUpShortcut = useCommandShortcut("diff.scroll.up")
  const openFileShortcut = useCommandShortcut("diff.open_file")
  const toggleFileTreeShortcut = useCommandShortcut("diff.toggle_file_tree")
  const singlePatchShortcut = useCommandShortcut("diff.single_patch")
  const switchSourceShortcut = useCommandShortcut("diff.switch_source")
  const toggleViewShortcut = useCommandShortcut("diff.toggle_view")
  const markReviewedShortcut = useCommandShortcut("diff.mark_reviewed")
  const helpShortcut = useCommandShortcut("diff.help")
  let scroll: ScrollBoxRenderable | undefined
  const patchNodeByFileIndex = new Map<number, BoxRenderable>()
  const diffNodeByFileIndex = new Map<number, DiffRenderable>()
  const [selectedHunk, setSelectedHunk] = createSignal<SelectedHunk | undefined>()
  const [pendingPatchScrollFileIndex, setPendingPatchScrollFileIndex] = createSignal<number | undefined>()
  const [patchFillerHeight, setPatchFillerHeight] = createSignal(0)
  const [compact, setCompact] = createSignal(compactOnOpen)
  // Кэш трансформации patch-текста: пересчёт только при смене файла/текста.
  const compactCache = new Map<number, { readonly patch: string | undefined; readonly result: string | undefined }>()
  createEffect(() => {
    visiblePatchFiles()
    compactCache.clear()
  })

  onCleanup(() => props.api.ui.dialog.clear())

  createEffect(() => {
    setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
    setHighlightedFileNode(undefined)
    setLastHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedFileIndex(undefined)
    setSelectedHunk(undefined)
    setReviewedFileNames(new Set<string>())
  })

  const ensureHighlightedFileNode = () => {
    const highlighted = highlightedFileNode()
    if (highlighted !== undefined && fileRows().some((row) => row.id === highlighted)) return
    const lastHighlighted = lastHighlightedFileNode()
    const next =
      lastHighlighted !== undefined && fileRows().some((row) => row.id === lastHighlighted)
        ? lastHighlighted
        : fileRows().find((row) => row.fileIndex !== undefined)?.id
    setHighlightedFileNode(next)
  }

  const setHighlighted = (node: number | undefined) => {
    setHighlightedFileNode(node)
    if (node !== undefined) setLastHighlightedFileNode(node)
  }

  const moveFileSelection = (offset: number) =>
    setHighlighted(moveFileTreeSelection(fileRows(), highlightedFileNode(), offset))

  const clearFileTreePatchState = () => {
    setHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedHunk(undefined)
  }

  const scrollPatchNodeToTop = (patchNode: BoxRenderable) => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const scrollDelta = patchNode.y - scroll.viewport.y
      const contentY = scroll.scrollTop + scrollDelta
      const offset = contentY === 0 ? 0 : 1
      scroll.scrollBy(scrollDelta + offset)
    })
  }

  const revealFileTreeFile = (fileIndex: number) => {
    const selection = fileTreeFileSelection(fileTree(), fileIndex)
    if (!selection) return
    setExpandedFileNodes((expanded) => {
      const next = new Set(expanded)
      selection.expandedNodes.forEach((node) => next.add(node))
      return next
    })
    setHighlighted(selection.highlightedNode)
  }

  const selectPatchFile = (fileIndex: number) => {
    revealFileTreeFile(fileIndex)
    setActivePatchFileIndex(fileIndex)
    setSelectedFileIndex(fileIndex)
  }

  const scrollToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
    const patchNode = patchNodeByFileIndex.get(fileIndex)
    if (patchNode) scrollPatchNodeToTop(patchNode)
  }

  const jumpToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    setSelectedHunk(undefined)
    scrollToFileIndex(fileIndex)
    // FR-4: выбор файла в дереве синхронизирует курсор аннотирования (AC-9).
    annotations.setCursorToFileRow(fileIndex, 0)
  }

  const currentPatchFileIndex = () => {
    if (!scroll) return undefined
    const viewportContentY = scroll.scrollTop + 1
    const entries = patchFileIndexes()
      .map((fileIndex) => ({
        fileIndex,
        node: patchNodeByFileIndex.get(fileIndex),
      }))
      .filter((entry): entry is { fileIndex: number; node: BoxRenderable } => Boolean(entry.node))
      .map((entry) => ({
        ...entry,
        contentY: scroll!.scrollTop + entry.node.y - scroll!.viewport.y,
      }))
      .sort((left, right) => left.contentY - right.contentY)
    return entries.findLast((entry) => entry.contentY <= viewportContentY)?.fileIndex ?? entries[0]?.fileIndex
  }

  const jumpRelativePatchFile = (offset: number) => {
    setSelectedHunk(undefined)
    const indexes = patchFileIndexes()
    let current = selectedFileIndex() ?? activePatchFileIndex()
    let next: number | undefined
    // Файлы без контентных строк (binary) пропускаются; потолок защищает от
    // зацикливания, когда кандидатов нет вовсе.
    for (let attempt = 0; attempt <= indexes.length; attempt++) {
      next = movePatchFileIndex(indexes, current, offset)
      if (next === undefined) return
      if (annotations.firstNavigableIndexOfFile(next) !== undefined) break
      current = next
    }
    if (next === undefined || annotations.firstNavigableIndexOfFile(next) === undefined) return
    if (singlePatch()) {
      selectPatchFile(next)
      scrollSinglePatchToTop()
      annotations.setCursorToFileRow(next, 0)
      return
    }
    scrollToFileIndex(next)
    // Курсор садится на первую контентную строку файла, не на заголовок.
    annotations.setCursorToFileRow(next, 0)
  }

  const jumpRelativeHunk = (offset: -1 | 1) => {
    const patchScroll = scroll
    if (!patchScroll) return
    const hunks = visiblePatchFiles()
      .flatMap((entry) => {
        const node = diffNodeByFileIndex.get(entry.fileIndex)
        if (!node || node.isDestroyed) return []
        const contentY = patchScroll.scrollTop + node.y - patchScroll.viewport.y
        return node.diff
          .split("\n")
          .flatMap((line, row) => (line.startsWith("@@") ? [row] : []))
          .map((row, hunkIndex) => ({
            fileIndex: entry.fileIndex,
            hunkIndex,
            row,
            contentY: contentY + row,
          }))
      })
      .sort((left, right) => left.contentY - right.contentY)
    const selected = selectedHunk()
    const selectedIndex =
      selected?.scrollTop === patchScroll.scrollTop
        ? hunks.findIndex((hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex)
        : -1
    const next =
      selectedIndex !== -1
        ? hunks[selectedIndex + offset]
        : offset === 1
          ? hunks.find((hunk) => hunk.contentY > patchScroll.scrollTop)
          : hunks.findLast((hunk) => hunk.contentY < patchScroll.scrollTop)
    if (!next) return
    selectPatchFile(next.fileIndex)
    patchScroll.scrollTo(next.contentY)
    // Курсор садится на первую контентную строку ханка, а не на «@@».
    const lines = diffNodeByFileIndex.get(next.fileIndex)?.diff.split("\n") ?? []
    let row = next.row + 1
    while (row < lines.length && (lines[row].startsWith("\\") || lines[row].startsWith("@@"))) row++
    annotations.setCursorToFileRow(next.fileIndex, row)
    setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: patchScroll.scrollTop })
  }

  const highlightedPatchFileIndex = () => fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
  const firstPatchFileIndex = () => fileRows().find((row) => row.fileIndex !== undefined)?.fileIndex
  const visiblePatchFiles = createMemo(() => {
    if (!singlePatch()) {
      return patchFileIndexes().flatMap((fileIndex) => {
        const file = files()[fileIndex]
        return file ? [{ file, fileIndex }] : []
      })
    }
    const fileIndex = singlePatchFileIndex(
      selectedFileIndex(),
      activePatchFileIndex(),
      currentPatchFileIndex(),
      firstPatchFileIndex(),
    )
    const file = fileIndex === undefined ? undefined : files()[fileIndex]
    return file && fileIndex !== undefined ? [{ file, fileIndex }] : []
  })

  // Рендер и модель навигации строятся из одного трансформированного текста:
  // компакт-режим вырезает строки до рендера, якоря сохраняют номера (D2).
  const renderedPatchFiles = createMemo(() => {
    const visible = visiblePatchFiles()
    if (!compact()) return visible
    return visible.map((entry) => {
      const cached = compactCache.get(entry.fileIndex)
      if (cached && cached.patch === entry.file.patch) return { file: { ...entry.file, patch: cached.result }, fileIndex: entry.fileIndex }
      const result = compactPatchText(entry.file.patch)
      compactCache.set(entry.fileIndex, { patch: entry.file.patch, result })
      return { file: { ...entry.file, patch: result }, fileIndex: entry.fileIndex }
    })
  })

  const ensureHighlightedPatchFile = () => {
    const fileIndex = currentPatchFileIndex() ?? activePatchFileIndex() ?? firstPatchFileIndex()
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
  }

  const scrollToPatchFileIndexAfterRender = (fileIndex: number) => {
    setPendingPatchScrollFileIndex(fileIndex)
    requestAnimationFrame(() => {
      const patchNode = patchNodeByFileIndex.get(fileIndex)
      if (patchNode) scrollPatchNodeToTop(patchNode)
      requestAnimationFrame(() => {
        const patchNode = patchNodeByFileIndex.get(fileIndex)
        if (patchNode) scrollPatchNodeToTop(patchNode)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  const scrollSinglePatchToTop = () => {
    requestAnimationFrame(() => {
      scroll?.scrollTo(0)
      requestAnimationFrame(() => scroll?.scrollTo(0))
    })
  }

  const measurePatchFiller = () => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const entries = visiblePatchFiles()
        .map((entry) => patchNodeByFileIndex.get(entry.fileIndex))
        .filter((node): node is BoxRenderable => Boolean(node))
      if (entries.length === 0) {
        setPatchFillerHeight(0)
        return
      }
      const contentHeight = Math.max(
        ...entries.map((node) => scroll!.scrollTop + node.y - scroll!.viewport.y + node.height),
      )
      setPatchFillerHeight(Math.max(0, scroll.viewport.height - contentHeight))
    })
  }

  const registerPatchNode = (fileIndex: number, element: BoxRenderable) => {
    patchNodeByFileIndex.set(fileIndex, element)
    measurePatchFiller()
    if (pendingPatchScrollFileIndex() !== fileIndex) return
    requestAnimationFrame(() => {
      scrollPatchNodeToTop(element)
      requestAnimationFrame(() => {
        scrollPatchNodeToTop(element)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  createEffect(() => {
    visiblePatchFiles()
    dimensions()
    view()
    measurePatchFiller()
  })

  const toggleSelectedFileTreeRow = () => {
    const highlighted = fileRows().find((row) => row.id === highlightedFileNode())
    if (highlighted?.fileIndex !== undefined) {
      jumpToFileIndex(highlighted.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, highlightedFileNode()))
  }

  // Enter в дереве: файл — показать и перевести фокус в патчи; папка — toggle
  // с сохранением фокуса в дереве (FR-3.1–3.3).
  const activateFileTreeRow = () => {
    const highlighted = fileRows().find((row) => row.id === highlightedFileNode())
    if (highlighted?.fileIndex !== undefined) {
      jumpToFileIndex(highlighted.fileIndex)
      setFocus("patches")
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, highlightedFileNode()))
  }

  const clickFileTreeRow = (row: FileTreeRow) => {
    setFocus("files")
    setHighlighted(row.id)
    if (row.fileIndex !== undefined) {
      jumpToFileIndex(row.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, row.id))
  }

  const toggleSelectedFileReviewed = () => {
    const fileIndex =
      focus() === "files"
        ? fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
        : (selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex())
    const file = fileIndex === undefined ? undefined : files()[fileIndex]?.file
    if (!file) return
    setReviewedFileNames((reviewed) => {
      const next = new Set(reviewed)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const closeViewer = () => {
    const returnRoute = params()?.returnRoute
    props.api.ui.dialog.clear()

    props.api.route.navigate(
      returnRoute?.name ?? "home",
      returnRoute && "params" in returnRoute ? returnRoute.params : undefined,
    )
  }

  // Аннотирование — поведение viewer поверх неизменного рендера патча (FR-I1):
  // курсор, статус-бар, оверлеи, черновик по сессии-владельцу.
  const annotations = createDiffAnnotations({
    api: props.api,
    params,
    files,
    diffReady: () => !diff.loading && !diff.error && files().length > 0,
    focus,
    focusPatches: () => setFocus("patches"),
    activateFileTreeRow,
    compact,
    setCompact: (value: boolean) => {
      compactOnOpen = value
      setCompact(value)
    },
    visiblePatchFiles: renderedPatchFiles,
    getScroll: () => scroll,
    patchNodeByFileIndex,
    diffNodeByFileIndex,
    patchPaneWidth,
    view,
    reviewedFileNames,
    closeViewer,
  })

  // Goto-файл: семантика зеркальна goto-строке — та же чистая машина
  // состояний, другой resolver цели и гейт по фокусу дерева. Условия
  // допустимости — единая точка: гейты слоёв и эффект сброса не расходятся.
  const gotoFileDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
  const gotoFileAllowed = () =>
    focus() === "files" &&
    showFileTree() &&
    !diff.loading &&
    !diff.error &&
    files().length > 0 &&
    !annotations.overlayActive()

  // Сброс буфера при нарушении любого условия допустимости (FR-1.7); смена
  // состава файлов отслеживается через fileTree. Возврат фокуса старый буфер
  // не восстанавливает.
  createEffect(() => {
    fileTree()
    if (!gotoFileAllowed()) setGotoFileBuffer(undefined)
  })

  function applyGotoFile(event: Parameters<typeof gotoTransition>[1]) {
    const result = gotoTransition(gotoFileBuffer(), event)
    setGotoFileBuffer(result.buffer)
    if (result.committed === undefined) return
    const target = gotoFileTarget(result.committed, patchFileIndexes().length)
    // Невалидный номер — тихий сброс: буфер уже очищен, состояние не меняется.
    if (target === undefined) return
    jumpToFileIndex(patchFileIndexes()[target])
    setFocus("patches")
  }

  useBindings(() => ({
    enabled: gotoFileAllowed() && gotoFileBuffer() === undefined,
    commands: gotoFileDigits.map((digit) => ({
      name: `diff.gotofile.digit.${digit}`,
      run: () => applyGotoFile({ kind: "digit", digit }),
    })),
    bindings: gotoFileDigits.map((digit) => ({ key: digit, cmd: `diff.gotofile.digit.${digit}`, desc: "Goto file" })),
  }))

  useBindings(() => ({
    enabled: gotoFileAllowed() && gotoFileBuffer() !== undefined,
    priority: 2,
    commands: [
      ...gotoFileDigits.map((digit) => ({
        name: `diff.gotofile.append.${digit}`,
        run: () => applyGotoFile({ kind: "digit", digit }),
      })),
      { name: "diff.gotofile.commit", run: () => applyGotoFile({ kind: "enter" }) },
      { name: "diff.gotofile.cancel", run: () => applyGotoFile({ kind: "escape" }) },
      { name: "diff.gotofile.backspace", run: () => applyGotoFile({ kind: "backspace" }) },
      { name: "diff.gotofile.tab", run: () => applyGotoFile({ kind: "tab" }) },
    ],
    bindings: [
      ...gotoFileDigits.map((digit) => ({ key: digit, cmd: `diff.gotofile.append.${digit}` })),
      { key: "return", cmd: "diff.gotofile.commit" },
      { key: "escape", cmd: "diff.gotofile.cancel" },
      { key: "backspace", cmd: "diff.gotofile.backspace" },
      { key: "tab", cmd: "diff.gotofile.tab", fallthrough: true },
      {
        key: "j,down,k,up,n,N,J,K,e,],[,b,s,o,v,m,E,q,a,d,c,g,?,space,right,left,pageup,pagedown,ctrl+f,ctrl+b",
        cmd: "diff.gotofile.cancel",
      },
    ],
  }))

  const commands = [
    {
      name: "diff.close",
      title: "Close diff viewer",
      category: "VCS",
      run() {
        // При живом черновике — диалог выхода (FR-X1), иначе обычное закрытие (FR-X2).
        if (annotations.handleClose()) return
        closeViewer()
      },
    },
    {
      name: "diff.down",
      title: "Move diff viewer down",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(1)
        },
        patches() {
          clearFileTreePatchState()
          // j/k двигают курсор ровно на одну видимую строку (FR-I4/I5).
          if (annotations.cursorActive()) annotations.moveCursor(1)
          else scroll?.scrollBy(1)
        },
      }),
    },
    {
      name: "diff.up",
      title: "Move diff viewer up",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-1)
        },
        patches() {
          clearFileTreePatchState()
          if (annotations.cursorActive()) annotations.moveCursor(-1)
          else scroll?.scrollBy(-1)
        },
      }),
    },
    {
      name: "diff.page.down",
      title: "Page diff viewer down",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(8)
        },
        patches() {
          clearFileTreePatchState()
          if (annotations.cursorActive()) annotations.pageCursor(1)
          else if (scroll) scroll.scrollBy(scroll.height)
        },
      }),
    },
    {
      name: "diff.page.up",
      title: "Page diff viewer up",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-8)
        },
        patches() {
          clearFileTreePatchState()
          if (annotations.cursorActive()) annotations.pageCursor(-1)
          else if (scroll) scroll.scrollBy(-scroll.height)
        },
      }),
    },
    {
      name: "diff.scroll.down",
      title: "Scroll diff viewer down (quarter)",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(2)
        },
        patches() {
          clearFileTreePatchState()
          if (annotations.cursorActive()) annotations.quarterCursor(1)
          else if (scroll) scroll.scrollBy(quarterViewport(scroll.viewport.height))
        },
      }),
    },
    {
      name: "diff.scroll.up",
      title: "Scroll diff viewer up (quarter)",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-2)
        },
        patches() {
          clearFileTreePatchState()
          if (annotations.cursorActive()) annotations.quarterCursor(-1)
          else if (scroll) scroll.scrollBy(-quarterViewport(scroll.viewport.height))
        },
      }),
    },
    {
      name: "diff.toggle",
      title: "Toggle diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          toggleSelectedFileTreeRow()
        },
        patches() {},
      }),
    },
    {
      name: "diff.expand",
      title: "Expand diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          if (highlighted !== undefined && expandedFileNodes().has(highlighted)) {
            setHighlighted(moveFileTreeSelectionToFirstChild(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), true),
          )
        },
        patches() {},
      }),
    },
    {
      name: "diff.expand_all",
      title: "Expand all diff viewer folders",
      category: "VCS",
      run: focusRunner({
        files() {
          setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
        },
        patches() {},
      }),
    },
    {
      name: "diff.collapse",
      title: "Collapse diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          const node = highlighted === undefined ? undefined : fileTree().nodes[highlighted]
          if (node?.kind !== "directory" || !expandedFileNodes().has(node.id)) {
            setHighlighted(moveFileTreeSelectionToParent(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), false),
          )
        },
        patches() {},
      }),
    },
    {
      name: "diff.next_hunk",
      title: "Jump to next diff hunk",
      category: "VCS",
      run() {
        jumpRelativeHunk(1)
      },
    },
    {
      name: "diff.previous_hunk",
      title: "Jump to previous diff hunk",
      category: "VCS",
      run() {
        jumpRelativeHunk(-1)
      },
    },
    {
      name: "diff.next_file",
      title: "Jump to next diff file",
      category: "VCS",
      run() {
        jumpRelativePatchFile(1)
      },
    },
    {
      name: "diff.previous_file",
      title: "Jump to previous diff file",
      category: "VCS",
      run() {
        jumpRelativePatchFile(-1)
      },
    },
    {
      name: "diff.open_file",
      title: "Open diff file in external editor",
      category: "VCS",
      async run() {
        // Курсор на строке → её файл и номер (FR-10 best-effort, включая minus-строки
        // со старым номером — карта старая→новая не строится); иначе первый видимый файл.
        const line = annotations.currentLine()
        const file = line ? files().find((item) => item.file === line.filePath) : renderedPatchFiles()[0]?.file
        if (!file) return
        const resolved = resolveEditableFile({ file: file.file, patch: file.patch, cwd: process.cwd() })
        if ("missing" in resolved) {
          props.api.ui.toast({ variant: "error", title: "File not found", message: file.file })
          return
        }
        const status = await openFileInEditor({
          file: resolved.path,
          line: line?.lineNumber ?? undefined,
          renderer,
          cwd: process.cwd(),
        })
        if (status === "no-editor") {
          props.api.ui.toast({ variant: "error", title: "No external editor", message: "Set VISUAL or EDITOR" })
        }
      },
    },
    {
      name: "diff.mark_reviewed",
      title: "Toggle selected diff file reviewed",
      category: "VCS",
      run() {
        toggleSelectedFileReviewed()
      },
    },
    {
      name: "diff.switch_focus",
      title: "Switch diff viewer focus",
      category: "VCS",
      run() {
        if (!showFileTree()) return
        setFocus((current) => {
          if (current === "files") return "patches"
          ensureHighlightedFileNode()
          return "files"
        })
      },
    },
    {
      name: "diff.toggle_file_tree",
      title: "Toggle diff viewer file tree",
      category: "VCS",
      run() {
        const next = !fileTreeEnabled()
        if (!next) setFocus("patches")
        setFileTreeEnabled(next)
        props.api.kv.set(KV_SHOW_FILE_TREE, next)
      },
    },
    {
      name: "diff.single_patch",
      title: "Toggle single patch view",
      category: "VCS",
      run() {
        setSelectedHunk(undefined)
        if (!singlePatch()) {
          ensureHighlightedPatchFile()
          setSinglePatch(true)
          props.api.kv.set(KV_SINGLE_PATCH, true)
          scrollSinglePatchToTop()
          return
        }
        const fileIndex =
          visiblePatchFiles()[0]?.fileIndex ??
          singlePatchFileIndex(
            selectedFileIndex(),
            activePatchFileIndex(),
            currentPatchFileIndex(),
            firstPatchFileIndex(),
          )
        if (fileIndex !== undefined) selectPatchFile(fileIndex)
        setSinglePatch(false)
        props.api.kv.set(KV_SINGLE_PATCH, false)
        if (fileIndex !== undefined) scrollToPatchFileIndexAfterRender(fileIndex)
      },
    },
    {
      name: "diff.switch_source",
      title: "Switch diff viewer source",
      category: "VCS",
      run() {
        openSwitchDiffDialog()
      },
    },
    {
      name: "diff.toggle_view",
      title: "Toggle diff viewer split or unified view",
      category: "VCS",
      run() {
        if (!splitAvailable()) return
        setSelectedHunk(undefined)
        const next = view() === "split" ? "unified" : "split"
        setViewOverride(next)
        props.api.kv.set(KV_VIEW, next)
      },
    },
    {
      name: "diff.compact_toggle",
      title: "Toggle compact diff view",
      category: "VCS",
      run() {
        if (focus() !== "patches") return
        annotations.toggleCompact()
      },
    },
    {
      name: "diff.help",
      title: "Show more diff viewer shortcuts",
      category: "VCS",
      run() {
        openHelpDialog()
      },
    },
    ...annotations.commands,
  ]

  const switchDiffOptions = createMemo(() => {
    const vcs = props.api.state.vcs
    return [
      {
        title: "Working tree",
        value: "git" as const,
        description: "Show current git changes",
      },
      ...(vcs?.branch && vcs.default_branch && vcs.branch !== vcs.default_branch
        ? [
            {
              title: "Main branch",
              value: "branch" as const,
              description: "Show changes compared to main branch",
            },
          ]
        : []),
      {
        title: "Last turn",
        value: "last-turn" as const,
        description: "Show changes from the last assistant turn",
      },
    ]
  })

  const openSwitchDiffDialog = () => {
    props.api.ui.dialog.replace(() => (
      <DialogSelect
        title="Switch source"
        skipFilter={true}
        renderFilter={false}
        current={mode()}
        options={switchDiffOptions().map((option) => ({
          ...option,
          onSelect(dialog) {
            dialog.clear()
            // Смена/обновление источника при живом черновике — только через
            // подтверждение (FR-S3/S4); отказ ничего не меняет.
            annotations.confirmSourceSwitch(() => {
              props.api.route.navigate(ROUTE, {
                mode: option.value,
                sessionID: params()?.sessionID,
                messageID: params()?.messageID,
                returnRoute: params()?.returnRoute,
              })
            })
          },
        }))}
      />
    ))
  }

  const openHelpDialog = () => {
    props.api.ui.dialog.replace(() => <DiffViewerHelpDialog />)
    props.api.ui.dialog.setSize("large")
  }

  useBindings(() => ({
    // FR-K8: открытый оверлей глушит клавиши viewer. Диалоги api.ui.dialog имеют
    // собственные слои (поведение до фичи сохранено, FR-R1).
    enabled: !annotations.overlayActive(),
    commands,
    bindings: [
      { key: "j,down", cmd: "diff.down", desc: "Move diff viewer down" },
      { key: "k,up", cmd: "diff.up", desc: "Move diff viewer up" },
      { key: "pagedown,ctrl+f", cmd: "diff.page.down", desc: "Page diff viewer down" },
      { key: "pageup,ctrl+b", cmd: "diff.page.up", desc: "Page diff viewer up" },
      { key: "J", cmd: "diff.scroll.down", desc: "Scroll diff viewer down (quarter)" },
      { key: "K", cmd: "diff.scroll.up", desc: "Scroll diff viewer up (quarter)" },
      { key: "e", cmd: "diff.open_file", desc: "Open file in external editor" },
      { key: "m", cmd: "diff.mark_reviewed", desc: "Mark selected file reviewed" },
      ...props.api.tuiConfig.keybinds.gather(
        "diff",
        commands.map((command) => command.name),
      ),
    ],
  }))

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width={dimensions().width} height={dimensions().height}>
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
          <text fg={theme().text}>Diff </text>
          <text fg={theme().textMuted}>{diffSourceLabel(mode())}</text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>
            {files().length} {files().length === 1 ? "file" : "files"}
          </text>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={diff.loading}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>Loading diff...</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>No diff!</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().error}>Failed to load diff</text>
              </box>
            </Match>
            <Match when={!diff.loading}>
              <PanelGroup axis="x">
                <Show when={showFileTree()}>
                  <DiffViewerFileTree
                    files={files()}
                    loading={diff.loading}
                    error={diff.error}
                    theme={theme()}
                    focused={focus() === "files"}
                    width={FILE_TREE_WIDTH}
                    highlightedNode={highlightedFileNode()}
                    selectedFileIndex={selectedFileIndex()}
                    reviewedFileNames={reviewedFileNames()}
                    expandedNodes={expandedFileNodes()}
                    fileNumberByNodeId={fileNumberByNodeId()}
                    onRowClick={clickFileTreeRow}
                  />
                </Show>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start={showFileTree() ? "edge-out" : undefined} />
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (scroll = element)}
                    flexGrow={1}
                    minHeight={0}
                    scrollAcceleration={patchScrollAcceleration()}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <For each={renderedPatchFiles()}>
                      {(entry, index) => {
                        const reviewed = () => reviewedFileNames().has(entry.file.file)
                        return (
                          <box ref={(element: BoxRenderable) => registerPatchNode(entry.fileIndex, element)}>
                            {index() !== 0 ? <Separator axis="x" start={showFileTree() ? "edge" : undefined} /> : null}
                            <box
                              flexDirection="row"
                              gap={1}
                              flexShrink={0}
                              paddingLeft={1}
                              paddingRight={1}
                              border={patchLeftBorder()}
                              borderColor={theme().border}
                            >
                              <text fg={reviewed() ? theme().textMuted : theme().text}>{entry.file.file}</text>
                              <box flexGrow={1} />
                              <text fg={reviewed() ? theme().textMuted : theme().diffAdded}>
                                +{entry.file.additions}
                              </text>
                              <text fg={reviewed() ? theme().textMuted : theme().diffRemoved}>
                                -{entry.file.deletions}
                              </text>
                            </box>
                            <Separator axis="x" start={showFileTree() ? "edge" : undefined} />
                            <Show
                              when={entry.file.patch}
                              fallback={<text fg={theme().textMuted}>No patch available for this file.</text>}
                            >
                              {(patch) => (
                                <box border={patchLeftBorder()} borderColor={theme().border}>
                                  <diff
                                    ref={(element: DiffRenderable) => diffNodeByFileIndex.set(entry.fileIndex, element)}
                                    diff={patch()}
                                    view={view()}
                                    filetype={reviewed() ? PLAIN_TEXT_FILETYPE : filetype(entry.file.file)}
                                    syntaxStyle={themeState.syntax()}
                                    showLineNumbers={true}
                                    width="100%"
                                    wrapMode="char"
                                    fg={reviewed() ? theme().textMuted : theme().text}
                                    addedBg={reviewed() ? theme().backgroundElement : theme().diffAddedBg}
                                    removedBg={reviewed() ? theme().backgroundElement : theme().diffRemovedBg}
                                    addedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightAdded}
                                    removedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightRemoved}
                                    lineNumberFg={theme().diffLineNumber}
                                    addedLineNumberBg={
                                      reviewed() ? theme().backgroundElement : theme().diffAddedLineNumberBg
                                    }
                                    removedLineNumberBg={
                                      reviewed() ? theme().backgroundElement : theme().diffRemovedLineNumberBg
                                    }
                                  />
                                </box>
                              )}
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={patchFillerHeight() > 0}>
                      <box height={patchFillerHeight()} border={patchLeftBorder()} borderColor={theme().border} />
                    </Show>
                  </scrollbox>
                  <Separator axis="x" start={showFileTree() ? "edge-in" : undefined} />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} border="none">
          {/* wrapMode/width: без них двухзначный буфер переносится по символам
              (тот же латентный класс бага, что и у статус-номера строки). */}
          <Show when={gotoFileBuffer()}>
            {(buffer) => (
              <text fg={theme().text} wrapMode="none" width={11 + buffer().length}>
                goto file: {buffer()}
              </text>
            )}
          </Show>
          <Show when={annotations.statusText()}>
            {(status) => (
              // FR-2: голый номер текущей строки — без пути, счётчика и метки.
              // wrapMode="none": без него двухзначные номера переносятся по
              // символам на строки футера (латентный баг, вскрыт quarter-скроллом).
              <text fg={theme().text} wrapMode="none" width={status().length}>
                {status()}
              </text>
            )}
          </Show>
          <Show when={switchFocusShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>focus file tree</span>
              </text>
            )}
          </Show>
          <Show when={nextFileShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>next file</span>
              </text>
            )}
          </Show>
          <Show when={nextHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>next hunk</span>
              </text>
            )}
          </Show>
          <Show when={previousHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>previous hunk</span>
              </text>
            )}
          </Show>
          <Show when={previousFileShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>previous file</span>
              </text>
            )}
          </Show>
          {/* Новые подсказки скролла/редактора выключаются на низких терминалах:
              третья строка футера выталкивает контент патча (деградация TC-Q702). */}
          <Show when={dimensions().height > 16}>
            <Show when={scrollDownShortcut()}>
              {(shortcut) => (
                <text fg={theme().text}>
                  {shortcut()}/{scrollUpShortcut()} <span style={{ fg: theme().textMuted }}>scroll</span>
                </text>
              )}
            </Show>
            <Show when={openFileShortcut()}>
              {(shortcut) => (
                <text fg={theme().text}>
                  {shortcut()} <span style={{ fg: theme().textMuted }}>open file</span>
                </text>
              )}
            </Show>
          </Show>
          <Show when={switchSourceShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>switch source</span>
              </text>
            )}
          </Show>
          <Show when={markReviewedShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>mark reviewed</span>
              </text>
            )}
          </Show>
          <Show when={helpShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>all</span>
              </text>
            )}
          </Show>
        </Panel>
      </PanelGroup>
      {annotations.overlays}
    </box>
  )
}

function DiffViewerHelpDialog() {
  const { theme } = useTheme()
  const rows = [
    {
      shortcut: () => "q",
      action: "Close viewer",
      description: "Quit the diff viewer",
    },
    {
      shortcut: useCommandShortcut("diff.open"),
      action: "Open diff viewer",
      description: "Open the diff viewer from anywhere",
    },
    {
      shortcut: useCommandShortcut("diff.switch_focus"),
      action: "Focus file tree",
      description: "Move keyboard focus between the file tree and patch pane",
    },
    {
      shortcut: useCommandShortcut("diff.next_hunk"),
      action: "Next hunk",
      description: "Jump to the next diff hunk",
    },
    {
      shortcut: useCommandShortcut("diff.previous_hunk"),
      action: "Previous hunk",
      description: "Jump to the previous diff hunk",
    },
    {
      shortcut: useCommandShortcut("diff.next_file"),
      action: "Next file",
      description: "Select the next changed file in file-tree order",
    },
    {
      shortcut: useCommandShortcut("diff.previous_file"),
      action: "Previous file",
      description: "Select the previous changed file in file-tree order",
    },
    {
      shortcut: useCommandShortcut("diff.scroll.down"),
      action: "Scroll down",
      description: "Scroll the patch pane a quarter of the screen",
    },
    {
      shortcut: useCommandShortcut("diff.scroll.up"),
      action: "Scroll up",
      description: "Scroll the patch pane a quarter of the screen up",
    },
    {
      shortcut: useCommandShortcut("diff.open_file"),
      action: "Open file",
      description: "Open the current diff file in the external editor (VISUAL or EDITOR)",
    },
    {
      shortcut: useCommandShortcut("diff.toggle_file_tree"),
      action: "Toggle file tree",
      description: "Show or hide the file tree sidebar",
    },
    {
      shortcut: useCommandShortcut("diff.single_patch"),
      action: "Toggle patches",
      description: "Switch between one selected patch and all patches",
    },
    {
      shortcut: useCommandShortcut("diff.switch_source"),
      action: "Switch source",
      description: "Choose working tree, main branch, or last-turn changes",
    },
    {
      shortcut: useCommandShortcut("diff.toggle_view"),
      action: "Toggle view",
      description: "Switch between split and unified diff layout",
    },
    {
      shortcut: useCommandShortcut("diff.expand_all"),
      action: "Expand all folders",
      description: "Open every folder in the file tree",
    },
    {
      shortcut: useCommandShortcut("diff.mark_reviewed"),
      action: "Mark reviewed",
      description: "Toggle reviewed state for the selected file",
    },
    {
      shortcut: useCommandShortcut("diff.toggle"),
      action: "Toggle item",
      description: "Toggle the selected file tree item",
    },
    {
      shortcut: useCommandShortcut("diff.annotate"),
      action: "Annotate line",
      description: "Create or edit an annotation on the cursor line",
    },
    {
      shortcut: useCommandShortcut("diff.annotate_delete"),
      action: "Delete annotation",
      description: "Delete the annotation on the cursor line with confirmation",
    },
    {
      shortcut: useCommandShortcut("diff.annotations_panel"),
      action: "Annotations panel",
      description: "Toggle the annotations panel for the current draft",
    },
    {
      shortcut: useCommandShortcut("diff.compact_toggle"),
      action: "Compact view",
      description: "Show only changed lines with nearby context",
    },
    {
      shortcut: () => "0-9",
      action: "Goto line",
      description: "Type a new-file line number and press enter to jump",
    },
    {
      shortcut: () => "alt+enter",
      action: "Confirm annotation",
      description: "Submit the annotation editor without inserting a newline",
    },
  ]
  // Колонка Key подстраивается под самый длинный биндинг (alt+enter), чтобы
  // справка не превращалась в кашу на 80 колонках.
  const keyWidth = helpKeyColumnWidth(rows.map((row) => row.shortcut() || "-"))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Diff shortcuts
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textMuted} width={keyWidth} wrapMode="none">
          Key
        </text>
        <text fg={theme.textMuted} width={22} wrapMode="none">
          Action
        </text>
        <text fg={theme.textMuted}>Description</text>
      </box>
      <For each={rows}>
        {(row) => (
          <box flexDirection="row">
            <text fg={theme.text} width={keyWidth} wrapMode="none">
              {row.shortcut() || "-"}
            </text>
            <text fg={theme.text} width={22} wrapMode="none">
              {row.action}
            </text>
            <text fg={theme.textMuted}>{row.description}</text>
          </box>
        )}
      </For>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <DiffViewer api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "diff.open",
        title: "Open diff viewer",
        slashName: "diff",
        category: "VCS",
        namespace: "palette",
        run() {
          // Идемпотент-гард: повторный вызов из diff-роута не перезаписывает
          // returnRoute (иначе закрытие зацикливало бы возврат в diff).
          if (api.route.current.name === ROUTE) return
          // Каждое открытие viewer начинает с компактного вида; внутренние
          // смены источника («o») это значение не сбрасывают.
          compactOnOpen = true
          api.route.navigate(ROUTE, {
            mode: "git",
            sessionID: "params" in api.route.current ? api.route.current.params?.sessionID : undefined,
            returnRoute: api.route.current,
          })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

export default {
  id: "diff-viewer",
  tui,
}
