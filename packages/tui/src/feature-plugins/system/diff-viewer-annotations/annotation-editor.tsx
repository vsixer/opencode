/** @jsxImportSource @opentui/solid */
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useBindings } from "../../../keymap"
import type { AnnotationStore } from "./store"

// Модальное multiline-поле создания/редактирования замечания. alt+enter — подтвердить
// (пустой ввод = отмена), обычный enter — перевод строки, escape — отмена.
// ctrl+enter/ctrl+delete — полные no-op, чтобы не конфликтовать с переводом строки.
// Дефект A (FR-O3): textarea фокусируется в момент открытия — символы печатаются немедленно.
export function AnnotationEditor(props: { api: TuiPluginApi; store: AnnotationStore; onClose: () => void }) {
  const theme = () => props.api.theme.current
  const state = () => props.store.editor()
  const open = () => state().kind === "open"
  const title = createMemo(() => {
    const s = state()
    return s.kind === "open" ? (s.mode === "edit" ? "Редактирование замечания" : "Новое замечание") : ""
  })
  const initial = () => {
    const s = state()
    return s.kind === "open" ? s.initial : ""
  }
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable | undefined

  // Фокус поля при каждом открытии (паттерн src/ui/dialog-prompt.tsx): отложенный
  // вызов в onMount гарантирует, что renderer зафиксирует focused target для keymap,
  // иначе слой с target не активируется и alt+return/escape не доходят.
  onMount(() => {
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
      textarea.gotoLineEnd()
    }, 1)
  })
  createEffect(
    on(open, (isOpen) => {
      if (!isOpen || !textarea || textarea.isDestroyed) return
      textarea.focus()
    }),
  )

  useBindings(() => ({
    target,
    enabled: open(),
    // Семантика формы редактора должна побеждать глобальный managed textarea layer
    // (паттерн src/ui/dialog-prompt.tsx): alt+return — подтверждение, а не перевод
    // строки; ctrl+return/ctrl+delete глотаются как no-op.
    priority: 1,
    commands: [
      {
        name: "diff.annotate.editor.submit",
        run() {
          if (!textarea) return
          props.store.confirmEditor(textarea.plainText)
          props.onClose()
        },
      },
      {
        name: "diff.annotate.editor.cancel",
        run() {
          props.store.closeEditor()
          props.onClose()
        },
      },
      {
        name: "diff.annotate.editor.noop",
        run() {},
      },
      {
        // Глобальный managed textarea layer вешает return на submit —
        // в редакторе замечания enter обязан быть переводом строки.
        name: "diff.annotate.editor.newline",
        run() {
          textarea?.newLine()
        },
      },
    ],
    bindings: [
      { key: "alt+return", cmd: "diff.annotate.editor.submit", desc: "Подтвердить замечание" },
      { key: "escape", cmd: "diff.annotate.editor.cancel", desc: "Отмена" },
      { key: "return", cmd: "diff.annotate.editor.newline", desc: "Перевод строки" },
      // ctrl+d не текстовая клавиша — bind-and-noop безопасен и не даёт ей
      // провалиться в живой app_exit-слой, пока поле ввода владеет клавиатурой.
      { key: "ctrl+return,ctrl+delete,ctrl+d", cmd: "diff.annotate.editor.noop" },
    ],
  }))

  return (
    <Show when={open()}>
      <box
        position="absolute"
        zIndex={2600}
        left="20%"
        top="30%"
        width="60%"
        height={9}
        border
        backgroundColor={theme().backgroundPanel}
        borderColor={theme().borderActive}
      >
        <text fg={theme().text} attributes={TextAttributes.BOLD}>
          {title()}
        </text>
        <textarea
          ref={(value: TextareaRenderable) => {
            textarea = value
            setTarget(value)
          }}
          initialValue={initial()}
          placeholder="Текст замечания…"
          placeholderColor={theme().textMuted}
          textColor={theme().text}
          height={5}
        />
        <text fg={theme().textMuted}>alt+enter — подтвердить · esc — отмена</text>
      </box>
    </Show>
  )
}
