import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { freezeSnapshot, SIDE_CHAT_INSTRUCTION } from "@/session/btw/snapshot"

// Срез снимка btw (session/btw/snapshot.ts): в контекст побочного разговора
// входят только завершённые ходы родителя. Незавершённый ход — висящий вопрос
// без ответа или частичный ответ — не попадает в снимок, иначе модель btw
// продолжает родительскую задачу, и её «ответ» печатается в btw-панели,
// теряясь для основной панели.

const sessionID = SessionID.make("ses_snapshot")
let seq = 0

function user(text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() + seq++ },
      agent: "build",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
  }
}

function assistant(text: string, completed: boolean): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() + seq++, ...(completed ? { completed: Date.now() + seq++ } : {}) },
      parentID: MessageID.ascending(),
      agent: "build",
      modelID: "test-model" as never,
      providerID: "test" as never,
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
      finish: completed ? "stop" : undefined,
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
  }
}

const texts = (history: SessionV1.WithParts[]) =>
  history.flatMap((m) => m.parts.flatMap((p) => ("text" in p ? [p.text] : [])))

describe("btw snapshot freeze", () => {
  test("keeps completed turns and drops the pending parent question", () => {
    const frozen = freezeSnapshot([
      user("first question"),
      assistant("MAIN ANSWER ONE", true),
      user("PENDING QUESTION"),
    ])
    expect(texts(frozen)).toEqual(["first question", "MAIN ANSWER ONE"])
  })

  test("drops a partial in-flight assistant answer after the pending question", () => {
    const frozen = freezeSnapshot([
      user("first question"),
      assistant("MAIN ANSWER ONE", true),
      user("PENDING QUESTION"),
      assistant("partial ans", false),
    ])
    expect(texts(frozen)).toEqual(["first question", "MAIN ANSWER ONE"])
  })

  test("keeps several trailing completed turns intact", () => {
    const frozen = freezeSnapshot([
      user("q1"),
      assistant("a1", true),
      user("q2"),
      assistant("a2", true),
    ])
    expect(texts(frozen)).toEqual(["q1", "a1", "q2", "a2"])
  })

  test("empty snapshot when the parent has no completed turn yet", () => {
    expect(freezeSnapshot([user("PENDING QUESTION")])).toEqual([])
    expect(freezeSnapshot([user("q1"), assistant("partial", false)])).toEqual([])
    expect(freezeSnapshot([])).toEqual([])
  })

  test("side-chat instruction forbids continuing the parent task", () => {
    expect(SIDE_CHAT_INSTRUCTION).toContain("transient side chat")
    expect(SIDE_CHAT_INSTRUCTION).toContain("do not continue, resume, or act on any unfinished task")
  })
})
