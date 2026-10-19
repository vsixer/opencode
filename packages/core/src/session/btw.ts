export * as SessionBtw from "./btw.js"

import { LLMClient, LLMEvent, LLMRequest, Message, SystemPart } from "@opencode/ai"
import type { StreamOptions } from "@opencode/ai/route"
import { ascending } from "@opencode/schema/identifier"
import { Btw } from "@opencode/schema/btw"
import { Schema } from "effect"
import { Cause, Deferred, Effect, Queue, Stream } from "effect"
import { Database } from "../database/database.js"
import { FileSystem } from "../filesystem.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { SessionContext } from "./context.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionSchema } from "./schema.js"
import { freezeSnapshot, SIDE_CHAT_INSTRUCTION } from "./btw/snapshot.js"

/** Родительская сессия не дала контекст для побочного чата: у неё нет
 * разрешённой модели, агент не найден или инструкции не инициализированы.
 * На HTTP-границе транслируется в InvalidRequestError (400). */
export class SelectionError extends Schema.TaggedError<SelectionError>()("Btw.SelectionError", {
  message: Schema.String,
}) {}

type BtwState = {
  btwID: string
  parent: SessionSchema.Info
  // Запрос заморожен в момент open: система, снимок истории родителя и опросы
  // плагинов фиксируются один раз — последующие send лишь дописывают ходы
  // побочной беседы в messages.
  request: LLMRequest
  options: StreamOptions
  transcript: Array<Message>
  busy: boolean
  closed: boolean
  // Сигнал прерывания активного тура: btw/abort и close завершают deferred,
  // гонка в send прерывает тур, ensuring дренит очередь.
  abortDeferred?: Deferred.Deferred<void>
  activeQueue?: Queue.Queue<Btw.Part, Cause.Done>
}

// Process-local хранилище эфемерных бесед. Не переживает рестарт сервера и
// не пишет в БД — соответствует определению «эфемерный».
const store = new Map<string, BtwState>()

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  return squashed instanceof Error ? squashed.message : String(squashed)
}

// Открывает эфемерный побочный чат, замороженный на завершённых ходах
// родительской сессии. Незавершённый ход родителя (висящий вопрос или
// частичный ответ) в контекст не попадает — см. freezeSnapshot.
// Вызывающая сторона сама предоставляет граф локации родительской сессии
// (обычно instances.provide(parent)) — внутри функции теги не тянутся.
export const open = Effect.fn("SessionBtw.open")(function* (input: { parent: SessionSchema.Info }) {
  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const database = yield* Database.Service
    const selection = yield* context.select(input.parent.id)
    const model = yield* context.resolveModel(selection.session)
    const history = yield* SessionHistory.preview(
      database.db,
      selection.session.id,
      selection.instructions,
      SessionProviderContext.provenance(model) ?? "local",
    )
    const frozen = freezeSnapshot(history.messages)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: frozen,
    })
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: [SystemPart.make(SIDE_CHAT_INSTRUCTION), ...transcript.system],
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
      ],
    })
    const btwID = `btw_${ascending()}`
    const state: BtwState = {
      btwID,
      parent: input.parent,
      request: prepared.request,
      options: prepared.options,
      transcript: [],
      busy: false,
      closed: false,
    }
    store.set(btwID, state)
    return { btwID }
  }).pipe(
    Effect.catch((error) =>
      error instanceof FileSystem.DirectoryNotFoundError
        ? Effect.fail(error)
        : new SelectionError({ message: error instanceof Error ? error.message : String(error) }),
    ),
  )
})

