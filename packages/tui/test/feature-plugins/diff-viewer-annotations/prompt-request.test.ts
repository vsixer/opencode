import { describe, expect, test } from "bun:test"
import { buildPromptRequest } from "../../../src/feature-plugins/system/diff-viewer-annotations/prompt-request"

// UT-10 (FR-P1): форма запроса замечаний. Плоский text — agent/model/variant
// сервер разрешает из состояния сессии, клиент их больше не передаёт.
describe("prompt-request — buildPromptRequest (UT-10)", () => {
  test("wraps the assembled message as flat text", () => {
    expect(buildPromptRequest("s1", "текст")).toEqual({ sessionID: "s1", text: "текст" })
  })

  test("keeps the owner session id verbatim", () => {
    expect(buildPromptRequest("ses_abc", "")).toEqual({ sessionID: "ses_abc", text: "" })
  })
})
