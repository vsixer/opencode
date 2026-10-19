/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import type { DiffAnnotationsApi } from "./api"
import { useBindings } from "@opentui/keymap/solid"

// Генерик-диалог подтверждения: заголовок + подтверждающая/отменяющая опции.
// Начальный фокус детерминирован на подтверждающей опции (FR-O1): pressEnter
// подтверждает, pressEscape отклоняет, pressTab переключает выбор (AC-08/AC-30).
export function ConfirmDialog(props: {
  api: DiffAnnotationsApi
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const theme = () => props.api.theme
  // Детерминированный начальный фокус — подтверждающая опция (FR-O1).
  const [selectedConfirm, setSelectedConfirm] = createSignal(true)

  useBindings(() => ({
    commands: [
      {
        name: "diff.annotate.confirm.accept",
        run: () => (selectedConfirm() ? props.onConfirm() : props.onCancel()),
      },
      { name: "diff.annotate.confirm.toggle", run: () => setSelectedConfirm((value) => !value) },
      { name: "diff.annotate.confirm.decline", run: () => props.onCancel() },
      // Модальный диалог: ctrl+d глотается, а не проваливается в app_exit.
      { name: "diff.annotate.confirm.noop", run: () => {} },
    ],
    bindings: [
      { key: "return", cmd: "diff.annotate.confirm.accept", desc: "Выбрать" },
      { key: "tab", cmd: "diff.annotate.confirm.toggle", desc: "Переключить" },
      { key: "escape", cmd: "diff.annotate.confirm.decline", desc: "Отмена" },
      { key: "ctrl+d", cmd: "diff.annotate.confirm.noop" },
    ],
  }))

  return (
    <box
      position="absolute"
      zIndex={2600}
      left="25%"
      top="35%"
      width="50%"
      height={8}
      border
      backgroundColor={theme().background.raised.high}
      borderColor={theme().border.base}
      flexDirection="column"
      gap={1}
    >
      <text fg={props.danger ? theme().text.feedback.error.base : theme().text.base} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      {props.message ? <text fg={theme().text.muted}>{props.message}</text> : null}
      <box flexDirection="row" gap={2}>
        <text fg={selectedConfirm() ? (props.danger ? theme().text.feedback.error.base : theme().text.action.primary.base) : theme().text.muted}>
          {selectedConfirm() ? "› " : "  "}
          {props.confirmLabel ?? "Подтвердить"}
        </text>
        <text fg={selectedConfirm() ? theme().text.muted : theme().text.base}>{"Отмена"}</text>
      </box>
      <text fg={theme().text.muted}>enter — выбрать · tab — переключить · esc — отмена</text>
    </box>
  )
}