// Один ход побочной беседы: стрим LLM событиями отображается в кадры Btw.Part,
// накопленный текст ответа дописывается в transcript для следующих ходов.
// Инструменты не исполняются (как в session.generate): SIDE_CHAT_INSTRUCTION
// запрещает model вызывать их, а tool-события провайдера кадром не отображаются.
const runTurn = (state: BtwState, messages: ReadonlyArray<Message>, queue: Queue.Queue<Btw.Part, Cause.Done>) =>
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const request = new LLMRequest({ ...LLMRequest.input(state.request), messages: [...messages] })
    let text = ""
    let lastBlockID = ""
    const frame = (event: LLMEvent): Btw.Part | undefined => {
      switch (event.type) {
        case "text-delta":
          return { type: "text-delta", btwID: state.btwID, messageID: event.id, delta: event.text }
        case "reasoning-delta":
          return { type: "reasoning-delta", btwID: state.btwID, messageID: event.id, delta: event.text }
        case "text-end":
          return { type: "text-end", btwID: state.btwID, messageID: event.id }
        default:
          return undefined
      }
    }
    yield* llm
      .stream(request, state.options)
      .pipe(
        Stream.tap((event) => {
          if (event.type === "text-delta") {
            text += event.text
            lastBlockID = event.id
          }
          if (event.type === "reasoning-delta") lastBlockID = event.id
          const part = frame(event)
          return part === undefined ? Effect.void : Queue.offer(queue, part)
        }),
        Stream.runDrain,
        // Ошибка стрима не роняет ход: терминальный кадр error доходит до
        // клиента, затем очередь закрывается ensuring-ом с нормальным EOF.
        Effect.catchCause((cause) =>
          Queue.offer(queue, { type: "error", btwID: state.btwID, message: causeMessage(cause) }),
        ),
      )
    if (text.length > 0) state.transcript.push(Message.assistant(text))
    yield* Queue.offer(queue, { type: "assistant-end", btwID: state.btwID, messageID: lastBlockID })
    yield* Queue.offer(queue, { type: "turn-end", btwID: state.btwID })
  })

// Отправляет сообщение в побочный чат и пишет кадры хода в предоставленную
// очередь. Очередь закрывается через Queue.end (нормальный drain + EOF), а не
// через Queue.shutdown — shutdown финализирует interrupt-ом, и клиент теряет
// последние кадры.
export const runSend = Effect.fn("SessionBtw.send")(function* (input: {
  btwID: string
  text: string
  queue: Queue.Queue<Btw.Part, Cause.Done>
  // Селектор инстансов захватывается вызывающей стороной: тянуть тег внутри
  // эффекта маршрута нельзя — он ушел бы в request-канал роутера без провайдера.
  instances: Instance.Interface
}) {
  const state = store.get(input.btwID)
  if (!state) {
    yield* Queue.offer(input.queue, { type: "error", btwID: input.btwID, message: "btw: not found" })
    yield* Queue.end(input.queue)
    return
  }
  if (state.closed) {
    yield* Queue.offer(input.queue, { type: "error", btwID: state.btwID, message: "btw: closed" })
    yield* Queue.end(input.queue)
    return
  }
  if (state.busy) {
    yield* Queue.offer(input.queue, {
      type: "warning",
      btwID: state.btwID,
      message: "previous turn is still running",
    })
    yield* Queue.end(input.queue)
    return
  }
  state.busy = true
  state.abortDeferred = yield* Deferred.make<void>()
  state.activeQueue = input.queue

  const user = Message.user(input.text)
  const messages = [...state.request.messages, ...state.transcript, user]
  state.transcript.push(user)
  yield* Queue.offer(input.queue, { type: "user", btwID: state.btwID, id: ascending(), text: input.text })
  // Гонка с abort-сигналом: при btw/abort или close deferred завершается,
  // правая ветка побеждает, тур прерывается, ensuring снимает busy и дренит
  // очередь (Queue.end => нормальный EOF для клиента).
  yield* Effect.race(runTurn(state, messages, input.queue), Deferred.await(state.abortDeferred)).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        state.busy = false
        state.abortDeferred = undefined
        state.activeQueue = undefined
        yield* Queue.end(input.queue)
      }),
    ),
    input.instances.provide(state.parent),
  )
})

// Закрывает побочный чат: активный тур прерывается, клиент получает явный
// терминальный кадр closed и выходит из чтения стрима без ожидания EOF/timeout.
export const close = Effect.fn("SessionBtw.close")(function* (input: { btwID: string }) {
  const state = store.get(input.btwID)
  if (state) {
    state.closed = true
    const queue = state.activeQueue
    const deferred = state.abortDeferred
    if (queue && deferred) {
      yield* Queue.offer(queue, { type: "closed", btwID: state.btwID })
      yield* Deferred.succeed(deferred, undefined)
    }
    store.delete(input.btwID)
  }
  return { ok: true }
})

// Прерывает активный ход, не закрывая чат: эмитим error и завершаем
// abort-deferred. Вне активного хода — no-op.
export const abort = Effect.fn("SessionBtw.abort")(function* (input: { btwID: string }) {
  const state = store.get(input.btwID)
  const queue = state?.activeQueue
  const deferred = state?.abortDeferred
  if (queue && deferred) {
    yield* Queue.offer(queue, { type: "error", btwID: input.btwID, message: "btw: aborted" })
    yield* Deferred.succeed(deferred, undefined)
  }
  return { ok: true }
})

// Очистка при остановке сервера.
export const dispose = Effect.sync(() => {
  for (const state of store.values()) state.closed = true
  store.clear()
})
