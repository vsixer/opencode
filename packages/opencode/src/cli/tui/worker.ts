import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { errorMessage } from "@/util/error"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

Heap.start()

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

// Активные SSE-потоки: id запроса → контроллер прерывания. fetchAbort рвёт
// запрос на стороне сервера (сигнал прокинут в Request).
const activeStreams = new Map<number, AbortController>()

export const rpc = {
  async fetch(input: { id: number; url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const controller = new AbortController()
    activeStreams.set(input.id, controller)
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
      signal: controller.signal,
    })
    const response = await Server.Default().app.fetch(request)
    const responseHeaders = Object.fromEntries(response.headers.entries())
    // SSE-ответы стримятся rpc-событиями (fetch.start/chunk/end): TUI получает
    // кадры по мере генерации ответа, а не всё тело разом. Прежнее поведение —
    // await response.text() — буферизовало весь стрим до его завершения, из-за
    // чего ответы btw рисовались одним куском в конце тура, а AbortSignal
    // клиента не доходил до сервера. Не-SSE ответы буферизуются как раньше.
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      activeStreams.delete(input.id)
      const body = await response.text()
      return { buffered: true as const, status: response.status, headers: responseHeaders, body }
    }
    void (async () => {
      try {
        Rpc.emit("fetch.start", { id: input.id, status: response.status, headers: responseHeaders })
        const decoder = new TextDecoder()
        if (response.body) {
          const reader = response.body.getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const text = decoder.decode(value, { stream: true })
              if (text) Rpc.emit("fetch.chunk", { id: input.id, text })
            }
            const tail = decoder.decode()
            if (tail) Rpc.emit("fetch.chunk", { id: input.id, text: tail })
          } finally {
            reader.releaseLock()
          }
        }
        Rpc.emit("fetch.end", { id: input.id })
      } catch (error) {
        Rpc.emit("fetch.error", { id: input.id, message: errorMessage(error) ?? "stream failed" })
      } finally {
        activeStreams.delete(input.id)
      }
    })()
    return { buffered: false as const, status: response.status, headers: responseHeaders }
  },
  async fetchAbort(input: { id: number }) {
    const controller = activeStreams.get(input.id)
    activeStreams.delete(input.id)
    controller?.abort()
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
