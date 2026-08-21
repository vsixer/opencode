/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useBindings } from "../../../keymap"

type ExitOption = {
  readonly key: "send" | "save" | "discard" | "cancel"
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly danger: boolean
}

// Диалог выхода из viewer при живом черновике (FR-X1…X5). Четыре опции:
// Отправить / Сохранить черновик / Отбросить (необратим) / Отмена. Начальный фокус
// детерминирован: «Отправить» при живой сессии-владельце, иначе «Сохранить черновик»
// (FR-X3); в безсессионном viewer «Отправить» недоступна с пояснением и пропускается
// фокусом. Управление: j/k и tab/shift+tab — навигация, enter — выбор, escape — отмена.
// Состояний ожидания/ошибки отправки нет: отправка fire-and-forget закрывает viewer
// немедленно (FR-5), классификация сбоя живёт вне диалога.
export function ExitDialog(props: {
  api: TuiPluginApi
  count: () => number
  canSend: () => boolean
  sessionless: () => boolean
  onSend: () => void
  onSaveDraft: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  const theme = () => props.api.theme.current

  const options = createMemo<readonly ExitOption[]>(() => [
    {
      key: "send",
      label: "Отправить",
      hint: props.sessionless() ? "нет сессии-владельца" : "одно сообщение со всеми замечаниями",
      disabled: !props.canSend(),
      danger: false,
    },
    { key: "save", label: "Сохранить черновик", hint: "черновик переживёт закрытие", disabled: false, danger: false },
    { key: "discard", label: "Отбросить", hint: "необратимо", disabled: false, danger: true },
    { key: "cancel", label: "Отмена", hint: "вернуться в viewer", disabled: false, danger: false },
  ])

  const enabledIndexes = createMemo(() => options().flatMap((option, index) => (option.disabled ? [] : [index])))

  function initialIndex(): number {
    // FR-X3: живой владелец → 0 (Отправить); иначе 1 (Сохранить черновик).
    const firstEnabled = enabledIndexes()[0]
    return firstEnabled === 0 ? 0 : 1
  }
  const [selected, setSelected] = createSignal(initialIndex())

  function move(offset: number) {
    const enabled = enabledIndexes()
    if (enabled.length === 0) return
    const current = enabled.indexOf(selected())
    const next = enabled[(current === -1 ? 0 : current + offset + enabled.length) % enabled.length]
    setSelected(next)
  }

  function choose() {
    const option = options()[selected()]
    if (!option || option.disabled) return
    if (option.key === "send") props.onSend()
    else if (option.key === "save") props.onSaveDraft()
    else if (option.key === "discard") props.onDiscard()
    else props.onCancel()
  }

  useBindings(() => ({
    commands: [
      { name: "diff.annotate.exit.next", run: () => move(1) },
      { name: "diff.annotate.exit.previous", run: () => move(-1) },
      { name: "diff.annotate.exit.choose", run: () => choose() },
      { name: "diff.annotate.exit.cancel", run: () => props.onCancel() },
    ],
    bindings: [
      { key: "j,down", cmd: "diff.annotate.exit.next", desc: "Следующая опция" },
      { key: "k,up", cmd: "diff.annotate.exit.previous", desc: "Предыдущая опция" },
      { key: "tab", cmd: "diff.annotate.exit.next", desc: "Следующая опция" },
      { key: "shift+tab", cmd: "diff.annotate.exit.previous", desc: "Предыдущая опция" },
      { key: "return", cmd: "diff.annotate.exit.choose", desc: "Выбрать" },
      { key: "escape", cmd: "diff.annotate.exit.cancel", desc: "Отмена" },
    ],
  }))

  return (
    <box
      position="absolute"
      zIndex={2600}
      left="20%"
      top="25%"
      width="60%"
      height={14}
      border
      backgroundColor={theme().backgroundPanel}
      borderColor={theme().borderActive}
      flexDirection="column"
      gap={1}
    >
      <text fg={theme().text} attributes={TextAttributes.BOLD}>
        Замечаний в черновике: {props.count()}
      </text>
      {options().map((option, index) => (
        <box flexDirection="row" gap={1}>
          <text
            wrapMode="none"
            width={20}
            fg={
              option.disabled
                ? theme().textMuted
                : option.danger
                  ? theme().error
                  : selected() === index
                    ? theme().accent
                    : theme().text
            }
          >
            {`${selected() === index ? "› " : "  "}${option.label}${option.disabled ? " (недоступно)" : ""}`}
          </text>
          <text wrapMode="none" fg={theme().textMuted}>
            — {option.hint}
          </text>
        </box>
      ))}
      <text fg={theme().textMuted}>j/k · tab · enter — выбрать · esc — отмена</text>
    </box>
  )
}
