/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Show, onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory as sdkDirectory, json, type FetchHandler } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
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

async function mountPanel(input: { root: string; override: FetchHandler }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const events = createEventSource()
  const calls = createFetch(input.override, events)

  const [
    { BtwProvider, useBtw },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { SDKProvider },
  ] = await Promise.all([
    import("../../../src/context/btw"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/keymap"),
    import("../../../src/context/sdk"),
  ])

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
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state, worktree: input.root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" directory={sdkDirectory} fetch={calls.fetch} events={events.source}>
                  <BtwProvider>
                    <Inner />
                  </BtwProvider>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
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
  await using tmp = await tmpdir()
  let sendRequested = false
  let sse: SseControl | undefined
  const override: FetchHandler = (url) => {
    if (url.pathname === "/btw/open") return json({ btwID: "btw_main_1" })
    if (url.pathname === "/btw/send") {
      sendRequested = true
      sse = sseResponse()
      return sse.response
    }
    if (url.pathname === "/btw/close" || url.pathname === "/btw/abort") return json({ ok: true })
    return undefined
  }

  const panel = await mountPanel({ root: tmp.path, override })
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
  await using tmp = await tmpdir()
  let resolveOpen!: (response: Response) => void
  const openResponse = new Promise<Response>((resolve) => {
    resolveOpen = resolve
  })
  const closed: string[] = []
  const paths: string[] = []
  const override: FetchHandler = async (url, request) => {
    paths.push(url.pathname)
    if (url.pathname === "/btw/open") return openResponse
    if (url.pathname === "/btw/close") {
      // btwID у POST /btw/close лежит в JSON-теле, не в query.
      const body = request ? ((await request.json()) as { btwID?: string }) : {}
      closed.push(body.btwID ?? "")
      return json({ ok: true })
    }
    return undefined
  }

  const panel = await mountPanel({ root: tmp.path, override })
  // Ждём запрос open: он «висит в сети» (ответ не разрешён), панель жива.
  await waitAsync(() => paths.includes("/btw/open"))
  // Пользователь закрывает панель (btw.close() команды session.btw.close):
  // размонтирование до разрешения open — onCleanup ещё не знает btwID.
  panel.btw().close()
  resolveOpen(json({ btwID: "btw_late_1" }))
  await waitAsync(() => closed.includes("btw_late_1"))
  expect(closed).toEqual(["btw_late_1"])
  panel.cleanup()
})
