import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { selectedForeground, tint, useTheme } from "../../context/theme"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { useBindings, useOpencodeModeStack } from "../../keymap"

const QUESTION_MODE = "question"

type QuestionDraft = {
  tab: number
  answers: QuestionAnswer[]
  custom: string[]
  selected: number
  editing: boolean
  text: string
}

// Черновик ответа живёт вне компонента: при переходе в сессию субагента маршрут
// сменяется и QuestionPrompt размонтируется, теряя локальный store.
const drafts = new Map<string, QuestionDraft>()

export function QuestionPrompt(props: { request: QuestionRequest; directory?: string; onResolve?: (id: string) => void }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1)) // questions + confirm tab (no confirm for single select)
  const [tabHover, setTabHover] = createSignal<number | "confirm" | null>(null)
  const draft = drafts.get(props.request.id)
  const [store, setStore] = createStore({
    tab: draft?.tab ?? 0,
    // Клонируем массивы: Map не должен разделять mutable-ссылки с store
    answers: draft ? draft.answers.map((a) => [...a]) : ([] as QuestionAnswer[]),
    custom: draft ? [...draft.custom] : ([] as string[]),
    selected: draft?.selected ?? 0,
    editing: draft?.editing ?? false,
  })
  let pendingRestore = draft?.editing ? draft.text : undefined

  let textarea: TextareaRenderable | undefined
  const [editTarget, setEditTarget] = createSignal<TextareaRenderable>()

  // Локальное закрытие: событие сервера может задержаться в sync-store, поэтому
  // форма скрывается сразу после терминального действия и сбрасывается по новому запросу.
  const [resolved, setResolved] = createSignal(false)
  // id запроса дублируется в plain-переменную: props сносятся до запуска onCleanup,
  // а черновик сохраняется именно там.
  let requestID = props.request.id
  createEffect(
    on(
      () => props.request.id,
      (id) => {
        requestID = id
        setResolved(false)
      },
    ),
  )

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  // Терминальные ветки сначала отправляют ответ серверу и только потом мутируют
  // состояние: onResolve синхронно размонтирует форму внутри записи сигнала
  // родителя, и исключение из этого флуша не должно рвать доставку ответа.
  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    void sdk.client.question.reply({
      requestID: props.request.id,
      directory: props.directory,
      answers,
    })
    drafts.delete(requestID)
    setResolved(true)
    notifyResolved()
  }

  function reject() {
    void sdk.client.question.reject({
      requestID: props.request.id,
      directory: props.directory,
    })
    drafts.delete(requestID)
    setResolved(true)
    notifyResolved()
  }

  // Размонтирование внутри записи сигнала выполняется синхронно; исключение из
  // чужого cleanup не должно всплывать дальше в обработчик клавиш.
  function notifyResolved() {
    try {
      props.onResolve?.(requestID)
    } catch {}
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      void sdk.client.question.reply({
        requestID: props.request.id,
        directory: props.directory,
        answers: [[answer]],
      })
      drafts.delete(requestID)
      setResolved(true)
      notifyResolved()
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("selected", 0)
  }

  function selectOption() {
    if (other()) {
      if (!multi()) {
        setStore("editing", true)
        return
      }
      const value = input()
      if (value && customPicked()) {
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  // Отправка свободного ответа: пустой текст блокируется, commit повторяет
  // логику старого return-хендлера, затем продвижение к следующему вопросу
  // или финальный submit.
  function submitEdit() {
    const text = textarea?.plainText?.trim() ?? ""
    if (!text) return
    const prev = store.custom[store.tab]
    const wasLast = store.tab >= questions().length - 1

    if (multi()) {
      const inputs = [...store.custom]
      inputs[store.tab] = text
      setStore("custom", inputs)

      const existing = store.answers[store.tab] ?? []
      const next = [...existing]
      if (prev) {
        const index = next.indexOf(prev)
        if (index !== -1) next.splice(index, 1)
      }
      if (!next.includes(text)) next.push(text)
      const answers = [...store.answers]
      answers[store.tab] = next
      setStore("answers", answers)
    } else {
      pick(text, true)
    }

    if (single()) {
      setStore("editing", false)
      return
    }
    setStore("editing", false)
    pendingRestore = undefined
    if (wasLast) {
      submit()
      return
    }
    // Для multi-вопроса pick не вызывался — сдвигаем вкладку вручную;
    // для одиночного выбора сдвиг уже сделан внутри pick().
    if (multi()) selectTab(store.tab + 1)
  }

  // Возврат к вариантам с сохранением набранного текста: при повторном входе
  // в editing он восстанавливается через pendingRestore в ref textarea.
  function exitEditing() {
    const text = textarea?.plainText ?? ""
    if (text) pendingRestore = text
    setStore("editing", false)
  }

  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  onCleanup(() => {
    drafts.set(requestID, {
      ...store,
      text: store.editing ? (textarea?.plainText ?? "") : "",
    })
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    // target+priority побеждают global managed textarea layer, который иначе
    // перехватывает return как submit (паттерн annotation-editor.tsx).
    target: editTarget,
    priority: 1,
    enabled: store.editing && !confirm() && !resolved(),
    commands: [
      {
        name: "prompt.clear",
        title: "Clear answer edit",
        category: "Question",
        run() {
          const text = textarea?.plainText ?? ""
          if (!text) {
            setStore("editing", false)
            return
          }
          textarea?.setText("")
        },
      },
      // Основной блок, регистрирующий app.exit, disabled во время editing —
      // поэтому ctrl+c без локальной регистрации проваливается в базовый app_exit
      // и закрывает приложение вместо отклонения вопроса.
      {
        name: "app.exit",
        title: "Reject question",
        category: "Question",
        run() {
          reject()
        },
      },
    ],
    bindings: [
      { key: "alt+return", desc: "Submit answer", group: "Question", cmd: () => submitEdit() },
      // Enter — перенос строки, отправка только по alt+enter
      { key: "return", desc: "New line", group: "Question", cmd: () => textarea?.newLine() },
      { key: "shift+escape", desc: "Back to options", group: "Question", cmd: () => exitEditing() },
      // Без явной no-op привязки escape проваливается в базовый слой,
      // где он обозначает session_interrupt, и прерывает сессию агента
      // прямо во время ввода ответа.
      { key: "escape", group: "Question", cmd: () => {} },
      // ctrl+enter не назначается; no-op защищает перенос строки от провала
      // в базовые слои (паттерн annotation-editor).
      { key: "ctrl+return", group: "Question", cmd: () => {} },
      ...tuiConfig.keybinds.get("app.exit"),
      ...tuiConfig.keybinds.get("prompt.clear"),
    ],
  }))

  useBindings(() => {
    const opts = options()
    const total = opts.length + (custom() ? 1 : 0)
    const max = Math.min(total, 9)

    return {
      mode: QUESTION_MODE,
      enabled: !store.editing && !resolved(),
      commands: [
        {
          name: "app.exit",
          title: "Reject question",
          category: "Question",
          run() {
            reject()
          },
        },
      ],
      bindings: [
        {
          key: "left",
          desc: "Previous question",
          group: "Question",
          cmd: () => selectTab((store.tab - 1 + tabs()) % tabs()),
        },
        {
          key: "h",
          desc: "Previous question",
          group: "Question",
          cmd: () => selectTab((store.tab - 1 + tabs()) % tabs()),
        },
        { key: "right", desc: "Next question", group: "Question", cmd: () => selectTab((store.tab + 1) % tabs()) },
        { key: "l", desc: "Next question", group: "Question", cmd: () => selectTab((store.tab + 1) % tabs()) },
        {
          key: "tab",
          desc: "Next question",
          group: "Question",
          cmd: ({ event }: { event: { shift: boolean } }) => {
            selectTab((store.tab + (event.shift ? -1 : 1) + tabs()) % tabs())
          },
        },
        ...(confirm()
          ? [
              { key: "return", desc: "Submit answer", group: "Question", cmd: () => submit() },
              // no-op: глотаем escape, чтобы он не провалился в базовый session_interrupt
              { key: "escape", group: "Question", cmd: () => {} },
              { key: "shift+escape", desc: "Reject question", group: "Question", cmd: () => reject() },
              ...tuiConfig.keybinds.get("app.exit"),
            ]
          : [
              ...Array.from({ length: max }, (_, index) => ({
                key: String(index + 1),
                desc: `Select answer ${index + 1}`,
                group: "Question",
                cmd: () => {
                  moveTo(index)
                  selectOption()
                },
              })),
              {
                key: "up",
                desc: "Previous answer",
                group: "Question",
                cmd: () => moveTo((store.selected - 1 + total) % total),
              },
              {
                key: "k",
                desc: "Previous answer",
                group: "Question",
                cmd: () => moveTo((store.selected - 1 + total) % total),
              },
              { key: "down", desc: "Next answer", group: "Question", cmd: () => moveTo((store.selected + 1) % total) },
              { key: "j", desc: "Next answer", group: "Question", cmd: () => moveTo((store.selected + 1) % total) },
              { key: "return", desc: "Select answer", group: "Question", cmd: () => selectOption() },
              // no-op: глотаем escape, чтобы он не провалился в базовый session_interrupt
              { key: "escape", group: "Question", cmd: () => {} },
              { key: "shift+escape", desc: "Reject question", group: "Question", cmd: () => reject() },
              ...tuiConfig.keybinds.get("app.exit"),
            ]),
      ],
    }
  })

  return (
    <Show when={!resolved()}>
      <box
        backgroundColor={theme.backgroundPanel}
        border={["left"]}
        borderColor={theme.accent}
        customBorderChars={SplitBorder.customBorderChars}
      >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <Show when={!single()}>
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <For each={questions()}>
              {(q, index) => {
                const isActive = () => index() === store.tab
                const isAnswered = () => {
                  return (store.answers[index()]?.length ?? 0) > 0
                }
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      isActive()
                        ? theme.accent
                        : tabHover() === index()
                          ? theme.backgroundElement
                          : theme.backgroundPanel
                    }
                    onMouseOver={() => setTabHover(index())}
                    onMouseOut={() => setTabHover(null)}
                    onMouseUp={() => {
                      if (renderer.getSelection()?.getSelectedText()) return
                      selectTab(index())
                    }}
                  >
                    <text
                      fg={
                        isActive()
                          ? selectedForeground(theme, theme.accent)
                          : isAnswered()
                            ? theme.text
                            : theme.textMuted
                      }
                    >
                      {q.header}
                    </text>
                  </box>
                )
              }}
            </For>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                confirm() ? theme.accent : tabHover() === "confirm" ? theme.backgroundElement : theme.backgroundPanel
              }
              onMouseOver={() => setTabHover("confirm")}
              onMouseOut={() => setTabHover(null)}
              onMouseUp={() => {
                if (renderer.getSelection()?.getSelectedText()) return
                selectTab(questions().length)
              }}
            >
              <text fg={confirm() ? selectedForeground(theme, theme.accent) : theme.textMuted}>Confirm</text>
            </box>
          </box>
        </Show>

        <Show when={!confirm()}>
          <box paddingLeft={1} gap={1}>
            <box>
              <text fg={theme.text}>
                {question()?.question}
                {multi() ? " (select all that apply)" : ""}
              </text>
            </box>
            <box>
              <For each={options()}>
                {(opt, i) => {
                  const active = () => i() === store.selected
                  const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                  return (
                    <box
                      onMouseOver={() => moveTo(i())}
                      onMouseDown={() => moveTo(i())}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        selectOption()
                      }}
                    >
                      <box flexDirection="row">
                        <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                          <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                            {`${i() + 1}.`}
                          </text>
                        </box>
                        <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                          <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                            {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                          </text>
                        </box>
                        <Show when={!multi()}>
                          <text fg={theme.success}>{picked() ? " ✓" : ""}</text>
                        </Show>
                      </box>

                      <box paddingLeft={3}>
                        <text fg={theme.textMuted}>{opt.description}</text>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={custom()}>
                <box
                  onMouseOver={() => moveTo(options().length)}
                  onMouseDown={() => moveTo(options().length)}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    selectOption()
                  }}
                >
                  <box flexDirection="row">
                    <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                      <text fg={other() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                        {`${options().length + 1}.`}
                      </text>
                    </box>
                    <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                      <text fg={other() ? theme.secondary : customPicked() ? theme.success : theme.text}>
                        {multi() ? `[${customPicked() ? "✓" : " "}] Type your own answer` : "Type your own answer"}
                      </text>
                    </box>

                    <Show when={!multi()}>
                      <text fg={theme.success}>{customPicked() ? " ✓" : ""}</text>
                    </Show>
                  </box>
                  <Show when={store.editing}>
                    <box paddingLeft={3}>
                      <textarea
                        ref={(val: TextareaRenderable) => {
                          textarea = val
                          setEditTarget(val)
                          val.traits = { status: "ANSWER" }
                          queueMicrotask(() => {
                            val.focus()
                            val.gotoLineEnd()
                            // Сброс обязателен: textarea пересоздаётся при каждом
                            // повторном входе в editing, и «залипший» restore
                            // перезатёр бы новый ввод.
                            if (pendingRestore !== undefined) {
                              val.setText(pendingRestore)
                              pendingRestore = undefined
                            }
                          })
                        }}
                        initialValue={input()}
                        placeholder="Type your own answer"
                        placeholderColor={theme.textMuted}
                        minHeight={1}
                        maxHeight={6}
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        cursorColor={theme.primary}
                        cursorStyle={tuiConfig.cursor}
                      />
                    </box>
                  </Show>
                  <Show when={!store.editing && input()}>
                    <box paddingLeft={3}>
                      <text fg={theme.textMuted}>{input()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </Show>

        <Show when={confirm() && !single()}>
          <box paddingLeft={1}>
            <text fg={theme.text}>Review</text>
          </box>
          <For each={questions()}>
            {(q, index) => {
              const value = () => store.answers[index()]?.join(", ") ?? ""
              const answered = () => Boolean(value())
              return (
                <box paddingLeft={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{q.header}:</span>{" "}
                    <span style={{ fg: answered() ? theme.text : theme.error }}>
                      {answered() ? value() : "(not answered)"}
                    </span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2}>
          <Show when={!single()}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>tab</span>
            </text>
          </Show>
          <Show when={!confirm()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
          </Show>
          <text fg={theme.text}>
            enter{" "}
            <span style={{ fg: theme.textMuted }}>
              {confirm() ? "submit" : multi() ? "toggle" : single() ? "submit" : "confirm"}
            </span>
          </text>

          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>dismiss</span>
          </text>
        </box>
        </box>
      </box>
    </Show>
  )
}
