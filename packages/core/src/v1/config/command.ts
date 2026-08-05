export * as ConfigCommandV1 from "./command"

import { Schema } from "effect"
import { ConfigMergeV1 } from "./merge"

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  merge: Schema.optional(ConfigMergeV1.Strategy).annotate({
    description:
      "How to compose this definition with a same-named global one: append (default), prepend, or replace",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
