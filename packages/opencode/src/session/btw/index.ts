import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"

import { LLM } from "../llm"
import { MessageV2 } from "../message-v2"
import { SessionProcessor } from "../processor"
import { Session } from "../session"
import { Instruction } from "../instruction"
import { SystemPrompt } from "../system"
import { MessageID, PartID, SessionID } from "../schema"
import { SessionTools } from "../tools"

import { Cause, Deferred, Duration, Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import type { Provider as ProviderModel } from "@/provider/provider"
import type { Agent as AgentModule } from "@/agent/agent"
import type { ModelMessage } from "ai"

import type { BtwPart } from "./schema"

// === Константы =============================================================

const MAX_TURNS = 50

// Инструменты, непригодные для эфемерного side-chat /btw:
//  - task: спавнит реальную дочернюю сессию (пишет SessionTable) — нарушает
//    эфемерность btw.
//  - question: блокирует тур, ожидая ответа пользователя через TUI. У btw-панели
//    нет UI для ответа, поэтому ответ никогда не придёт и тур висит до серверного
//    timeout (run 55c95cc9: question → asking que_* → btw turn timed out 120s).
const DISABLED_TOOLS = new Set(["task", "question"])

const BTW_PROMPT_OPS: TaskPromptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: () => Effect.die(new Error("btw: task tool is disabled")),
  prompt: () => Effect.die(new Error("btw: task tool is disabled")),
}

type ToolStateLite = "running" | "completed" | "error"

// === Состояние =============================================================

type BtwState = {
  btwID: string
  parentID: SessionID
  btwSessionID: SessionID
  syntheticSession: Session.Info
  agent: AgentModule.Info
  model: ProviderModel.Model
  permission: PermissionV1.Ruleset
  system: string[]
  base: SessionV1.WithParts[]
  conversation: SessionV1.WithParts[]
  directory: string
  worktree: string
  busy: boolean
  closed: boolean
  // Сигнал прерывания текущего тура. /btw/abort и Btw.close завершают его,
  // а runLoop гоняется с Deferred.await — победа => тур прерывается и
  // ensuring срабатывает (busy=false, Queue.end). undefined вне активного тура.
  abortDeferred?: Deferred.Deferred<void>
  // Очередь активного запроса — нужна Btw.abort/close, чтобы предложить
  // терминальный кадр (error/closed) до прерывания runLoop.
  activeQueue?: Queue.Queue<BtwPart, Cause.Done>
}

// Process-local хранилище эфемерных бесед. Не переживает рестарт сервера и
// не пишет в БД — соответствует определению «эфемерный».
const store = new Map<string, BtwState>()

type TurnCtx = {
  assistant: SessionV1.Assistant
  parts: SessionV1.Part[]
  toolcalls: Map<string, SessionV1.ToolPart>
  currentText?: SessionV1.TextPart
  // Единственный признак провала тура: выставляется и стримовым catchCause
  // (обрыв транспорта), и событием provider-error. runTurn по нему возвращает
  // "stop", иначе слепой рестарт runLoop маскировал бы обрыв как «продолжить».
  errored: boolean
}

// === Хелперы ===============================================================

const nonce = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

const newBtwSessionID = () => SessionID.make("ses_btw_" + nonce())

const lastUser = (state: BtwState): SessionV1.User | undefined =>
  state.conversation.findLast((m) => m.info.role === "user")?.info as SessionV1.User | undefined

const makeUserMessage = (state: BtwState, text: string): { info: SessionV1.User; parts: SessionV1.Part[] } => {
  const template = state.base.findLast((m) => m.info.role === "user")?.info as SessionV1.User | undefined
  const userModel: SessionV1.User["model"] = template
    ? template.model
    : ({
        providerID: state.model.providerID as unknown as SessionV1.User["model"]["providerID"],
        modelID: state.model.api.id as unknown as SessionV1.User["model"]["modelID"],
      } as SessionV1.User["model"])
  const id = MessageID.ascending()
  const info: SessionV1.User = {
    id,
    sessionID: state.btwSessionID,
    role: "user",
    time: { created: Date.now() },
    agent: state.agent.name,
    model: userModel,
    ...(template?.system ? { system: template.system } : {}),
  }
  const textPart: SessionV1.TextPart = {
    id: PartID.ascending(),
    sessionID: state.btwSessionID,
    messageID: id,
    type: "text",
    text,
    time: { start: Date.now() },
  }
  return { info, parts: [textPart] }
}

