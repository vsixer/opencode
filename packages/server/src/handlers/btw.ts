import { Instance } from "@opencode/core/instance/service"
import { Session } from "@opencode/core/session"
import { SessionBtw } from "@opencode/core/session/btw"
import { Btw } from "@opencode/schema/btw"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Cause, Effect, Queue, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { locationErrors, sessionInfo } from "../location"

function frameToSse(part: Btw.Part): string {
  return `data: ${JSON.stringify(part)}\n\n`
}

export const BtwHandler = HttpApiBuilder.group(Api, "server.btw", (handlers) =>
  Effect.gen(function* () {
    const instances = yield* Instance.Service
    const sessions = yield* Session.Service
    return handlers
      .handle(
        "btw.open",
        Effect.fn("server.btw.open")(function* (request) {
          const parent = yield* sessionInfo(sessions, request.payload.parentID)
          // Родительская сессия не дала модель/агента → 400 с доменным
          // сообщением; остальные доменные сбои остаются типизированными.
          return yield* SessionBtw.open({ parent }).pipe(
            instances.provide(parent),
            Effect.catchTag("Btw.SelectionError", (error) =>
              Effect.fail(new InvalidRequestError({ message: error.message })),
            ),
            locationErrors,
          )
        }),
      )
      .handle("btw.close", (request) => SessionBtw.close({ btwID: request.payload.btwID }))
      .handle("btw.abort", (request) => SessionBtw.abort({ btwID: request.payload.btwID }))
      .handleRaw(
        "btw.send",
        Effect.fn("server.btw.send")(function* () {
          const params = (yield* HttpServerRequest.ParsedSearchParams) as Record<string, unknown>
          const btwID = params["btwID"]
          const text = params["text"]
          if (typeof btwID !== "string" || typeof text !== "string" || text.length === 0) {
            return yield* new InvalidRequestError({
              message: "btw: btwID and text query parameters are required",
              field: "btwID",
            })
          }
          // Очередь живёт в scope запроса; send форкается в том же scope и
          // наследует сервисы из рантайма хендлера. Очередь типизирована
          // Cause.Done, чтобы SessionBtw.runSend закрыл её через Queue.end —
          // нормальный drain + EOF, без interrupt-обрыва клиента.
          const queue = yield* Queue.unbounded<Btw.Part, Cause.Done>()
          yield* SessionBtw.runSend({ btwID, text, queue, instances }).pipe(Effect.forkScoped)
          return HttpServerResponse.stream(Stream.map(Stream.fromQueue(queue), frameToSse).pipe(Stream.encodeText), {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          })
        }),
      )
  }),
)
