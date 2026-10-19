export * as Btw from "./btw.js"

import { Schema } from "effect"

// Эфемерные чанки стрима побочного чата (btw). Сериализуются в JSON и уходят
// клиенту как SSE-кадры эндпоинта btw.send. Намеренно простые типы — панель
// рендерит по `type`. Каждый кадр (кроме ready) несёт btwID: панель отбрасывает
// кадры чужой беседы, поэтому два разговора (основной и побочный) не могут
// смешаться на клиенте.
export const Part = Schema.Union([
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
export type Part = Schema.Schema.Type<typeof Part>

// Сигнал завершения стрима — не уходит в очередь как кадр Btw.Part.
export const End = Schema.Struct({ type: Schema.tag("end") }).annotate({ identifier: "BtwEnd" })
export type End = Schema.Schema.Type<typeof End>
