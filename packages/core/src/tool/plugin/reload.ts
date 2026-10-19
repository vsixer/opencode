export * as ReloadTool from "./reload.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { ReloadService } from "../reload-service.js"

export const name = "reload_config"

export const description = "Reload OpenCode configuration files and plugins without restarting."

export const Input = Schema.Struct({})

export const Plugin = {
  id: "opencode.tool.reload_config",
  effect: Effect.fn("ReloadTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const reload = yield* ReloadService.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          execute: (_input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: "Permission denied: reload_config", error }),
                  ),
                )
              // Invalidation only detaches cached Location graphs; in-flight borrowers (this
              // tool included) keep running on the old graph, so the result below is delivered.
              yield* reload.reload().pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Configuration reload failed", error })),
              )
              return {
                content: "Configuration reloaded.",
                stopAfterToolResult: true,
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
