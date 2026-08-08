export * as ConfigReloadEvent from "./config-reload-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const Pending = Event.define({
  type: "config.reload.pending",
  schema: {
    pending: Schema.Boolean,
  },
})

export const Executing = Event.define({
  type: "config.reload.executing",
  schema: {
    executing: Schema.Boolean,
    bootstrapCycle: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  },
})

export const Done = Event.define({
  type: "config.reload.done",
  schema: {},
})

export const Definitions = Event.inventory(Pending, Executing, Done)