const makeAssistant = (state: BtwState, parentID: SessionV1.MessageID): SessionV1.Assistant => {
  const tpl = state.base.findLast((m) => m.info.role === "assistant")?.info as SessionV1.Assistant | undefined
  return {
    id: MessageID.ascending(),
    sessionID: state.btwSessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: (tpl?.modelID ?? (state.model.api.id as unknown as SessionV1.Assistant["modelID"])) as SessionV1.Assistant["modelID"],
    providerID: (tpl?.providerID ?? (state.model.providerID as unknown as SessionV1.Assistant["providerID"])) as SessionV1.Assistant["providerID"],
    mode: tpl?.mode ?? "primary",
    agent: state.agent.name,
    path: tpl?.path ?? { cwd: state.directory, root: state.worktree },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

const lite = (s: SessionV1.ToolPart["state"]["status"]): ToolStateLite =>
  s === "pending" ? "running" : (s as ToolStateLite)

const toolResultOutput = (
  value: Extract<LLMEvent, { type: "tool-result" }>,
): { title: string; metadata: Record<string, unknown>; output: string } => {
  const result = value.result
  if (isRecord(result.value) && typeof (result.value as { output?: unknown }).output === "string") {
    const v = result.value as { output: string; title?: unknown }
    return {
      title: typeof v.title === "string" ? v.title : value.name,
      metadata: isRecord(v) ? (v as Record<string, unknown>) : {},
      output: v.output,
    }
  }
  return {
    title: value.name,
    metadata: result.type === "json" && isRecord(result.value) ? (result.value as Record<string, unknown>) : {},
    output: typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? ""),
  }
}

// === In-memory процессор ===================================================
// Тримм processor.handleEvent: те же LLMEvent, но пишем в память (turn.parts)
// и стримим BtwPart в очередь, а НЕ в Session.Service/БД.

const makeHandle = (
  state: BtwState,
  turn: TurnCtx,
  queue: Queue.Queue<BtwPart, Cause.Done>,
): Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall"> => {
  const ensureToolCall = (callID: string, name?: string): SessionV1.ToolPart => {
    const existing = turn.toolcalls.get(callID)
    if (existing) {
      if (name && !existing.tool) existing.tool = name
      return existing
    }
    const part: SessionV1.ToolPart = {
      id: PartID.ascending(),
      sessionID: state.btwSessionID,
      messageID: turn.assistant.id,
      type: "tool",
      callID,
      tool: name ?? "",
      state: { status: "running", input: {}, time: { start: Date.now() } },
    }
    turn.toolcalls.set(callID, part)
    turn.parts.push(part)
    return part
  }

  return {
    get message() {
      return turn.assistant
    },
    updateToolCall: (callID, update) =>
      Effect.gen(function* () {
        const part = ensureToolCall(callID)
        const updated = update(part)
        turn.toolcalls.set(callID, updated)
        const idx = turn.parts.findIndex((p) => p.id === updated.id)
        if (idx >= 0) turn.parts[idx] = updated
        yield* Queue.offer(queue, {
          type: "tool",
          messageID: turn.assistant.id as unknown as string,
          callID,
          tool: updated.tool,
          state: lite(updated.state.status),
          title: updated.state.status === "running" ? updated.state.title : undefined,
        })
        return updated
      }),
    completeToolCall: (callID, output) =>
      Effect.gen(function* () {
        const part = turn.toolcalls.get(callID)
        if (!part) return
        const start = part.state.status === "running" ? part.state.time.start : Date.now()
        part.state = {
          status: "completed",
          input: part.state.status === "running" ? part.state.input : {},
          output: output.output,
          title: output.title,
          metadata: output.metadata,
          time: { start, end: Date.now() },
        }
        yield* Queue.offer(queue, {
          type: "tool",
          messageID: turn.assistant.id as unknown as string,
          callID,
          tool: part.tool,
          state: "completed",
          title: output.title,
          output: output.output,
        })
      }),
  }
}

