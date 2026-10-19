// Форма аргумента session.prompt нового клиента: плоский text; agent/model/variant
// сервер разрешает из состояния сессии.
export type PromptRequest = {
  sessionID: string
  text: string
}

export function buildPromptRequest(sessionID: string, text: string): PromptRequest {
  return { sessionID, text }
}
