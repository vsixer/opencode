import { createMemo, createSignal } from "solid-js"
import { rebind } from "./fingerprint"
import { buildSideWindow, parsePatchFileLines, sideLines, type DiffFile, type PatchSide } from "./patch-lines"

export type AnnotationState = "bound" | "unbound"

// Якорь аннотации: файл + строка + сторона (FR-Y1). originLine/window/anchorOffset —
// снимок на момент создания (FR-Y3), line — текущий номер после перепривязки.
export type Anchor = {
  readonly filePath: string
  readonly side: PatchSide
  readonly originLine: number
  readonly hunk: number | null
  readonly window: readonly string[]
  readonly anchorOffset: number
  line: number
}

export type Annotation = {
  readonly id: string
  readonly anchor: Anchor
  text: string
  state: AnnotationState
}

export type EditorTarget = {
  readonly filePath: string
  readonly side: PatchSide
  readonly line: number
  readonly hunk: number | null
  readonly window: readonly string[]
  readonly anchorOffset: number
}

export type EditorState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly mode: "create" | "edit"; readonly target: EditorTarget; readonly annotationId?: string; readonly initial: string }

// Стор черновика одной сессии-владельца. Создаётся под createRoot (drafts.ts), переживающим
// размонтирование viewer. Инвариант FR-N10: записей с пустым/пробельным текстом не существует
// ни в один момент — пустой ввод трактуется как отмена.
export function createAnnotationStore() {
  const [annotations, setAnnotations] = createSignal<readonly Annotation[]>([])
  const [editor, setEditor] = createSignal<EditorState>({ kind: "closed" })

  let nextId = 1
  const newId = () => `ann-${nextId++}`

  const visibleAnnotations = createMemo(() => annotations())
  const count = createMemo(() => annotations().length)

  function countForFile(filePath: string): number {
    return annotations().filter((a) => a.anchor.filePath === filePath).length
  }

  function annotationAt(filePath: string, side: PatchSide, line: number): Annotation | undefined {
    return annotations().find((a) => a.anchor.filePath === filePath && a.anchor.side === side && a.anchor.line === line)
  }

  function openCreate(target: EditorTarget) {
    setEditor({ kind: "open", mode: "create", target, initial: "" })
  }

  function openEdit(annotationId: string) {
    const found = annotations().find((a) => a.id === annotationId)
    if (!found) return
    setEditor({
      kind: "open",
      mode: "edit",
      target: {
        filePath: found.anchor.filePath,
        side: found.anchor.side,
        line: found.anchor.line,
        hunk: found.anchor.hunk,
        window: found.anchor.window,
        anchorOffset: found.anchor.anchorOffset,
      },
      annotationId,
      initial: found.text,
    })
  }

  function confirmEditor(text: string) {
    const state = editor()
    if (state.kind !== "open") return
    // Пустой/пробельный ввод = отмена: создание не создаёт, правка сохраняет прежний текст.
    if (text.trim() === "") {
      closeEditor()
      return
    }
    if (state.mode === "create") {
      // FR-N7: одна аннотация на строку (файл+строка+сторона) — на всех путях.
      const existing = annotationAt(state.target.filePath, state.target.side, state.target.line)
      if (existing) {
        const id = existing.id
        setAnnotations((list) => list.map((a) => (a.id === id ? { ...a, text } : a)))
      } else {
        setAnnotations((list) => [
          ...list,
          { id: newId(), anchor: { ...state.target, originLine: state.target.line }, text, state: "bound" },
        ])
      }
    } else if (state.annotationId) {
      const id = state.annotationId
      setAnnotations((list) => list.map((a) => (a.id === id ? { ...a, text } : a)))
    }
    closeEditor()
  }

  function closeEditor() {
    setEditor({ kind: "closed" })
  }

  function deleteAnnotation(id: string) {
    setAnnotations((list) => list.filter((a) => a.id !== id))
  }

  function deleteAt(filePath: string, side: PatchSide, line: number) {
    setAnnotations((list) =>
      list.filter((a) => !(a.anchor.filePath === filePath && a.anchor.side === side && a.anchor.line === line)),
    )
  }

  // Ревалидация всех якорей против отображаемого снапшота (FR-Y5): для каждого файла из
  // files строится side-последовательность разобранного патча. Файл исчез или удалён
  // целиком → unbound (строк-целей не существует). Ничего не удаляется тихо (FR-S2).
  function rebindAll(files: readonly DiffFile[]) {
    const parsedByFile = new Map<string, ReturnType<typeof parsePatchFileLines>>()
    const parsedFor = (file: DiffFile) => {
      const cached = parsedByFile.get(file.file)
      if (cached) return cached
      const fresh = parsePatchFileLines(file.patch)
      parsedByFile.set(file.file, fresh)
      return fresh
    }
    setAnnotations((list) =>
      list.map((ann) => {
        const file = files.find((f) => f.file === ann.anchor.filePath)
        if (!file || file.status === "deleted" || !file.patch) return { ...ann, state: "unbound" }
        const result = rebind(sideLines(parsedFor(file), ann.anchor.side), ann.anchor.window, ann.anchor.anchorOffset, ann.anchor.originLine)
        return result.found
          ? { ...ann, state: "bound", anchor: { ...ann.anchor, line: result.newLine } }
          : { ...ann, state: "unbound" }
      }),
    )
  }

  function clearAll() {
    setAnnotations([])
  }

  return {
    annotations,
    visibleAnnotations,
    count,
    countForFile,
    annotationAt,
    openCreate,
    openEdit,
    confirmEditor,
    closeEditor,
    deleteAnnotation,
    deleteAt,
    rebindAll,
    clearAll,
    editor,
  }
}

export type AnnotationStore = ReturnType<typeof createAnnotationStore>

// Сборка EditorTarget для строки патча текущего снапшота: окно отпечатка клампится
// в пределах ханка (FR-Y2/R8); anchorOffset фиксируется вместе с окном.
export function editorTargetForLine(
  file: DiffFile,
  side: PatchSide,
  line: number,
  hunk: number | null,
): EditorTarget {
  const parsed = parsePatchFileLines(file.patch)
  const window = hunk === null ? { texts: [], anchorOffset: 0 } : buildSideWindow(parsed, side, line, hunk, 3)
  return { filePath: file.file, side, line, hunk, window: window.texts, anchorOffset: window.anchorOffset }
}
