import type { SessionV1 } from "@opencode-ai/core/v1/session"

// Изоляция панелей: BTW — побочный разговор, а не продолжение основной задачи.
// Без явной инструкции модель видит в хвосте снимка незакрытый вопрос основной
// панели и отвечает на него — ответ «основной панели» печатается в btw и
// теряется для неё.
export const SIDE_CHAT_INSTRUCTION =
  "You are running in a transient side chat (btw) next to the user's main session. " +
  "The parent history in this context is a frozen snapshot captured when the side chat opened. " +
  "Answer only the user's side question; do not continue, resume, or act on any unfinished task from the snapshot."

// Срез снимка родителя: только завершённые ходы. Незавершённый (текущий) ход —
// висящий вопрос без ответа или частичный ответ — в срез не попадает, иначе
// модель BTW продолжает родительскую задачу. Граница — последний ассистентский
// ответ с проставленным time.completed; всё, что после него, отбрасывается.
export const freezeSnapshot = (base: SessionV1.WithParts[]): SessionV1.WithParts[] => {
  const lastDone = base.findLastIndex((m) => m.info.role === "assistant" && m.info.time.completed !== undefined)
  return lastDone >= 0 ? base.slice(0, lastDone + 1) : []
}
