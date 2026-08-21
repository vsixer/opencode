/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { BoxRenderable, DiffRenderable, ScrollBoxRenderable } from "@opentui/core"
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { useBindings } from "../../../keymap"
import type { DiffFile } from "./patch-lines"
import {
  annotatableBodyLine,
  anchorScrollTop,
  buildFlatPatchLines,
  clampCursor,
  firstNavigableRowOfFile,
  isBodyLine,
  nearestNavigableIndex,
  nextNavigableIndex,
  unifiedRowsBefore,
  unifiedWrapColumn,
  quarterViewport,
  type FlatPatchLine,
} from "./patch-cursor"
import { closePanelStack, popOverlayTop, pushEditorOverlay, syncEditorOverlay } from "./overlay-stack"
import { parsePatchFileLines } from "./patch-lines"
import { gotoTargetIndex, gotoTransition } from "./goto"
import {
  buildBodyLineMap,
  invertLineNumbers,
  resolveSplitRow,
  type BodyLineEntry,
} from "./line-mapping"
import {
  createSideMerger,
  diffSides,
  noteSidesUnsupportedOnce,
  uniqueRows,
  type LineDecoration,
  type SideLike,
  type SideMerger,
} from "./line-decorations"
import {
  clearDraftSendInitiated,
  disposeDraft,
  getOrCreateDraftRecord,
  markDraftSendInitiated,
  SESSIONLESS_OWNER,
} from "./drafts"
import { assembleMessage } from "./message"
import { buildPromptRequest } from "./prompt-request"
import { editorTargetForLine, type Annotation, type AnnotationStore } from "./store"
import { AnnotationEditor } from "./annotation-editor"
import { AnnotationsPanel } from "./annotations-panel"
import { ConfirmDialog } from "./confirm-dialog"
import { ExitDialog } from "./exit-dialog"

// Догон событий истории после rejection: повтор проверки через ~1 с.
const SEND_RETRY_DELAY_MS = 1000
const SEND_RETRY_ATTEMPTS = 1
// Общий потолок повторов классификации (включая inconclusive-тики) — защита от
// бесконечных таймеров при никогда не загружающемся сторе сообщений.
const SEND_CLASSIFY_MAX_TICKS = 10
// Ретраи применения декораций: стороны DiffRenderable строятся асинхронно.
const DECORATION_APPLY_RETRIES = 10
// Догоняющие проходы после успешного применения: поздние rebuild'ы рендерера.
const DECORATION_SETTLE_FRAMES = 8
// Watchdog: async-rebuild'ы рендерера (подсветка синтаксиса, resize) приходят позже
// любых rAF-проходов и стирают декорации; пере-применение дёшево (no-op без изменений).
const DECORATION_WATCHDOG_MS = 250

// Контекст viewer, необходимый аннотированию. diff-viewer.tsx собирает его после создания
// своих сигналов/узлов; модуль не знает о внутренностях рендера патча.
export type DiffAnnotationsContext = {
  readonly api: TuiPluginApi
  readonly params: () => { sessionID?: string; returnRoute?: TuiRouteCurrent } | undefined
  readonly files: () => readonly DiffFile[]
  readonly diffReady: () => boolean
  readonly focus: () => "patches" | "files"
  readonly focusPatches: () => void
  readonly activateFileTreeRow: () => void
  readonly compact: () => boolean
  readonly setCompact: (value: boolean) => void
  readonly visiblePatchFiles: () => readonly { readonly file: DiffFile; readonly fileIndex: number }[]
  readonly getScroll: () => ScrollBoxRenderable | undefined
  readonly patchNodeByFileIndex: Map<number, BoxRenderable>
  readonly diffNodeByFileIndex: Map<number, DiffRenderable>
  readonly patchPaneWidth: () => number
  readonly view: () => "split" | "unified"
  readonly reviewedFileNames: () => ReadonlySet<string>
  readonly closeViewer: () => void
}

type Overlay =
  | { readonly kind: "panel" }
  | { readonly kind: "editor" }
  | { readonly kind: "exit" }
  | {
      readonly kind: "confirm"
      readonly title: string
      readonly message?: string
      readonly confirmLabel?: string
      readonly danger?: boolean
      readonly onConfirm: () => void
      readonly onCancel?: () => void
    }

