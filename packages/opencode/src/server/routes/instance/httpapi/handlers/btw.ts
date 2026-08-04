import { Cause, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"

import { Btw, type BtwPart } from "@/session/btw"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

function partToSse(part: BtwPart): Sse.Event {
  return { _tag: "Event", event: "message", id: undefined, data: JSON.stringify(part) }
}

export const btwHandlers = HttpApiBuilder.group(InstanceHttpApi, "btw", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "open",
        (ctx) =>
          Btw.open({ parentID: ctx.payload.parentID }).pipe(
            // Доменные ошибки → API-контракт. Неожидаемые сбои уже стали
            // defect-ами через orDie внутри Btw.open и уходят в errorLayer (500).
            Effect.mapError((error) =>
              error instanceof Btw.ParentNoModelError
                ? new InvalidRequestError({ message: error.message })
                : new SessionNotFoundError({ sessionID: ctx.payload.parentID, message: error.message }),
            ),
          ),
      )
      .handle("close", (ctx) => Btw.close({ btwID: ctx.payload.btwID }))
      .handle("abort", (ctx) => Btw.abort({ btwID: ctx.payload.btwID }))
      .handleRaw(
        "send",
        Effect.fn("BtwHttpApi.send")(function* () {
          const parsed = (yield* HttpServerRequest.ParsedSearchParams) as Record<string, unknown>
          const btwID = parsed["btwID"]
          const text = parsed["text"]
          if (typeof btwID !== "string" || typeof text !== "string") {
            return HttpServerResponse.empty({ status: 400 })
          }
          // Очередь живёт в scope запроса; runSend форкается в том же scope и
          // наследует сервисы из рантайма хендлера. Stream.fromQueue имеет
          // R = never, что удовлетворяет HttpServerResponse.stream. Очередь
          // типизирована Cause.Done, чтобы Btw.runSend мог закрыть её через
          // Queue.end (нормальный drain + EOF), а не Queue.shutdown (теряющий
          // буферизованные кадры).
          const queue = yield* Queue.unbounded<BtwPart, Cause.Done>()
          yield* Btw.runSend({ btwID, text, queue }).pipe(Effect.forkScoped)
          return HttpServerResponse.stream(
            Stream.fromQueue(queue).pipe(
              Stream.map(partToSse),
              Stream.pipeThroughChannel(Sse.encode()),
              Stream.encodeText,
            ),
            {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
  }),
)
