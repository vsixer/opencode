import { Btw } from "@opencode/schema/btw"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, LocationNotFoundError, ServiceUnavailableError, SessionNotFoundError } from "../errors.js"

// Контракт побочного чата (btw): эфемерный стрим поверх активной сессии.
// Поля запросов/ответов и формат кадров BtwPart сохранены от прежнего SDK,
// чтобы перегенерированный клиент продолжил отвечать методам
// client.btw.open/send/close/abort.
export const BtwGroup = HttpApiGroup.make("server.btw")
  .add(
    HttpApiEndpoint.post("btw.open", "/api/btw/open", {
      payload: Schema.Struct({ parentID: Session.ID }),
      success: Schema.Struct({ btwID: Schema.String }).annotate({ identifier: "BtwOpenResponse" }),
      error: [InvalidRequestError, SessionNotFoundError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "btw.open",
        summary: "Open ephemeral btw chat",
        description: "Open an ephemeral side-chat frozen on the current parent session context.",
      }),
    ),
  )
  .add(
    // Стримящий эндпоинт обязан быть GET: клиент генерирует SSE-методы только
    // как get-запросы; btwID/text едут в query.
    HttpApiEndpoint.get("btw.send", "/api/btw/send", {
      query: Schema.Struct({ btwID: Schema.String, text: Schema.String }),
      success: HttpApiSchema.StreamSse({ data: Btw.Part }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "btw.send",
        summary: "Send a message to btw chat",
        description: "Send a follow-up message; response is an SSE stream of BtwPart chunks.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("btw.close", "/api/btw/close", {
      payload: Schema.Struct({ btwID: Schema.String }),
      success: Schema.Struct({ ok: Schema.Boolean }).annotate({ identifier: "BtwCloseResponse" }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "btw.close",
        summary: "Close btw chat",
        description: "Close the ephemeral side-chat and drop its in-memory state.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("btw.abort", "/api/btw/abort", {
      payload: Schema.Struct({ btwID: Schema.String }),
      success: Schema.Struct({ ok: Schema.Boolean }).annotate({ identifier: "BtwAbortResponse" }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "btw.abort",
        summary: "Abort active btw turn",
        description: "Abort the in-flight turn of an ephemeral side-chat without closing it.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "btw", description: "Ephemeral side-chat over the active session." }))
