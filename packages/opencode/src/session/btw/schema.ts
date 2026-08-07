import { Schema } from "effect"

// Эфемерные чанки стрима /btw. Сериализуются в JSON и отправляются как SSE-кадры
// на TUI. Намеренно простые типы — TUI рендерит по `type`.
export const BtwPart = Schema.Union([
  Schema.Struct({
    type: Schema.tag("ready"),
    btwID: Schema.String,
    parentID: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("user"),
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("text-delta"),
    messageID: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("reasoning-delta"),
    messageID: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("text-end"),
    messageID: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("tool"),
    messageID: Schema.String,
    callID: Schema.String,
    tool: Schema.String,
    state: Schema.Literals(["running", "completed", "error"]),
    title: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.tag("assistant-end"),
    messageID: Schema.String,
    finish: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.tag("turn-end") }),
  Schema.Struct({
    type: Schema.tag("error"),
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("warning"),
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("closed") }),
]).annotate({ identifier: "BtwPart" })
export type BtwPart = Schema.Schema.Type<typeof BtwPart>

// Сигнал завершения стрима events — не уходит в очередь как BtwPart.
export const BtwEnd = Schema.Struct({ type: Schema.tag("end") })
export type BtwEnd = Schema.Schema.Type<typeof BtwEnd>
