import { TextareaRenderable, TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Show, createEffect, createSignal, For, onCleanup, onMount } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useBtw, type BtwRef } from "../../context/btw"
import { Spinner } from "../../component/spinner"
import { getScrollAcceleration } from "../../util/scroll"
import { SplitBorder } from "../../ui/border"
import { useBindings, useCommandShortcut } from "../../keymap"
import { useTuiConfig } from "../../config"

// Форма чанков стрима /btw (серверная схема BtwPart, см. session/btw/schema.ts).
type BtwChunk =
  | { type: "ready"; btwID: string; parentID: string }
  | { type: "user"; id: string; text: string }
  | { type: "text-delta"; messageID: string; delta: string }
  | { type: "reasoning-delta"; messageID: string; delta: string }
  | { type: "text-end"; messageID: string }
  | {
      type: "tool"
      messageID: string
      callID: string
      tool: string
      state: "running" | "completed" | "error"
      title?: string
      output?: string
      error?: string
    }
  | { type: "assistant-end"; messageID: string; finish?: string }
  | { type: "turn-end" }
  | { type: "error"; message: string }
  | { type: "warning"; message: string }
  | { type: "closed" }

type ToolEntry = {
  callID: string
  tool: string
  state: "running" | "completed" | "error"
  title?: string
  output?: string
  error?: string
}
type BtwMessage =
  | { role: "user"; id: string; text: string }
  | { role: "assistant"; id: string; text: string; reasoning: string; tools: ToolEntry[] }

