// Pure-функции стека оверлеев аннотирования: идемпотентный push редактора,
// LIFO-pop и усечение по панели. Стек — единственный источник истины о том,
// какая поверхность владеет клавиатурой; инварианты закреплены тестами.

export type OverlayLike = { readonly kind: string }

// Push редактора идемпотентен: store хранит один editor-state, второй editor
// поверх существующего не имеет семантики и ломает LIFO-закрытие панели.
export function pushEditorOverlay<T extends OverlayLike>(stack: readonly T[], editor: T): readonly T[] {
  if (stack[stack.length - 1]?.kind === "editor") return stack
  return [...stack, editor]
}

// LIFO-pop: снимает ровно верхний элемент при совпадении kind, иначе no-op.
export function popOverlayTop<T extends OverlayLike>(stack: readonly T[], kind: string): readonly T[] {
  return stack[stack.length - 1]?.kind === kind ? stack.slice(0, -1) : stack
}

// Закрытие панели снимает её и всё выше неё: даже из деградированного стека
// (остаточные editor/confirm над panel) листинг закрывается всегда (FR-3.1).
export function closePanelStack<T extends OverlayLike>(stack: readonly T[]): readonly T[] {
  const index = stack.findIndex((overlay) => overlay.kind === "panel")
  return index === -1 ? stack : stack.slice(0, index)
}

// Синхронизация стека с editor-state стора: закрыт — остаточные editor
// самоликвидируются; открыт — editor ровно один и он верхний.
export function syncEditorOverlay<T extends OverlayLike>(
  stack: readonly T[],
  editorOpen: boolean,
  makeEditor: () => T,
): readonly T[] {
  if (!editorOpen) {
    if (!stack.some((overlay) => overlay.kind === "editor")) return stack
    return stack.filter((overlay) => overlay.kind !== "editor")
  }
  const top = stack[stack.length - 1]
  if (top?.kind === "editor" && stack.filter((overlay) => overlay.kind === "editor").length === 1) return stack
  return [...stack.filter((overlay) => overlay.kind !== "editor"), makeEditor()]
}
