import type { SessionMessage } from "@opencode/schema/session-message"

// Изоляция панелей: btw — побочный разговор, а не продолжение основной задачи.
// Без явной инструкции модель видит в хвосте снимка незакрытый вопрос основной
// панели и отвечает на него — ответ «основной панели» печатается в btw и
// теряется для неё.
export const SIDE_CHAT_INSTRUCTION =
  "You are running in a transient side chat (btw) next to the user's main session. " +
  "The parent history in this context is a frozen snapshot captured when the side chat opened. " +
  "Answer only the user's side question; do not continue, resume, or act on any unfinished task from the snapshot. " +
  "Do not call any tools and do not take any actions."

// Срез снимка родителя: только завершённые ходы. Незавершённый (текущий) ход —
// висящий вопрос без ответа или частичный ответ — в срез не попадает, иначе
// модель btw продолжает родительскую задачу. Граница — последний ассистентский
// ответ с проставленным time.completed; всё, что после него, отбрасывается.
export const freezeSnapshot = (messages: ReadonlyArray<SessionMessage.Info>): Array<SessionMessage.Info> => {
  const lastDone = messages.findLastIndex(
    (message) => message.type === "assistant" && message.time.completed !== undefined,
  )
  return lastDone >= 0 ? messages.slice(0, lastDone + 1) : []
}