export function BtwPanel(props: { parentID: string; width: number }) {
  const sdk = useSDK()
  const btw = useBtw()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const closeShortcut = useCommandShortcut("session.btw.close")

  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable
  let scroll: ScrollBoxRenderable
  const scrollAcceleration = getScrollAcceleration()
  const [gen, setGen] = createSignal(1)
  const [messages, setMessages] = createSignal<BtwMessage[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [btwID, setBtwID] = createSignal<string | undefined>()
  // Развёрнутые thinking-блоки (по id ассистент-сообщения). По умолчанию каждый
  // thinking свёрнут в однострочный маркер — клик по маркеру разворачивает текст.
  const [expandedThinking, setExpandedThinking] = createSignal<Set<string>>(new Set<string>())
  // Секундомер идущего тура: виден в шапке как индикатор выполнения запроса.
  const [elapsed, setElapsed] = createSignal(0)
  const abort = new AbortController()
  // AbortController активного хода, поднят до component-scope: зеркальный
  // interrupt-key и onCleanup дёргают его для мгновенного локального обрыва fetch.
  let turnAbort: AbortController | null = null
  // Флаг намеренного abort хода: подавляет шумный AbortError из локально
  // прерванного fetch, оставляя чистый «btw: aborted».
  let userAborted = false

  onMount(async () => {
    try {
      const res = await sdk.client.btw.open({ parentID: props.parentID }, { throwOnError: true })
      setBtwID(res.data!.btwID)
    } catch (e) {
      setError("btw: failed to open — " + errMessage(e))
    }
  })

  onCleanup(() => {
    abort.abort()
    turnAbort?.abort()
    btw.setRef(undefined)
    const id = btwID()
    if (id) sdk.client.btw.close({ btwID: id }).catch(() => {})
  })

  // Регистрируем ref поля ввода, чтобы команда cycle могла переключать фокус.
  const ref: BtwRef = {
    focused: () => !!textarea && !textarea.isDestroyed && textarea.focused,
    focus: () => {
      if (textarea && !textarea.isDestroyed) textarea.focus()
    },
    blur: () => {
      if (textarea && !textarea.isDestroyed) textarea.blur()
    },
  }
  onMount(() => btw.setRef(ref))

  // Прерывание хода висит на той же клавише, что и session.interrupt в конфиге
  // пользователя (уважает ремап из tui.jsonc). Биндинг вооружён, пока идёт тур.
  // fallthrough:true гарантирует, что когда btw не в фокусе, ключ проходит далее
  // к session.interrupt основной сессии — две панели не глушат друг друга.
  // Срабатывает только когда поле btw в фокусе (иначе cmd — no-op).
  // Двухканальный обрыв: локальный AbortController рвёт fetch немедленно,
  // серверный /btw/abort надёжен при half-open SSE.
  const interruptBindings = tuiConfig.keybinds.get("session.interrupt")
  useBindings(() => ({
    enabled: busy(),
    bindings: interruptBindings.map((b) => ({
      ...b,
      cmd: () => {
        if (renderer.currentFocusedEditor === textarea) void abortTurn()
      },
      fallthrough: true,
      desc: "Abort btw turn",
      group: "BTW",
    })),
  }))

  async function abortTurn() {
    const id = btwID()
    userAborted = true
    turnAbort?.abort()
    if (id) {
      try {
        await sdk.client.btw.abort({ btwID: id })
      } catch {
        // не критично: локальный abort уже снял busy через EOF
      }
    }
  }

  function appendAssistant(): string {
    const id = "a" + Date.now() + Math.random().toString(36).slice(2, 6)
    setMessages((m) => [...m, { role: "assistant", id, text: "", reasoning: "", tools: [] }])
    return id
  }

  function patchAssistant(
    id: string,
    fn: (msg: { text: string; reasoning: string; tools: ToolEntry[] }) => {
      text: string
      reasoning: string
      tools: ToolEntry[]
    },
  ) {
    setMessages((m) =>
      m.map((msg) =>
        msg.role === "assistant" && msg.id === id
          ? { ...msg, ...fn({ text: msg.text, reasoning: msg.reasoning, tools: msg.tools }) }
          : msg,
      ),
    )
  }

  function handlePart(part: BtwChunk, assistantId: string) {
    switch (part.type) {
      case "reasoning-delta":
        patchAssistant(assistantId, (s) => ({ text: s.text, reasoning: s.reasoning + part.delta, tools: s.tools }))
        break
      case "text-delta":
        patchAssistant(assistantId, (s) => ({ text: s.text + part.delta, reasoning: s.reasoning, tools: s.tools }))
        break
      case "tool":
        patchAssistant(assistantId, (s) => {
          const entry: ToolEntry = {
            callID: part.callID,
            tool: part.tool,
            state: part.state,
            title: part.title,
            output: part.output,
            error: part.error,
          }
          const idx = s.tools.findIndex((t) => t.callID === entry.callID)
          const tools = [...s.tools]
          if (idx >= 0) tools[idx] = entry
          else tools.push(entry)
          return { text: s.text, reasoning: s.reasoning, tools }
        })
        break
      case "error":
        setError(part.message)
        break
      case "warning":
        // поверхностно игнорируем; при желании можно показать
        break
    }
  }

  async function send(text: string) {
    const id = btwID()
    if (!id || !text.trim() || busy()) return
    setBusy(true)
    setError(undefined)
    userAborted = false
    setMessages((m) => [...m, { role: "user", id: "u" + Date.now(), text }])
    const assistantId = appendAssistant()
    // Per-turn abort (component-scope): связывает panel-level abort, hard-timeout
    // и inactivity-timeout.
    turnAbort = new AbortController()
    const onPanelAbort = () => turnAbort?.abort()
    abort.signal.addEventListener("abort", onPanelAbort)
    let hardTimedOut = false
    let inactiveTimedOut = false
    // Hard-stop: полностью глухое зависание (дохлый транспорт без терминала и EOF).
    const hardTimer = setTimeout(() => {
      hardTimedOut = true
      turnAbort?.abort()
    }, 60_000)
    // Inactivity: нет чанков 30s → транспорт полудохлый. Сбрасывается на каждом партe.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      inactiveTimedOut = true
      turnAbort?.abort()
    }, 30_000)
    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        inactiveTimedOut = true
        turnAbort?.abort()
      }, 30_000)
    }
    try {
      const resp = await sdk.client.btw.send({ btwID: id, text }, { signal: turnAbort.signal, sseMaxRetryAttempts: 0 })
      for await (const raw of resp.stream) {
        if (turnAbort?.signal.aborted) break
        resetInactivity()
        const part = raw as unknown as BtwChunk
        handlePart(part, assistantId)
        if (part.type === "turn-end" || part.type === "error" || part.type === "closed") break
      }
    } catch (e) {
      if (hardTimedOut) setError("btw: timed out (no response in 60s)")
      else if (inactiveTimedOut) setError("btw: stalled (no data in 30s)")
      else if (userAborted) {
        if (!error()) setError("btw: aborted")
      } else if (!abort.signal.aborted) setError(errMessage(e))
    } finally {
      clearTimeout(hardTimer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      abort.signal.removeEventListener("abort", onPanelAbort)
      turnAbort = null
      setBusy(false)
    }
  }

  function confirm() {
    if (busy() || !btwID()) return
    const text = textarea?.plainText ?? ""
    if (!text.trim()) return
    setGen((g) => g + 1) // ремонт textarea → поле очищено
    void send(text)
  }

  function toggleThinking(id: string) {
    setExpandedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Секундомер тура: тикает раз в секунду, пока busy. onCleanup внутри эффекта
  // чистит интервал при остановке/размонтировании.
  createEffect(() => {
    if (!busy()) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // Фокус на поле — на mount/remount (gen). Пока панель открыта, основной промпт
  // уступает фокус (yieldFocus), поэтому здесь автофокус не вступает в гонку.
  createEffect(() => {
    const target = textareaTarget()
    if (!target || target.isDestroyed) return
    target.focus()
  })

  // stickyScroll: при появлении нового сообщения прыгаем в самый низ.
  let lastMessageCount = 0
  createEffect(() => {
    const count = messages().length
    const grew = count > lastMessageCount
    lastMessageCount = count
    if (!grew) return
    const s = scroll
    setTimeout(() => {
      if (s && !s.isDestroyed) s.scrollTo(s.scrollHeight)
    }, 0)
  })

  return (
    <box
      width={props.width}
      flexShrink={0}
      flexDirection="column"
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.border}
    >
      <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            btw — side chat
          </text>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Show when={busy()}>
              <text fg={theme.primary}>⟳ {elapsed()}s</text>
            </Show>
            <text fg={theme.textMuted}>{closeShortcut()} close</text>
          </box>
        </box>

        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          flexGrow={1}
          minHeight={0}
          gap={1}
          stickyScroll={true}
          stickyStart="bottom"
          scrollAcceleration={scrollAcceleration}
          verticalScrollbarOptions={{
            paddingLeft: 1,
            trackOptions: {
              backgroundColor: theme.backgroundElement,
              foregroundColor: theme.border,
            },
          }}
        >
          <For each={messages()}>
            {(msg) => (
              <box flexDirection="column">
                <Show when={msg.role === "assistant" && (msg as { reasoning: string }).reasoning.length > 0}>
                  <text
                    fg={theme.textMuted}
                    onMouseUp={() => {
                      // Не переключаем, если пользователь выделял текст для копирования.
                      if (renderer.getSelection()?.getSelectedText()) return
                      toggleThinking(msg.id)
                    }}
                  >
                    {expandedThinking().has(msg.id) ? "▾ " : "▸ "}
                    thinking
                    {expandedThinking().has(msg.id)
                      ? ""
                      : ` (${(msg as { reasoning: string }).reasoning.length} chars)`}
                  </text>
                  <Show when={expandedThinking().has(msg.id)}>
                    <text fg={theme.textMuted}>{(msg as { reasoning: string }).reasoning}</text>
                  </Show>
                </Show>
                <text fg={msg.role === "user" ? theme.text : theme.text}>
                  {msg.role === "user" ? "you: " : "btw: "}
                  {msg.text}
                </text>
                <Show when={msg.role === "assistant" && msg.tools.length > 0}>
                  <For each={(msg as { tools: ToolEntry[] }).tools}>
                    {(t) => (
                      <text fg={theme.textMuted}>
                        {"  ["}
                        {t.state}
                        {"] "}
                        {t.tool}
                        {t.title ? ` — ${t.title}` : ""}
                        {t.error ? ` (error: ${t.error})` : ""}
                        {t.output ? `\n  ${t.output.slice(0, 300)}` : ""}
                      </text>
                    )}
                  </For>
                </Show>
              </box>
            )}
          </For>
          <Show when={error()}>
            {(e) => <text fg={theme.error}>{e()}</text>}
          </Show>
          <Show when={busy()}>
            <Spinner color={theme.textMuted}>
              thinking… {elapsed()}s
            </Spinner>
          </Show>
        </scrollbox>

        <Show when={gen()} keyed>
          <textarea
            height={3}
            flexShrink={0}
            placeholder="Ask a side question… (enter to send)"
            placeholderColor={theme.textMuted}
            textColor={busy() ? theme.textMuted : theme.text}
            focusedTextColor={busy() ? theme.textMuted : theme.text}
            cursorColor={busy() ? theme.backgroundElement : theme.text}
            onContentChange={() => {
              /* содержимое читается напрямую из textarea.plainText при submit */
            }}
            onSubmit={() => {
              // IME: двойной defer, как в основном prompt
              setTimeout(() => setTimeout(() => confirm(), 0), 0)
            }}
            ref={(val: TextareaRenderable) => {
              textarea = val
              setTextareaTarget(val)
            }}
          />
        </Show>
      </box>
    </box>
  )
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
