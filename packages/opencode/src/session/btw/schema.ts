import { Schema } from "effect"

// Эфемерные чанки стрима /btw. Сериализуются в JSON и отправляются как SSE-кадры
// на TUI. Намеренно простые типы — TUI рендерит по `type`.
// Каждый кадр (кроме ready) несёт btwID: панель отбрасывает кадры чужой беседы,
// поэтому два разговора (основной и побочный) не могут смешаться на клиенте.
export const BtwPart = Schema.Union([
  Schema.Struct({
    type: Schema.tag("ready"),
    btwID: Schema.String,
    parentID: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("user"),
    btwID: Schema.String,
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("text-delta"),
    btwID: Schema.String,
    messageID: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("reasoning-delta"),
    btwID: Schema.String,
    messageID: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("text-end"),
    btwID: Schema.String,
    messageID: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("tool"),
    btwID: Schema.String,
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
    btwID: Schema.String,
    messageID: Schema.String,
    finish: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.tag("turn-end"),
    btwID: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("error"),
    btwID: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("warning"),
    btwID: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("closed"),
    btwID: Schema.String,
  }),
]).annotate({ identifier: "BtwPart" })
export type BtwPart = Schema.Schema.Type<typeof BtwPart>

// Сигнал завершения стрима events — не уходит в очередь как BtwPart.
export const BtwEnd = Schema.Struct({ type: Schema.tag("end") })
export type BtwEnd = Schema.Schema.Type<typeof BtwEnd>