// Связка store + viewer + оверлеев: курсор, декорации строк, статус-бар, команды
// аннотирования, диалог выхода, отправка, подтверждения смены источника и переоткрытия.
export function createDiffAnnotations(ctx: DiffAnnotationsContext) {
  const api = ctx.api
  // Владелец фиксируется при открытии viewer и не переходит к другим (FR-C5).
  const sessionID = ctx.params()?.sessionID
  const ownerKey = sessionID ?? SESSIONLESS_OWNER
  const record = getOrCreateDraftRecord(ownerKey)
  const store: AnnotationStore = record.store

  const [overlayStack, setOverlayStack] = createSignal<readonly Overlay[]>([])
  const [cursorIndex, setCursorIndex] = createSignal(0)
  const [gotoBuffer, setGotoBuffer] = createSignal<string | undefined>(undefined)
  let rebindPending = false
  let sendInitiated = false
  let draftConsumed = false

  const topOverlay = createMemo(() => overlayStack()[overlayStack().length - 1])
  const overlayActive = createMemo(() => overlayStack().length > 0)
  const confirmOverlay = createMemo(() => {
    const top = topOverlay()
    return top?.kind === "confirm" ? top : undefined
  })

  function pushOverlay(overlay: Overlay) {
    // Оверлей сбрасывает goto-ввод (FR-4.10).
    setGotoBuffer(undefined)
    setOverlayStack((stack) => [...stack, overlay])
  }

  // Push редактора идемпотентен: store хранит один editor-state, дубль в стеке
  // ломает LIFO-закрытие панели (деградация «незакрываемого листинга»).
  function pushEditor() {
    setGotoBuffer(undefined)
    setOverlayStack((stack) => pushEditorOverlay(stack, { kind: "editor" } as Overlay))
  }

  function popOverlay(kind: Overlay["kind"]) {
    setOverlayStack((stack) => popOverlayTop(stack, kind))
  }

  // Панель закрывается усечением стека по своему первому вхождению: панель и
  // всё выше неё снимаются одним жестом из любого состояния (FR-3.1).
  function closePanel() {
    setOverlayStack((stack) => closePanelStack(stack))
  }

  // Самоликвидация деградированных состояний: стек синхронен с editor-state
  // стора — закрытый редактор не оставляет записей, открытый ровно один и верхний.
  createEffect(() => {
    const stack = overlayStack()
    const editorOpen = store.editor().kind === "open"
    const synced = syncEditorOverlay(stack, editorOpen, () => ({ kind: "editor" }) as Overlay)
    if (synced !== stack) setOverlayStack(synced)
  })

  function popAllOverlays() {
    setOverlayStack([])
  }

  // Плоский список видимых строк патча (FR-I4): курсор движется по нему.
  const flatLines = createMemo(() => buildFlatPatchLines(ctx.visiblePatchFiles()))
  const currentLine = createMemo<FlatPatchLine | undefined>(() => flatLines()[cursorIndex()])

  // Единый клампящий сеттер (FR-4): выходящее за границы значение физически не
  // записывается — счётчик в минус невозможен конструктивно.
  function setCursorIndexClamped(index: number) {
    setCursorIndex(clampCursor(index, flatLines().length))
  }

  // Кламп курсора при изменении набора файлов/строк: курсор всегда стоит на
  // контентной строке (INV-1) — в т.ч. после переключения компакт-режима.
  createEffect(() => {
    const lines = flatLines()
    setCursorIndex((current) => {
      if (lines[current] && isBodyLine(lines[current])) return current
      return nearestNavigableIndex(lines, current) ?? clampCursor(current, lines.length)
    })
  })

  const parsedByFileIndex = new Map<number, ReturnType<typeof parsePatchFileLines>>()
  const bodyMapByFileIndex = new Map<number, BodyLineEntry[]>()
  createEffect(() => {
    // Пересбор кэшей разбора при смене видимого набора файлов.
    ctx.visiblePatchFiles()
    parsedByFileIndex.clear()
    bodyMapByFileIndex.clear()
  })

  function parsedLinesFor(fileIndex: number): ReturnType<typeof parsePatchFileLines> {
    const entry = ctx.visiblePatchFiles().find((candidate) => candidate.fileIndex === fileIndex)
    if (!entry) return []
    const cached = parsedByFileIndex.get(fileIndex)
    if (cached) return cached
    const parsed = parsePatchFileLines(entry.file.patch)
    parsedByFileIndex.set(fileIndex, parsed)
    return parsed
  }

  function bodyMapFor(fileIndex: number): BodyLineEntry[] {
    const cached = bodyMapByFileIndex.get(fileIndex)
    if (cached) return cached
    const bodyMap = buildBodyLineMap(parsedLinesFor(fileIndex))
    bodyMapByFileIndex.set(fileIndex, bodyMap)
    return bodyMap
  }

  // Экранная координата контента строки (ряд unified-рендера + base-офсет узла).
  // Единый счётчик для ensureVisible и якоря компакт-режима: ряды считают только
  // body-строки — рендерер не выводит служебные; колонка переноса калибруется
  // шириной самого узла <diff>.
  function contentYAt(index: number): number | undefined {
    const scroll = ctx.getScroll()
    const line = flatLines()[index]
    if (!scroll || !line) return undefined
    const diffNode = ctx.diffNodeByFileIndex.get(line.fileIndex)
    if (!diffNode || diffNode.isDestroyed) return undefined
    const base = scroll.scrollTop + diffNode.y - scroll.viewport.y
    return base + unifiedRowsBefore(parsedLinesFor(line.fileIndex), line.lineIndex, unifiedWrapColumn(diffNode.width))
  }

  // Строка курсора всегда остаётся в видимой области (FR-I5). Запас ±1 ряд
  // компенсирует неточность калибровки переноса (риск R1).
  function ensureVisible(index: number) {
    const scroll = ctx.getScroll()
    const contentY = contentYAt(index)
    if (!scroll || contentY === undefined) return
    requestAnimationFrame(() => {
      if (!scroll || scroll.isDestroyed) return
      const top = scroll.scrollTop
      const bottom = scroll.scrollTop + scroll.viewport.height
      if (contentY < top + 1) scroll.scrollTo(Math.max(0, contentY))
      else if (contentY > bottom - 1) scroll.scrollTo(Math.max(0, contentY - scroll.viewport.height + 2))
    })
  }

  // Прокрутка к якорю: строка остаётся на прежней экранной позиции после
  // изменения высоты контента (тумгл компактного режима). Целевой scrollTop
  // применяется двумя кадрами подряд: геометрия и scrollHeight обновляются
  // не мгновенно, повторный проход даёт рендереру доскроллить после клампа.
  function scrollToKeepAnchor(targetScroll: number) {
    const scroll = ctx.getScroll()
    if (!scroll) return
    const apply = () => {
      if (scroll.isDestroyed) return
      scroll.scrollTo(anchorScrollTop(targetScroll, 0, scroll.viewport.height, scroll.scrollHeight))
    }
    requestAnimationFrame(() => {
      apply()
      requestAnimationFrame(apply)
    })
  }

  // Движение курсора только по контентным строкам: служебные (заголовки файла и
  // ханков) перескакиваются одним нажатием, включая границу файлов.
  function moveCursor(delta: number) {
    const lines = flatLines()
    if (lines.length === 0) return
    const dir = delta < 0 ? -1 : 1
    let index = cursorIndex()
    if (lines[index] && !isBodyLine(lines[index])) {
      const nearest = nextNavigableIndex(lines, index, dir) ?? nextNavigableIndex(lines, index, -dir)
      if (nearest === undefined) return
      index = nearest
    }
    for (let step = 0; step < Math.abs(delta); step++) {
      const next = nextNavigableIndex(lines, index, dir)
      if (next === undefined) break
      index = next
    }
    setCursorIndex(index)
    ensureVisible(index)
  }

  function pageCursor(delta: number) {
    const scroll = ctx.getScroll()
    moveCursor(scroll ? delta * Math.max(1, scroll.viewport.height) : delta)
  }

  // Quarter-скролл курсора: четверть высоты вьюпорта (FR-1), страница не тронута.
  function quarterCursor(delta: number) {
    const scroll = ctx.getScroll()
    moveCursor(scroll ? delta * quarterViewport(scroll.viewport.height) : delta)
  }

  // Установка курсора после прыжка: точное попадание → строка; service-строка или
  // miss → первая контентная строка файла; файл исчез → кламп текущего.
  function setCursorToFileRow(fileIndex: number, row: number) {
    const lines = flatLines()
    const exact = lines.findIndex((line) => line.fileIndex === fileIndex && line.lineIndex === row)
    if (exact !== -1 && isBodyLine(lines[exact])) return setCursorIndexClamped(exact)
    const first = firstNavigableRowOfFile(lines, fileIndex)
    if (first !== undefined) return setCursorIndexClamped(first)
    setCursorIndexClamped(cursorIndex())
  }

  function firstNavigableIndexOfFile(fileIndex: number) {
    return firstNavigableRowOfFile(flatLines(), fileIndex)
  }

  // Статус-бар: режим goto-ввода важнее номера строки; далее — только номер
  // текущей строки, прочерк на служебных строках.
  const statusText = createMemo(() => {
    if (!ctx.diffReady()) return undefined
    const buffer = gotoBuffer()
    if (buffer !== undefined) return `goto: ${buffer}`
    const line = currentLine()
    if (!line) return undefined
    return line.lineNumber === null ? "—" : `${line.lineNumber}`
  })

  // Декорации строк (FR-1/FR-3): snapshot-merge поверх per-line API сторон рендерера.
  // Мост feature-detected: при недоступности сторон декорации полностью отключаются.
  const sideMergers = new Map<SideLike, SideMerger>()

  function mergerFor(side: SideLike): SideMerger {
    let merger = sideMergers.get(side)
    if (!merger) {
      merger = createSideMerger(side)
      sideMergers.set(side, merger)
    }
    return merger
  }

  function boundEntryFor(bodyMap: readonly BodyLineEntry[], line: FlatPatchLine | undefined): BodyLineEntry | undefined {
    if (!line || line.lineNumber === null) return undefined
    return bodyMap.find((candidate) => candidate.lineIndex === line.lineIndex)
  }

  // Полный конвейен «перечитать карты → инверсия → merge → применить». Возвращает
  // false, если хотя бы у одного узла стороны ещё не построены (rebuild асинхронен) —
  // вызывающий планировщик повторяет проход. В split дополнительно нужен rAF-повтор:
  // синхронный проход мог читать до-rebuild'ные карты (план §5.6).
  function applyDecorations(): boolean {
    const theme = api.theme.current
    const cursorLine = currentLine()
    const boundAnnotations = store.visibleAnnotations().filter((annotation) => annotation.state === "bound")
    const lines = flatLines()
    let complete = true
    for (const entry of ctx.visiblePatchFiles()) {
      const node = ctx.diffNodeByFileIndex.get(entry.fileIndex)
      if (!node || node.isDestroyed) continue
      const sides = diffSides(node)
      // Стороны строятся асинхронно — пропуск без полного OFF; окончательное
      // отсутствие фиксирует планировщик после ретраев (noteSidesUnsupportedOnce).
      if (!sides) {
        complete = false
        continue
      }
      const bodyMap = bodyMapFor(entry.fileIndex)
      const cursorEntry =
        cursorLine && cursorLine.fileIndex === entry.fileIndex ? boundEntryFor(bodyMap, cursorLine) : undefined
      const markedEntries = boundAnnotations
        .map((annotation) => {
          if (annotation.anchor.filePath !== entry.file.file) return undefined
          const index = lines.findIndex(
            (line) =>
              line.filePath === annotation.anchor.filePath &&
              line.side === annotation.anchor.side &&
              line.lineNumber === annotation.anchor.line,
          )
          return index === -1 ? undefined : boundEntryFor(bodyMap, lines[index])
        })
        .filter((candidate): candidate is BodyLineEntry => candidate !== undefined)
      if (ctx.view() === "unified") {
        // unified: rightSide откреплён от дерева — применяется только левая сторона.
        const overlays: LineDecoration[] = []
        if (markedEntries.length > 0) {
          overlays.push({
            rows: uniqueRows(markedEntries.map((candidate) => candidate.bodyIndex)),
            gutter: theme.diffAnnotationMarkBg,
          })
        }
        if (cursorEntry) {
          overlays.push({
            rows: [cursorEntry.bodyIndex],
            gutter: theme.diffCursorLineBg,
            content: theme.diffCursorLineBg,
          })
        }
        mergerFor(sides.left).apply(overlays)
        continue
      }
      const leftIndex = invertLineNumbers(sides.left.getLineNumbers())
      // split требует обе стороны: правой нет (unified-геометрия) — ретрай позже.
      if (!sides.right) {
        complete = false
        continue
      }
      const rightIndex = invertLineNumbers(sides.right.getLineNumbers())
      const leftMarkRows: number[] = []
      const rightMarkRows: number[] = []
      for (const marked of markedEntries) {
        const row = resolveSplitRow(marked, leftIndex, rightIndex)
        if (row?.left !== undefined) leftMarkRows.push(row.left)
        if (row?.right !== undefined) rightMarkRows.push(row.right)
      }
      const cursorRow = cursorEntry ? resolveSplitRow(cursorEntry, leftIndex, rightIndex) : undefined
      const leftOverlays: LineDecoration[] = []
      const rightOverlays: LineDecoration[] = []
      if (leftMarkRows.length > 0) leftOverlays.push({ rows: uniqueRows(leftMarkRows), gutter: theme.diffAnnotationMarkBg })
      if (rightMarkRows.length > 0) {
        rightOverlays.push({ rows: uniqueRows(rightMarkRows), gutter: theme.diffAnnotationMarkBg })
      }
      // Курсор следует стороне строки: minus → left, plus → right, context → обе.
      if (cursorRow?.left !== undefined) {
        leftOverlays.push({ rows: [cursorRow.left], gutter: theme.diffCursorLineBg, content: theme.diffCursorLineBg })
      }
      if (cursorRow?.right !== undefined) {
        rightOverlays.push({ rows: [cursorRow.right], gutter: theme.diffCursorLineBg, content: theme.diffCursorLineBg })
      }
      mergerFor(sides.left).apply(leftOverlays)
      mergerFor(sides.right).apply(rightOverlays)
    }
    return complete
  }

  createEffect(() => {
    // Депы (план §5): любое изменение — полный пересбор декораций.
    flatLines()
    cursorIndex()
    store.visibleAnnotations()
    ctx.view()
    ctx.patchPaneWidth()
    ctx.reviewedFileNames()
    const ready = ctx.diffReady()
    api.theme.current
    if (!ready) return
    let retries = 0
    let frames = 0
    const tick = () => {
      if (!ctx.diffReady()) return
      const complete = applyDecorations()
      // Стороны строятся асинхронно — ретраи без преждевременного OFF.
      if (!complete) {
        if (retries++ < DECORATION_APPLY_RETRIES) requestAnimationFrame(tick)
        else noteSidesUnsupportedOnce()
        return
      }
      // Рендерер может пересобрать стороны ПОСЛЕ нашего применения (async syntax
      // parse): несколько догоняющих проходов переснимают pristine и применяют
      // заново; apply идемпотентен (детектор внешнего rebuild'а внутри merger).
      if (frames++ < DECORATION_SETTLE_FRAMES) requestAnimationFrame(tick)
    }
    tick()
  })

  // Watchdog: покрывает поздние async-rebuild'ы рендерера, пришедшие после того,
  // как rAF-цепочка исчерпана; без изменений применение — no-op.
  const decorationWatchdog = setInterval(() => {
    if (!ctx.diffReady()) return
    applyDecorations()
  }, DECORATION_WATCHDOG_MS)
  onCleanup(() => clearInterval(decorationWatchdog))

  // Предикат §10 (контекстная часть): дифф готов ∧ фокус patches ∧ строка — тело ∧ файл
  // не удалён. Занятая строка → правка, свободная → создание, иначе no-op.
  function targetFromLine(line: FlatPatchLine) {
    if (!annotatableBodyLine(line)) return undefined
    const file = ctx.files().find((candidate) => candidate.file === line.filePath)
    if (!file) return undefined
    return editorTargetForLine(file, line.side, line.lineNumber, line.hunk)
  }

  function annotateEnter() {
    if (!ctx.diffReady()) return
    const line = currentLine()
    if (!line) return
    const target = targetFromLine(line)
    if (!target) return
    const existing = store.annotationAt(target.filePath, target.side, target.line)
    if (existing) store.openEdit(existing.id)
    else store.openCreate(target)
    pushEditor()
  }

  function openConfirm(overlay: Omit<Extract<Overlay, { kind: "confirm" }>, "kind">) {
    pushOverlay({ kind: "confirm", ...overlay })
  }

  function requestDeleteAtCursor() {
    if (ctx.focus() !== "patches") return
    if (!ctx.diffReady()) return
    const line = currentLine()
    if (!line || !annotatableBodyLine(line)) return
    const existing = store.annotationAt(line.filePath, line.side, line.lineNumber)
    if (!existing) return
    openConfirm({
      title: "Удалить замечание?",
      message: `${line.filePath} · строка ${line.lineNumber}`,
      confirmLabel: "Удалить",
      danger: true,
      onConfirm: () => store.deleteAnnotation(existing.id),
    })
  }

  function togglePanel() {
    if (topOverlay()?.kind === "panel") {
      closePanel()
      return
    }
    if (overlayActive()) return
    pushOverlay({ kind: "panel" })
  }

  function jumpToAnnotation(annotation: Annotation) {
    if (annotation.state !== "bound") return
    const findIndex = () =>
      flatLines().findIndex(
        (line) =>
          line.filePath === annotation.anchor.filePath &&
          line.side === annotation.anchor.side &&
          line.lineNumber === annotation.anchor.line,
      )
    let index = findIndex()
    if (index === -1 && ctx.compact()) {
      // Прыжок к строке, скрытой компакт-режимом, разворачивает полный вид (FR-8.7).
      ctx.setCompact(false)
      index = findIndex()
    }
    if (index === -1) return
    setCursorIndexClamped(index)
    ensureVisible(index)
    ctx.focusPatches()
    closePanel()
  }

  // Тумгл компакт-режима: позиция курсора сохраняется по идентичности строки;
  // скрывшаяся строка клампится к ближайшей видимой контентной, а якорная строка
  // сохраняет экранную позицию — скролл детерминирован в обе стороны тумгла.
  // Целевой офсет считается только по рядам контента (без геометрии узла):
  // base-офсет узла одинаков до и после, поэтому сокращается. Скрытие строк в
  // предшествующих файлах сдвигает узел целиком — их дельта рядов входит в цель.
  function toggleCompact() {
    if (!ctx.diffReady() || overlayActive()) return
    const scroll = ctx.getScroll()
    const linesBefore = flatLines()
    const filesBefore = ctx.visiblePatchFiles()
    const anchor = currentLine()
    const anchorIndex =
      anchor && isBodyLine(anchor)
        ? cursorIndex()
        : (nearestNavigableIndex(linesBefore, cursorIndex()) ?? cursorIndex())
    const anchorLine = linesBefore[anchorIndex]
    // Идентичность строки между видами: lineIndex не стабилен (трансформация
    // вырезает строки), стабильны сторона/номер/тип.
    const identity = anchorLine
      ? { fileIndex: anchorLine.fileIndex, side: anchorLine.side, lineNumber: anchorLine.lineNumber, kind: anchorLine.kind }
      : undefined
    const anchorNode = anchorLine ? ctx.diffNodeByFileIndex.get(anchorLine.fileIndex) : undefined
    const wrapColumn = anchorNode && !anchorNode.isDestroyed ? unifiedWrapColumn(anchorNode.width) : undefined
    const anchorRows =
      wrapColumn !== undefined && anchorLine
        ? unifiedRowsBefore(parsedLinesFor(anchorLine.fileIndex), anchorLine.lineIndex, wrapColumn)
        : undefined
    const scrollTopBefore = scroll?.scrollTop
    const rowsOfOldFile = (fileIndex: number) =>
      wrapColumn === undefined ? undefined : unifiedRowsBefore(parsedLinesFor(fileIndex), Infinity, wrapColumn)
    const precedingRowsOld =
      wrapColumn === undefined
        ? undefined
        : filesBefore
            .filter((entry) => anchorLine && entry.fileIndex < anchorLine.fileIndex)
            .reduce((sum, entry) => sum + (rowsOfOldFile(entry.fileIndex) ?? 0), 0)
    ctx.setCompact(!ctx.compact())
    // Кэши разбора строились по старому виду — сбрасываем, как это делает эффект
    // пересборки, чтобы не читать компактный разбор для полного списка.
    parsedByFileIndex.clear()
    bodyMapByFileIndex.clear()
    const lines = flatLines()
    let index = -1
    if (identity) {
      index = lines.findIndex(
        (line) =>
          line.fileIndex === identity.fileIndex &&
          line.side === identity.side &&
          line.lineNumber === identity.lineNumber &&
          line.kind === identity.kind,
      )
    }
    if (index === -1) index = nearestNavigableIndex(lines, cursorIndex()) ?? clampCursor(cursorIndex(), lines.length)
    setCursorIndexClamped(index)
    const newLine = lines[index]
    const newRows =
      wrapColumn !== undefined && newLine ? unifiedRowsBefore(parsedLinesFor(newLine.fileIndex), newLine.lineIndex, wrapColumn) : undefined
    const precedingRowsNew =
      wrapColumn === undefined || !newLine
        ? undefined
        : ctx
            .visiblePatchFiles()
            .filter((entry) => entry.fileIndex < newLine.fileIndex)
            .reduce((sum, entry) => sum + unifiedRowsBefore(parsedLinesFor(entry.fileIndex), Infinity, wrapColumn), 0)
    if (scroll !== undefined && scrollTopBefore !== undefined && anchorRows !== undefined && newRows !== undefined) {
      scrollToKeepAnchor(scrollTopBefore + (precedingRowsNew ?? 0) - (precedingRowsOld ?? 0) + newRows - anchorRows)
    } else ensureVisible(index)
  }

  // Закрытие viewer (escape/q): при счётчике ≥ 1 (bound+unbound) — диалог выхода,
  // иначе — обычное закрытие (FR-X1/X2).
  function handleClose(): boolean {
    if (store.count() >= 1) {
      pushOverlay({ kind: "exit" })
      return true
    }
    return false
  }

  const canSend = createMemo(() => {
    if (sessionID === undefined) return false
    return api.state.session.get(sessionID) !== undefined
  })

  function lastUserMessage() {
    if (sessionID === undefined) return undefined
    const messages = api.state.session.messages?.(sessionID)
    if (!messages) return undefined
    return [...messages].reverse().find((message) => message.role === "user")
  }

  // Поглощение черновика по доказательству фиксации (FR-5, план §9): resolve промиса
  // либо обнаружение собранного сообщения в истории при rejection. Идемпотентно.
  function consumeDraft() {
    if (draftConsumed) return
    draftConsumed = true
    disposeDraft(ownerKey)
  }

  // Есть ли собранное сообщение в истории сессии. undefined — стор не загружен
  // (inconclusive): ни toast, ни поглощения до подтверждённого отсутствия.
  // Тип Message в plugin API — метаданные без текста; фактический стор хранит
  // SessionMessage с полем text, читаем структурно.
  function messageInHistory(message: string): boolean | undefined {
    if (sessionID === undefined) return false
    const messages = api.state.session.messages?.(sessionID)
    if (!messages) return undefined
    return messages.some((msg) => {
      if (msg.role !== "user") return false
      const text = (msg as { text?: unknown }).text
      return text === message
    })
  }

  // Классификация rejection по доказательной лестнице: сообщение найдено → фиксация
  // была → поглощение; не найдено → повтор через ~1 с, затем toast с живым черновиком.
  function classifySendFailure(message: string, errorText: string, attempt: number, tick: number) {
    if (draftConsumed) return
    if (tick >= SEND_CLASSIFY_MAX_TICKS) return
    const found = messageInHistory(message)
    if (found === true) {
      consumeDraft()
      return
    }
    if (found === undefined) {
      setTimeout(() => classifySendFailure(message, errorText, attempt, tick + 1), SEND_RETRY_DELAY_MS)
      return
    }
    if (attempt < SEND_RETRY_ATTEMPTS) {
      setTimeout(() => classifySendFailure(message, errorText, attempt + 1, tick + 1), SEND_RETRY_DELAY_MS)
      return
    }
    // Полный сбой фиксации: черновик цел и доступен при повторном открытии (AC-11).
    clearDraftSendInitiated(ownerKey)
    api.ui.toast({ variant: "error", title: "Ошибка отправки замечаний", message: errorText })
  }

  // Отправка (FR-5): fire-and-forget session.prompt + немедленное закрытие viewer.
  // Сборка сообщения детерминирована из стора в момент отправки («всё или ничего»).
  function send() {
    if (!canSend() || sessionID === undefined) return
    // Реентерабельность исключена синхронным гардом и немедленным закрытием диалога.
    if (sendInitiated) return
    sendInitiated = true
    // Ревалидация якорей перед отправкой — против отображаемого снапшота (FR-Y4).
    store.rebindAll(ctx.files())
    const message = assembleMessage(
      store.visibleAnnotations().map((annotation) => ({
        filePath: annotation.anchor.filePath,
        side: annotation.anchor.side,
        originLine: annotation.anchor.originLine,
        line: annotation.anchor.line,
        hunk: annotation.anchor.hunk,
        window: annotation.anchor.window,
        anchorOffset: annotation.anchor.anchorOffset,
        text: annotation.text,
        bound: annotation.state === "bound",
      })),
      ctx.files(),
    )
    const request = buildPromptRequest(sessionID, api.state.session.get(sessionID), lastUserMessage(), message)
    markDraftSendInitiated(ownerKey, message, undefined)
    api.client.session.prompt(request, { throwOnError: true }).then(
      () => consumeDraft(),
      (error: unknown) => {
        const errorText = error instanceof Error ? error.message : String(error)
        markDraftSendInitiated(ownerKey, message, errorText)
        classifySendFailure(message, errorText, 0, 0)
      },
    )
    // Фокус в сессии; состояний ожидания/retry в viewer нет (AC-10/12).
    popAllOverlays()
    ctx.closeViewer()
  }

  // Смена/обновление источника при живом черновике — только через подтверждение (FR-S3/S4):
  // отказ ничего не меняет; подтверждение помечает ожидание ревалидации нового снапшота.
  function confirmSourceSwitch(proceed: () => void) {
    if (store.count() === 0) {
      proceed()
      return
    }
    openConfirm({
      title: "Обновить снапшот диффа?",
      message: "Привязки замечаний могут развалиться; непривязанные останутся в черновике.",
      confirmLabel: "Обновить",
      onConfirm: () => {
        rebindPending = true
        proceed()
      },
    })
  }

  // Монтирование: догоняющая классификация зависшей отправки (план §9) + подтверждение
  // свежего снапшота при живом черновике (FR-S5).
  onMount(() => {
    if (record.sendInitiated && record.sentMessage !== undefined) {
      classifySendFailure(record.sentMessage, record.lastError ?? "отправка не завершена", 0, 0)
    }
    if (store.count() === 0) return
    pushOverlay({
      kind: "confirm",
      title: "Обновить снапшот диффа?",
      message: "Черновик содержит замечания: загрузить свежий дифф и перепривязать их?",
      confirmLabel: "Загрузить свежий",
      onConfirm: () => {
        rebindPending = true
      },
      onCancel: () => ctx.closeViewer(),
    })
  })

  // Ревалидация после прибытия нового снапшота (смена источника/переоткрытие): bound/unbound
  // классификация, ничего не удаляется тихо (FR-S1/S2). Пустое значение во время загрузки
  // отрабатывается повторным вызовом на реальных файлах.
  createEffect(
    on(
      ctx.files,
      (files) => {
        if (!rebindPending || !files) return
        store.rebindAll(files)
        rebindPending = false
      },
    ),
  )

  // Goto-ввод (FR-4.x): чистая машина состояний + два keymap-слоя. Стартовый слой
  // ловит первую цифру в фокусе патчей; активный слой глотает всё, кроме Tab.
  const gotoDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
  const gotoLayerEnabled = () => ctx.focus() === "patches" && ctx.diffReady() && !overlayActive()

  function applyGoto(event: Parameters<typeof gotoTransition>[1]) {
    const result = gotoTransition(gotoBuffer(), event)
    setGotoBuffer(result.buffer)
    if (result.committed === undefined) return
    const line = currentLine()
    if (!line) return
    const index = gotoTargetIndex(flatLines(), line.fileIndex, result.committed)
    if (index === -1) return
    setCursorIndexClamped(index)
    ensureVisible(index)
  }

  useBindings(() => ({
    enabled: gotoLayerEnabled() && gotoBuffer() === undefined,
    commands: gotoDigits.map((digit) => ({
      name: `diff.goto.digit.${digit}`,
      run: () => applyGoto({ kind: "digit", digit }),
    })),
    bindings: gotoDigits.map((digit) => ({ key: digit, cmd: `diff.goto.digit.${digit}`, desc: "Goto line" })),
  }))

  useBindings(() => ({
    enabled: gotoLayerEnabled() && gotoBuffer() !== undefined,
    priority: 2,
    commands: [
      ...gotoDigits.map((digit) => ({
        name: `diff.goto.append.${digit}`,
        run: () => applyGoto({ kind: "digit", digit }),
      })),
      { name: "diff.goto.commit", run: () => applyGoto({ kind: "enter" }) },
      { name: "diff.goto.cancel", run: () => applyGoto({ kind: "escape" }) },
      { name: "diff.goto.backspace", run: () => applyGoto({ kind: "backspace" }) },
      { name: "diff.goto.tab", run: () => applyGoto({ kind: "tab" }) },
    ],
    bindings: [
      ...gotoDigits.map((digit) => ({ key: digit, cmd: `diff.goto.append.${digit}` })),
      { key: "return", cmd: "diff.goto.commit" },
      { key: "escape", cmd: "diff.goto.cancel" },
      { key: "backspace", cmd: "diff.goto.backspace" },
      // Командные клавиши viewer отменяют ввод и поглощаются (FR-4.8); Tab
      // отменяет без поглощения — фокус уходит по назначению клавиши (FR-4.9).
      { key: "tab", cmd: "diff.goto.tab", fallthrough: true },
      {
        key: "j,down,k,up,n,N,J,K,e,],[,b,s,o,v,m,E,q,a,d,c,g,?,space,right,left,pageup,pagedown,ctrl+f,ctrl+b",
        cmd: "diff.goto.cancel",
      },
    ],
  }))

  const commands = [
    {
      name: "diff.annotate",
      title: "Annotate diff line",
      category: "VCS",
      slashName: "diff-annotate",
      namespace: "palette",
      run() {
        // Enter в фокусе дерева: файл — показать и перевести фокус в diff,
        // папка — toggle с сохранением фокуса в дереве (FR-3.1–3.3).
        if (ctx.focus() === "files") {
          ctx.activateFileTreeRow()
          return
        }
        annotateEnter()
      },
    },
    {
      name: "diff.annotate_delete",
      title: "Delete annotation on line",
      category: "VCS",
      slashName: "diff-annotate-delete",
      namespace: "palette",
      run() {
        requestDeleteAtCursor()
      },
    },
    {
      name: "diff.annotations_panel",
      title: "Toggle annotations panel",
      category: "VCS",
      slashName: "diff-annotations",
      namespace: "palette",
      run() {
        togglePanel()
      },
    },
  ]

  const overlays = (
    <>
      <Show when={overlayStack().some((overlay) => overlay.kind === "panel")}>
        <AnnotationsPanel
          api={api}
          store={store}
          files={ctx.files}
          active={() => topOverlay()?.kind === "panel"}
          onEdit={(id) => {
            store.openEdit(id)
            pushEditor()
          }}
          onDelete={(id) =>
            openConfirm({
              title: "Удалить замечание?",
              confirmLabel: "Удалить",
              danger: true,
              onConfirm: () => store.deleteAnnotation(id),
            })
          }
          onJump={jumpToAnnotation}
          onClose={closePanel}
        />
      </Show>
      <Show when={topOverlay()?.kind === "editor"}>
        <AnnotationEditor api={api} store={store} onClose={() => popOverlay("editor")} />
      </Show>
      <Show when={topOverlay()?.kind === "exit"}>
        <ExitDialog
          api={api}
          count={() => store.count()}
          canSend={canSend}
          sessionless={() => sessionID === undefined}
          onSend={() => send()}
          onSaveDraft={() => {
            popAllOverlays()
            ctx.closeViewer()
          }}
          onDiscard={() => {
            disposeDraft(ownerKey)
            popAllOverlays()
            ctx.closeViewer()
          }}
          onCancel={() => popOverlay("exit")}
        />
      </Show>
      <Show when={confirmOverlay()}>
        {(overlay) => (
          <ConfirmDialog
            api={api}
            title={overlay().title}
            message={overlay().message}
            confirmLabel={overlay().confirmLabel}
            danger={overlay().danger}
            onConfirm={() => {
              overlay().onConfirm()
              popOverlay("confirm")
            }}
            onCancel={() => {
              overlay().onCancel?.()
              popOverlay("confirm")
            }}
          />
        )}
      </Show>
    </>
  )

  createEffect(() => {
    // Потеря фокуса патчей сбрасывает goto-ввод (FR-4.10).
    if (ctx.focus() !== "patches") setGotoBuffer(undefined)
  })

  return {
    commands,
    overlays,
    overlayActive,
    cursorActive: () => flatLines().length > 0,
    currentLine,
    moveCursor,
    pageCursor,
    quarterCursor,
    setCursorToFileRow,
    firstNavigableIndexOfFile,
    statusText,
    handleClose,
    confirmSourceSwitch,
    toggleCompact,
  }
}
