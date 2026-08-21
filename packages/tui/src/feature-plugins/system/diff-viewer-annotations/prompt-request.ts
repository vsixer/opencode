import type { Message, Session } from "@opencode-ai/sdk/v2"

// Форма аргумента session.prompt (плоская, как в component/prompt/index.tsx). agent/variant
// необязательны; model добавляется только при наличии providerID и modelID.
export type PromptRequest = {
  sessionID: string
  agent?: string
  variant?: string
  model?: { providerID: string; modelID: string }
  parts: Array<{ type: "text"; text: string }>
}

function asUser(message: Message | undefined) {
  return message?.role === "user" ? message : undefined
}

// Разрешение agent/model/variant для отправки замечаний. Приоритет — состояние сессии
// (Session.model.id выступает как modelID), фоллбэк — последнее user-сообщение, чья model
// уже несёт {providerID, modelID, variant}. model опускается, если идентификаторов нет.
export function buildPromptRequest(
  sessionID: string,
  session: Session | undefined,
  lastUser: Message | undefined,
  text: string,
): PromptRequest {
  const user = asUser(lastUser)
  const providerID = session?.model?.providerID ?? user?.model.providerID
  const modelID = session?.model?.id ?? user?.model.modelID
  const request: PromptRequest = {
    sessionID,
    agent: session?.agent ?? user?.agent,
    variant: session?.model?.variant ?? user?.model.variant,
    parts: [{ type: "text", text }],
  }
  if (providerID && modelID) request.model = { providerID, modelID }
  return request
}
