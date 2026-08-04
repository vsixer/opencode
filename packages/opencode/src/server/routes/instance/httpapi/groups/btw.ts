import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { InvalidRequestError, SessionNotFoundError } from "../errors"

const OpenPayload = Schema.Struct({ parentID: SessionID })
const OpenResponse = Schema.Struct({ btwID: Schema.String })
const ClosePayload = Schema.Struct({ btwID: Schema.String })
const AbortPayload = Schema.Struct({ btwID: Schema.String })
const OkResponse = Schema.Struct({ ok: Schema.Boolean })
// btwID/text едут в query, т.к. стримящий эндпоинт обязан быть GET (legacy-SDK
// генерирует SSE-методы только как sse.get).
const SendQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, btwID: Schema.String, text: Schema.String })

export const BtwApi = HttpApi.make("btw").add(
  HttpApiGroup.make("btw")
    .add(
      HttpApiEndpoint.post("open", "/btw/open", {
        query: WorkspaceRoutingQuery,
        payload: OpenPayload,
        success: described(OpenResponse, "btw session opened"),
        error: [SessionNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "btw.open",
          summary: "Open ephemeral btw chat",
          description: "Open an ephemeral side-chat frozen on the current parent session context.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("send", "/btw/send", {
        query: SendQuery,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "btw.send",
          summary: "Send a message to btw chat",
          description: "Send a follow-up message; response is an SSE stream of BtwPart chunks.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("close", "/btw/close", {
        query: WorkspaceRoutingQuery,
        payload: ClosePayload,
        success: described(OkResponse, "btw session closed"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "btw.close",
          summary: "Close btw chat",
          description: "Close the ephemeral side-chat and drop its in-memory state.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("abort", "/btw/abort", {
        query: WorkspaceRoutingQuery,
        payload: AbortPayload,
        success: described(OkResponse, "btw turn aborted"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "btw.abort",
          summary: "Abort active btw turn",
          description: "Abort the in-flight turn of an ephemeral side-chat without closing it.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "btw", description: "Ephemeral side-chat over the active session." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
