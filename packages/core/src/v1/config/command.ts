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
  // Приватный канал реестра agent-models: рукописные значения вычищаются
  // strip-проходом в config.ts до decode, поэтому сюда попадает только
  // значение, инъецированное реестром.
  reasoningEffort: Schema.optional(Schema.String),
  merge: Schema.optional(ConfigMergeV1.Strategy).annotate({
    description:
      "How to compose this definition with a same-named global one: append (default), prepend, or replace",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