const onEvent = (state: BtwState, turn: TurnCtx, queue: Queue.Queue<BtwPart, Cause.Done>) => (event: LLMEvent) =>
  Effect.gen(function* () {
    switch (event.type) {
      case "text-start": {
        turn.currentText = {
          id: PartID.ascending(),
          sessionID: state.btwSessionID,
          messageID: turn.assistant.id,
          type: "text",
          text: "",
          time: { start: Date.now() },
        }
        turn.parts.push(turn.currentText)
        return
      }
      case "text-delta": {
        if (!turn.currentText) return
        const delta = (event as { text: string }).text
        turn.currentText.text += delta
        yield* Queue.offer(queue, {
          type: "text-delta",
          messageID: turn.assistant.id as unknown as string,
          delta,
        })
        return
      }
      case "text-end": {
        if (!turn.currentText) return
        const end = Date.now()
        turn.currentText.time = { start: turn.currentText.time?.start ?? end, end }
        yield* Queue.offer(queue, { type: "text-end", messageID: turn.assistant.id as unknown as string })
        turn.currentText = undefined
        return
      }
      // Reasoning-фаза (glm-5.2 и др.): стримим «thinking» в TUI, иначе во время
      // долгого раздумья модалка не показывает ничего и выглядит зависшей.
      case "reasoning-start":
        return
      case "reasoning-delta": {
        yield* Queue.offer(queue, {
          type: "reasoning-delta",
          messageID: turn.assistant.id as unknown as string,
          delta: (event as { text: string }).text,
        })
        return
      }
      case "reasoning-end":
        return
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end": {
        const v = event as { id: string; name?: string }
        if (!turn.toolcalls.has(v.id) && v.name) {
          const part: SessionV1.ToolPart = {
            id: PartID.ascending(),
            sessionID: state.btwSessionID,
            messageID: turn.assistant.id,
            type: "tool",
            callID: v.id,
            tool: v.name,
            state: { status: "running", input: {}, time: { start: Date.now() } },
          }
          turn.toolcalls.set(v.id, part)
          turn.parts.push(part)
        }
        return
      }
      case "tool-call": {
        const v = event as { id: string; name?: string; input?: unknown }
        const handle = makeHandle(state, turn, queue)
        yield* handle.updateToolCall(v.id, (match) => ({
          ...match,
          tool: v.name ?? match.tool,
          state: {
            status: "running",
            input: isRecord(v.input) ? (v.input as Record<string, unknown>) : { value: v.input },
            time: { start: Date.now() },
          },
        }))
        return
      }
      case "tool-result": {
        const v = event as Extract<LLMEvent, { type: "tool-result" }>
        const out = toolResultOutput(v)
        const handle = makeHandle(state, turn, queue)
        if (!turn.toolcalls.has(v.id)) {
          const part: SessionV1.ToolPart = {
            id: PartID.ascending(),
            sessionID: state.btwSessionID,
            messageID: turn.assistant.id,
            type: "tool",
            callID: v.id,
            tool: v.name,
            state: {
              status: "completed",
              input: {},
              output: out.output,
              title: out.title,
              metadata: out.metadata,
              time: { start: Date.now(), end: Date.now() },
            },
          }
          turn.toolcalls.set(v.id, part)
          turn.parts.push(part)
          yield* Queue.offer(queue, {
            type: "tool",
            messageID: turn.assistant.id as unknown as string,
            callID: v.id,
            tool: v.name,
            state: "completed",
            title: out.title,
            output: out.output,
          })
          return
        }
        yield* handle.completeToolCall(v.id, out)
        return
      }
      case "tool-error": {
        const v = event as { id: string; message?: string; error?: { message?: string } }
        const part = turn.toolcalls.get(v.id)
        if (part) {
          const msg = v.message ?? v.error?.message ?? "tool error"
          part.state = {
            status: "error",
            input: part.state.status === "running" ? part.state.input : {},
            error: msg,
            time: { start: Date.now(), end: Date.now() },
          }
          yield* Queue.offer(queue, {
            type: "tool",
            messageID: turn.assistant.id as unknown as string,
            callID: v.id,
            tool: part.tool,
            state: "error",
            error: msg,
          })
        }
        return
      }
      case "step-finish": {
        turn.assistant.finish = (event as { reason?: string }).reason
        return
      }
      case "provider-error": {
        const message = (event as { message: string }).message
        turn.errored = true
        yield* Effect.logError("btw provider error", { ...btwLogCtx(state), error: message })
        yield* Queue.offer(queue, { type: "error", message })
        return
      }
      default:
        return
    }
  })

// === Один LLM-тур ==========================================================

const btwLogCtx = (state: BtwState) => ({
  "btw.session.id": state.btwSessionID,
  providerID: state.model.providerID,
  modelID: state.model.api.id,
  agent: state.agent.name,
  mode: state.agent.mode,
})

