import { TextareaRenderable, TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Show, createEffect, createSignal, For, onCleanup, onMount } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { Spinner } from "../../component/spinner"
import { getScrollAcceleration } from "../../util/scroll"

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

export function DialogBtw(props: { parentID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()

  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable
  let scroll: ScrollBoxRenderable
  const scrollAcceleration = getScrollAcceleration()
  const [gen, setGen] = createSignal(1)
  const [messages, setMessages] = createSignal<BtwMessage[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [btwID, setBtwID] = createSignal<string | undefined>()
  // Подсказка под полем при одиночном esc (prime double-escape).
  const [escHint, setEscHint] = createSignal<string | undefined>()
  const abort = new AbortController()
  // AbortController активного хода, поднят до component-scope: double-esc-abort
  // и dialog onCleanup дёргают его для мгновенного локального обрыва fetch.
  let turnAbort: AbortController | null = null
  // Окно двойного escape (симметрично с double-esc interrupt в основной сессии).
  let lastEsc = 0
  const ESC_WINDOW = 500
  // Флаг намеренного abort хода (double-esc): подавляет шумный AbortError из
  // локально прерванного fetch, оставляя чистый «btw: aborted» (от сервера или fallback).
  let userAborted = false

  // Диалог рендерится во враппере с paddingTop = height/4 (см. ui/dialog.tsx),
  // поэтому доступная высота контента ≈ 3/4 терминала. Ограничиваем корневой box,
  // чтобы messages-scrollbox занял остаток и давал скролл вместо выхода за экран.
  const contentHeight = () => Math.max(8, dimensions().height - Math.floor(dimensions().height / 4) - 2)

  onMount(async () => {
    dialog.setSize("xlarge")
    dialog.setOnEscape(handleEscape)
    try {
      const res = await sdk.client.btw.open({ parentID: props.parentID }, { throwOnError: true })
      setBtwID(res.data!.btwID)
    } catch (e) {
      setError("btw: failed to open — " + errMessage(e))
    }
  })

  onCleanup(() => {
    dialog.setOnEscape(undefined)
    abort.abort()
    turnAbort?.abort()
    const id = btwID()
    if (id) sdk.client.btw.close({ btwID: id }).catch(() => {})
  })

  // Прервать активный ход: двухканальный обрыв. Локальный AbortController
  // рвёт fetch немедленно (=> server request-scope финализируется, runLoop
  // прерывается, ensuring делает Queue.end => клиент видит EOF). Дополнительно
  // дёргаем серверный /btw/abort — он надёжен при half-open SSE, где локальный
  // abort мог не дойти до сервера по зависшему соединению.
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

  // Собственный escape для btw (делегировано из generic dialog-handler):
  // 1) есть selection → снять, без prime;
  // 2) двойной esc в окне → busy? abort хода : закрыть модалку;
  // 3) одиночный esc → prime + хинт «esc again».
  function handleEscape() {
    if (renderer.getSelection()?.getSelectedText()) {
      renderer.clearSelection()
      lastEsc = 0
      setEscHint(undefined)
      return
    }
    const now = Date.now()
    if (now - lastEsc < ESC_WINDOW) {
      lastEsc = 0
      setEscHint(undefined)
      if (busy()) {
        void abortTurn()
      } else {
        dialog.clear()
      }
      return
    }
    lastEsc = now
    setEscHint(busy() ? "esc again to abort" : "esc again to close")
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
    setEscHint(undefined)
    userAborted = false
    setMessages((m) => [...m, { role: "user", id: "u" + Date.now(), text }])
    const assistantId = appendAssistant()
    // Per-turn abort (component-scope): связывает dialog-level abort, hard-timeout
    // и inactivity-timeout. double-esc-abort тоже дёргает его для мгновенного
    // локального обрыва fetch; серверный /btw/abort идёт параллельно для надёжности.
    turnAbort = new AbortController()
    const onDialogAbort = () => turnAbort?.abort()
    abort.signal.addEventListener("abort", onDialogAbort)
    let hardTimedOut = false
    let inactiveTimedOut = false
    // Hard-stop: полностью глухое зависание (дохлый транспорт без терминала и EOF).
    // 60s вместо прежних 150 — покрывает любой реальный тур и быстрее возвращает UI.
    const hardTimer = setTimeout(() => {
      hardTimedOut = true
      turnAbort?.abort()
    }, 60_000)
    // Inactivity: нет чанков 30s → транспорт полудохлый (сценарий бага: показал
    // thinking и замолчал). Сбрасывается на каждом полученном партe.
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
        // turn-end/error/closed — terminal-события: снимаем spinner сразу, не
        // ожидая EOF стрима (защита от зависшего транспорта без терминала).
        if (part.type === "turn-end" || part.type === "error" || part.type === "closed") break
      }
    } catch (e) {
      if (hardTimedOut) setError("btw: timed out (no response in 60s)")
      else if (inactiveTimedOut) setError("btw: stalled (no data in 30s)")
      else if (userAborted) {
        // Серверный /btw/abort мог уже прислать {error:"btw: aborted"} через стрим
        // (тогда error() уже стоит) — не перетираем. Иначе ставим дружелюбный fallback.
        if (!error()) setError("btw: aborted")
      } else if (!abort.signal.aborted) setError(errMessage(e))
    } finally {
      clearTimeout(hardTimer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      abort.signal.removeEventListener("abort", onDialogAbort)
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

  // Фокус на поле — на mount/remount (gen). НЕ снимаем фокус и НЕ вешаем suspend
  // во время хода: submit и так блокируется в confirm() по busy(). Раньше blur()
  // + suspend заставляли рендерер авто-фокусировать основной prompt, и поле btw
  // становилось недоступным «само по себе». Muted-стиль остаётся через ternary
  // на textColor/cursorColor ниже.
  createEffect(() => {
    const target = textareaTarget()
    if (!target || target.isDestroyed) return
    target.focus()
  })

  // При появлении нового сообщения прыгаем в самый низ. stickyScroll держит
  // низ только если пользователь уже там; если он прокрутил вверх для чтения,
  // новый обмен иначе остался бы за пределами видимой области.
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
    <box paddingLeft={2} paddingRight={2} gap={1} height={contentHeight()}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          btw — side chat
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          2× esc
        </text>
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
                <text fg={theme.textMuted}>
                  {"btw (thinking): "}
                  {(msg as { reasoning: string }).reasoning}
                </text>
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
          <Spinner color={theme.textMuted}>thinking…</Spinner>
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
      <Show when={escHint()}>
        {(h) => <text fg={theme.textMuted}>{h()}</text>}
      </Show>
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
