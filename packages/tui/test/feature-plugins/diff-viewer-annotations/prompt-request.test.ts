import { describe, expect, test } from "bun:test"
import { buildPromptRequest } from "../../../src/feature-plugins/system/diff-viewer-annotations/prompt-request"
import type { Message, Session } from "@opencode-ai/sdk/v2"

// UT-10 (FR-P1): разрешение agent/model/variant из сессии с фоллбэком на последнее
// user-сообщение; отсутствие идентификаторов → model опущен.
describe("prompt-request — buildPromptRequest (UT-10)", () => {
  test("session model wins", () => {
    const session = { model: { providerID: "anthropic", id: "claude", variant: "v2" }, agent: "build" } as unknown as Session
    const request = buildPromptRequest("s1", session, undefined, "текст")
    expect(request).toEqual({
      sessionID: "s1",
      agent: "build",
      variant: "v2",
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "text", text: "текст" }],
    })
  })

  test("falls back to the last user message model", () => {
    const lastUser = {
      role: "user",
      agent: "review",
      model: { providerID: "openai", modelID: "gpt", variant: "v1" },
    } as unknown as Message
    const request = buildPromptRequest("s1", undefined, lastUser, "текст")
    expect(request.model).toEqual({ providerID: "openai", modelID: "gpt" })
    expect(request.agent).toBe("review")
    expect(request.variant).toBe("v1")
  })

  test("no identifiers anywhere → model omitted", () => {
    const request = buildPromptRequest("s1", undefined, undefined, "текст")
    expect(request.model).toBeUndefined()
    expect(request.agent).toBeUndefined()
    expect(request.parts).toEqual([{ type: "text", text: "текст" }])
  })
})
