/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Show, onMount } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createEventStream, createFetch, json, type FetchHandler } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { emptyThemeSource } from "../../fixture/fixture"
import { ThemeProvider } from "../../../src/context/theme"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ClientProvider } from "../../../src/context/client"
import { BtwProvider, useBtw } from "../../../src/context/btw"
import { BtwPanel } from "../../../src/routes/session/panel-btw"

// Изоляция btw-панели от основной панели (клиентская сторона):
//  1. единственный вход контента в btw — её собственный SSE-поток; кадры чужой
//     беседы (чужой btwID — например, «ответ основной панели», ошибочно
//     доставленный не в свой поток) панель обязана отбрасывать целиком;
//  2. размонтирование панели до ответа /btw/open закрывает серверную беседу —
//     «поздний» open не оставляет висящую беседу.

const parentID = "ses_btw_parent"

async function waitAsync(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type SseControl = {
  response: Response
  push: (frame: unknown) => void
  end: () => void
}

function sseResponse(): SseControl {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    push(frame) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
    },
    end() {
      controller.close()
    },
  }
}

// Собирает весь текст из дерева рендера — для проверок «что видно в панели».
function collectText(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out
  const renderable = node as { content?: unknown; getChildren?: () => unknown[] }
  const content = renderable.content
  if (typeof content === "string") out.push(content)
  else if (content && typeof (content as { toString?: unknown }).toString === "function") {
    const text = (content as { toString: () => string }).toString()
    if (text && text !== "[object Object]") out.push(text)
  }
  for (const child of renderable.getChildren?.() ?? []) collectText(child, out)
  return out
}

async function mountPanel(input: { override: FetchHandler }) {
  const transport = createFetch(input.override, createEventStream())

  let btwApi: ReturnType<typeof useBtw> | undefined

  function Inner() {
    const btw = useBtw()
    onMount(() => {
      btwApi = btw
      // Тот же переход, что даёт команда /btw в приложении: open монтирует
      // панель рядом с основным разговором.
      btw.open(parentID)
    })
    return (
      <Show when={btw.state()}>
        {(state) => <BtwPanel parentID={state().parentID} width={40} />}
      </Show>
    )
  }
  function Harness() {
    return (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ClientProvider api={createApi(transport.fetch)}>
                <BtwProvider>
                  <Inner />
                </BtwProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })

  return {
    app,
    // Контекст btw (тот же, что у команды cycle/close в приложении).
    btw: () => {
      if (!btwApi) throw new Error("btw context not ready")
      return btwApi
    },
    cleanup() {
      app.renderer.destroy()
    },
  }
}

test("btw panel drops frames of a foreign conversation and keeps its own", async () => {
  let sendRequested = false
  let sse: SseControl | undefined
  const override: FetchHandler = (url) => {
    if (url.pathname === "/api/btw/open") return json({ btwID: "btw_main_1" })
    if (url.pathname === "/api/btw/send") {
      sendRequested = true
      sse = sseResponse()
      return sse.response
    }
    if (url.pathname === "/api/btw/close" || url.pathname === "/api/btw/abort") return json({ ok: true })
    return undefined
  }

  const panel = await mountPanel({ override })
  try {
    // Панель смонтировалась, открылась и отдала фокус полю ввода.
    await waitAsync(() => panel.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = panel.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused btw textarea")

    textarea.setText("side question")
    panel.app.mockInput.pressEnter()
    await waitAsync(() => sendRequested)

    const own = { btwID: "btw_main_1" }
    const stranger = { btwID: "btw_stranger" }
    sse!.push({ type: "user", ...own, id: "u1", text: "side question" })
    // Кадр чужой беседы (в реальности — ошибочно доставленный чужой ответ)
    // обязан быть съеден: панель не должна показать ни одного его символа.
    sse!.push({ type: "text-delta", ...stranger, messageID: "msg_main", delta: "FOREIGN LEAK " })
    sse!.push({ type: "text-delta", ...own, messageID: "msg_btw", delta: "BTW ANSWER TEXT" })
    sse!.push({ type: "turn-end", ...own })
    sse!.end()

    await waitAsync(() => collectText(panel.app.renderer.root).join("").includes("BTW ANSWER TEXT"))
    const rendered = collectText(panel.app.renderer.root).join("")
    expect(rendered).not.toContain("FOREIGN LEAK")
    expect(rendered).toContain("BTW ANSWER TEXT")
  } finally {
    panel.cleanup()
  }
})

test("panel unmounted before open resolves closes the late server conversation", async () => {
  let resolveOpen!: (response: Response) => void
  const openResponse = new Promise<Response>((resolve) => {
    resolveOpen = resolve
  })
  const closed: string[] = []
  const paths: string[] = []
  const override: FetchHandler = async (url, request) => {
    paths.push(url.pathname)
    if (url.pathname === "/api/btw/open") return openResponse
    if (url.pathname === "/api/btw/close") {
      // btwID у POST /api/btw/close лежит в JSON-теле, не в query.
      const body = request ? ((await request.json()) as { btwID?: string }) : {}
      closed.push(body.btwID ?? "")
      return json({ ok: true })
    }
    return undefined
  }

  const panel = await mountPanel({ override })
  // Ждём запрос open: он «висит в сети» (ответ не разрешён), панель жива.
  await waitAsync(() => paths.includes("/api/btw/open"))
  // Пользователь закрывает панель (btw.close() команды session.btw.close):
  // размонтирование до разрешения open — onCleanup ещё не знает btwID.
  panel.btw().close()
  resolveOpen(json({ btwID: "btw_late_1" }))
  await waitAsync(() => closed.includes("btw_late_1"))
  expect(closed).toEqual(["btw_late_1"])
  panel.cleanup()
})
