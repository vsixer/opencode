import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode/schema/session-message"
import { freezeSnapshot, SIDE_CHAT_INSTRUCTION } from "@opencode/core/session/btw/snapshot"

// Срез снимка побочного чата (session/btw/snapshot.ts): в контекст входят только
// завершённые ходы родителя. Незавершённый ход — висящий вопрос без ответа или
// частичный ответ — не попадает в снимок, иначе модель btw продолжает
// родительскую задачу, и её «ответ» печатается в btw-панели, теряясь для
// основной панели.

const sessionID = "ses_snapshot"
let seq = 0

function user(text: string): SessionMessage.Info {
  seq += 1
  return {
    id: `msg_${seq}`,
    sessionID,
    type: "user",
    time: { created: Date.now() + seq },
    text,
    files: [],
    agents: [],
    skills: [],
  } as unknown as SessionMessage.Info
}

function assistant(text: string, completed: boolean): SessionMessage.Info {
  seq += 1
  const created = Date.now() + seq
  seq += 1
  return {
    id: `msg_${seq}`,
    sessionID,
    type: "assistant",
    time: { created, ...(completed ? { completed: created + 1 } : {}) },
    agent: "build",
    model: { providerID: "test", id: "test-model" },
    content: [{ type: "text", text }],
  } as unknown as SessionMessage.Info
}

const texts = (history: SessionMessage.Info[]) =>
  history.flatMap((message) =>
    message.type === "user" ? [message.text] : message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

describe("btw snapshot freeze", () => {
  test("keeps completed turns and drops the pending parent question", () => {
    const frozen = freezeSnapshot([user("first question"), assistant("MAIN ANSWER ONE", true), user("PENDING QUESTION")])
    expect(texts(frozen)).toEqual(["first question", "MAIN ANSWER ONE"])
  })

  test("keeps several trailing completed turns intact", () => {
    const frozen = freezeSnapshot([user("q1"), assistant("a1", true), user("q2"), assistant("a2", true)])
    expect(texts(frozen)).toEqual(["q1", "a1", "q2", "a2"])
  })

  test("drops a trailing partial assistant answer", () => {
    const frozen = freezeSnapshot([user("q1"), assistant("a1", true), assistant("partial", false)])
    expect(texts(frozen)).toEqual(["q1", "a1"])
  })

  test("empty snapshot when the parent has no completed turn yet", () => {
    expect(freezeSnapshot([user("PENDING QUESTION")])).toEqual([])
    expect(freezeSnapshot([user("q1"), assistant("partial", false)])).toEqual([])
    expect(freezeSnapshot([])).toEqual([])
  })

  test("side-chat instruction forbids continuing the parent task or calling tools", () => {
    expect(SIDE_CHAT_INSTRUCTION).toContain("do not continue")
    expect(SIDE_CHAT_INSTRUCTION).toContain("Do not call any tools")
  })
})