const runTurn = (state: BtwState, queue: Queue.Queue<BtwPart, Cause.Done>) =>
  Effect.gen(function* () {
    const user = lastUser(state)
    if (!user) return "stop" as const

    const plugin = yield* Plugin.Service
    const permission = yield* Permission.Service
    const registry = yield* ToolRegistry.Service
    const mcp = yield* MCP.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const llm = yield* LLM.Service

    const assistant = makeAssistant(state, user.id)
    const turn: TurnCtx = { assistant, parts: [], toolcalls: new Map(), errored: false }
    const handle = makeHandle(state, turn, queue)

    const tools = yield* SessionTools.resolve({
      agent: state.agent,
      model: state.model,
      session: state.syntheticSession,
      processor: handle,
      bypassAgentCheck: false,
      messages: [...state.base, ...state.conversation],
      promptOps: BTW_PROMPT_OPS,
    }).pipe(
      Effect.provideService(Plugin.Service, plugin),
      Effect.provideService(Permission.Service, permission),
      Effect.provideService(ToolRegistry.Service, registry),
      Effect.provideService(MCP.Service, mcp),
      Effect.provideService(Truncate.Service, truncate),
      Effect.provideService(RuntimeFlags.Service, flags),
    )
    for (const id of DISABLED_TOOLS) delete tools[id]

    const modelMsgs = yield* MessageV2.toModelMessagesEffect([...state.base, ...state.conversation], state.model)

    const streamInput: LLM.StreamInput = {
      user,
      agent: state.agent,
      permission: state.permission,
      sessionID: state.btwSessionID as unknown as string,
      parentSessionID: state.parentID as unknown as string,
      system: state.system,
      messages: modelMsgs as ModelMessage[],
      tools,
      model: state.model,
    }

    yield* llm.stream(streamInput).pipe(
      Stream.tap(onEvent(state, turn, queue)),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          turn.errored = true
          yield* Effect.logError("btw stream error", { ...btwLogCtx(state), error: Cause.squash(cause) })
          yield* Queue.offer(queue, { type: "error", message: errorMessage(cause) ?? "stream error" })
        }),
      ),
    )

    assistant.time.completed = Date.now()
    state.conversation.push({ info: assistant, parts: turn.parts })
    yield* Queue.offer(queue, {
      type: "assistant-end",
      messageID: assistant.id as unknown as string,
      finish: assistant.finish,
    })

    if (turn.errored) return "stop" as const
    const finished = assistant.finish && !["tool-calls", "unknown"].includes(assistant.finish)
    return (finished ? "stop" : "continue") as "stop" | "continue"
  })

// Полный мульти-тур для одного user-сообщения. Пишет BtwPart в очередь и
// закрывает её по завершении через Queue.end: это дрейнит буферизованные
// части (text-delta, turn-end, error) и завершает стрим нормальным EOF.
// Queue.shutdown здесь неправильно — он сбрасывает self.messages (теряя
// последние кадры) и финализирует interrupt'ом, клиент не получает ответа.
const runLoop = (state: BtwState, queue: Queue.Queue<BtwPart, Cause.Done>) =>
  Effect.gen(function* () {
    let guard = 0
    let result: "continue" | "stop" = "continue"
    while (result === "continue" && guard++ < MAX_TURNS && !state.closed) {
      result = yield* runTurn(state, queue).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("btw turn error", { ...btwLogCtx(state), error: Cause.squash(cause) })
            yield* Queue.offer(queue, { type: "error", message: errorMessage(cause) ?? "turn error" })
            return "stop" as const
          }),
        ),
      )
    }
    yield* Queue.offer(queue, { type: "turn-end" })
  }).pipe(
    Effect.timeout(Duration.seconds(120)),
    Effect.catchTag("TimeoutError", () =>
      Effect.gen(function* () {
        yield* Effect.logError("btw turn timed out", { ...btwLogCtx(state), timeout: "120s" })
        yield* Queue.offer(queue, { type: "error", message: "btw: timed out (no response in 120s)" })
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        state.busy = false
        state.abortDeferred = undefined
        state.activeQueue = undefined
        yield* Queue.end(queue)
      }),
    ),
  )

// === Публичный API ============================================================

// Доменная ошибка: у родительской сессии нет модели и нет дефолта в агенте.
// Транслируется на границе HTTP-обработчика в InvalidRequestError (400).
export class ParentNoModelError extends Schema.TaggedErrorClass<ParentNoModelError>()(
  "BtwParentNoModelError",
  { message: Schema.String },
) {}

export const open = Effect.fn("Btw.open")(function* (input: { parentID: SessionID }) {
  const sessionSvc = yield* Session.Service
  const agentSvc = yield* Agent.Service
  const providerSvc = yield* Provider.Service
  const sys = yield* SystemPrompt.Service
  const instruction = yield* Instruction.Service
  const database = yield* Database.Service
  const ctx = yield* InstanceState.context

  const parent = yield* sessionSvc.get(input.parentID)
  const agentName = parent.agent ?? "build"
  const agent = yield* agentSvc.get(agentName)

  const providerID = (parent.model?.providerID ?? agent.model?.providerID) as ProviderV2.ID | undefined
  const modelID = (parent.model?.id ?? agent.model?.modelID) as ModelV2.ID | undefined
  if (!providerID || !modelID) return yield* new ParentNoModelError({ message: "btw: parent session has no model" })
  const model = yield* providerSvc.getModel(providerID, modelID).pipe(Effect.orDie)

  const base = yield* MessageV2.filterCompactedEffect(input.parentID).pipe(
    Effect.provideService(Database.Service, database),
    Effect.orDie,
  )

  const permission = parent.permission ?? agent.permission
  const [skills, env, instructions, mcp] = yield* Effect.all([
    sys.skills(agent),
    sys.environment(model),
    instruction.system().pipe(Effect.orDie),
    sys.mcp(agent, permission),
  ]).pipe(Effect.orDie)
  const system = [...env, ...instructions, ...(mcp ? [mcp] : []), ...(skills ? [skills] : [])]

  const btwID = "btw_" + nonce()
  const btwSessionID = newBtwSessionID()
  const syntheticSession: Session.Info = { ...parent, id: btwSessionID, permission }

  const state: BtwState = {
    btwID,
    parentID: input.parentID,
    btwSessionID,
    syntheticSession,
    agent,
    model,
    permission,
    system,
    base,
    conversation: [],
    directory: ctx.directory,
    worktree: ctx.worktree,
    busy: false,
    closed: false,
  }
  store.set(btwID, state)
  return { btwID }
})

// Один user-сообщение → выполнение тура с записью BtwPart в предоставленную
// очередь. Очередь закрывается через Queue.end по завершении (runLoop.ensuring),
// что дрейнит буфер и корректно завершает SSE-стрим ответа.
export const runSend = Effect.fn("Btw.send")(function* (input: {
  btwID: string
  text: string
  queue: Queue.Queue<BtwPart, Cause.Done>
}) {
  const state = store.get(input.btwID)
  if (!state) {
    yield* Queue.offer(input.queue, { type: "error", message: "btw: not found" })
    yield* Queue.end(input.queue)
    return
  }
  if (state.closed) {
    yield* Queue.offer(input.queue, { type: "error", message: "btw: closed" })
    yield* Queue.end(input.queue)
    return
  }
  if (state.busy) {
    yield* Queue.offer(input.queue, { type: "warning", message: "previous turn is still running" })
    yield* Queue.end(input.queue)
    return
  }
  state.busy = true
  state.abortDeferred = yield* Deferred.make<void>()
  state.activeQueue = input.queue
  const userMsg = makeUserMessage(state, input.text)
  state.conversation.push(userMsg)
  yield* Queue.offer(input.queue, { type: "user", id: userMsg.info.id as unknown as string, text: input.text })
  // Гонка с abort-сигналом: при /btw/abort или Btw.close deferred завершается,
  // правая ветка побеждает, runLoop прерывается, его ensuring дренирует очередь
  // (Queue.end => нормальный EOF для клиента) и снимает busy.
  yield* Effect.race(runLoop(state, input.queue), Deferred.await(state.abortDeferred))
})

export const close = Effect.fn("Btw.close")(function* (input: { btwID: string }) {
  const state = store.get(input.btwID)
  if (state) {
    state.closed = true
    // Прерываем активный тур и эмитим терминальный closed — клиент получает
    // явный сигнал и выходит из for-await без ожидания EOF/timeout.
    const queue = state.activeQueue
    const deferred = state.abortDeferred
    if (queue && deferred) {
      yield* Queue.offer(queue, { type: "closed" })
      yield* Deferred.succeed(deferred, undefined)
    }
    store.delete(input.btwID)
  }
  return { ok: true }
})

// Прервать активный тур без закрытия чата: эмитим error и завершаем abort-deferred.
// runLoop прерывается по гонке, ensuring снимает busy и закрывает очередь.
// Вне активного тура — no-op.
export const abort = Effect.fn("Btw.abort")(function* (input: { btwID: string }) {
  const state = store.get(input.btwID)
  const queue = state?.activeQueue
  const deferred = state?.abortDeferred
  if (queue && deferred) {
    yield* Queue.offer(queue, { type: "error", message: "btw: aborted" })
    yield* Deferred.succeed(deferred, undefined)
  }
  return { ok: true }
})

// Очистка при остановке сервера.
export const dispose = Effect.sync(() => {
  for (const state of store.values()) state.closed = true
  store.clear()
})

export { BtwPart } from "./schema"
export * as Btw from "./index"
