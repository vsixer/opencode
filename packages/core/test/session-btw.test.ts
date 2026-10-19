import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect"

// Регрессионный guard для побочного чата btw (session/btw.ts runTurn/runSend).
//
// runSend.offer'ит кадры Btw.Part в unbounded-очередь, затем закрывает её.
// HTTP-handler оборачивает ту же очередь в Stream.fromQueue и кодирует как SSE.
// До фикса закрытие шло через Queue.shutdown — он финализирует interrupt'ом:
// последние text-delta / turn-end теряются, а стрим обрывается без нормального
// EOF. TUI не получал ни ответа, ни терминала и висел на «thinking…».
//
// Правильное завершение — Queue.end: дренит буфер и закрывает стрим нормальным
// Done. Эти тесты фиксируют инвариант, на который опирается btw, и упадут, если
// кто-то вернёт shutdown. Полная интеграция через SessionBtw.runSend здесь не
// гоняется: она требует всей графа сервисов Location (LLM, сессии, инстансы),
// а инвариант проверяется на тех же примитивах, которыми пользуется runSend.

describe("btw queue lifecycle", () => {
  test("Queue.end drains buffered tail for the consumer", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string, Cause.Done>()
        yield* Queue.offer(queue, "text-delta-1")
        yield* Queue.offer(queue, "text-delta-2")
        yield* Queue.offer(queue, "turn-end")
        yield* Queue.end(queue)
        return yield* Stream.runCollect(Stream.fromQueue(queue)).pipe(Effect.map((c) => Array.from(c)))
      }).pipe(Effect.scoped),
    )
    expect(collected).toEqual(["text-delta-1", "text-delta-2", "turn-end"])
  })

  // Контраст: Queue.shutdown прерывает consumer-а (interrupt), а не закрывает
  // стрим пустым результатом. В btw это значит, что SSE-стрим обрывается без
  // нормального EOF — клиент либо теряет кадры, либо видит разрыв соединения.
  // Это и есть природа исходного бага btw (висящий «thinking…»).
  test("Queue.shutdown interrupts the consumer — the regression", async () => {
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<string>()
          yield* Queue.offer(queue, "text-delta-1")
          yield* Queue.offer(queue, "text-delta-2")
          yield* Queue.offer(queue, "turn-end")
          yield* Queue.shutdown(queue)
          return yield* Stream.runCollect(Stream.fromQueue(queue)).pipe(Effect.map((c) => Array.from(c)))
        }).pipe(Effect.scoped),
      ),
    ).rejects.toThrow()
  })

  // Когда стрим падает на середине, терминальный (error-кадр), предложенный в
  // catchCause, должен дойти до consumer'а по порядку — после предшествующих
  // дельт и до закрытия очереди (Queue.end). Иначе обрыв транспорта маскировался
  // бы: клиент не получает ни ответа, ни терминала и видит пустой сброс.
  // Pipeline повторяет форму runTurn:
  // stream.pipe(Stream.tap(offer), Stream.runDrain, Effect.catchCause(offer)).
  test("stream catchCause terminal drained in order before Queue.end", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string, Cause.Done>()
        const failed = yield* Deferred.make<void>()
        const stream = Stream.fromIterable(["delta-a", "delta-b"]).pipe(
          Stream.concat(Stream.fail(new Error("transport drop"))),
          Stream.tap((c) => Queue.offer(queue, c)),
          Stream.runDrain,
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const squashed = Cause.squash(cause)
              const msg = squashed instanceof Error ? squashed.message : String(squashed)
              yield* Queue.offer(queue, "error:" + msg)
              yield* Deferred.succeed(failed, undefined)
            }),
          ),
        )
        yield* Effect.forkScoped(stream)
        yield* Deferred.await(failed)
        yield* Queue.end(queue)
        return yield* Stream.runCollect(Stream.fromQueue(queue)).pipe(Effect.map((c) => Array.from(c)))
      }).pipe(Effect.scoped),
    )
    expect(collected).toEqual(["delta-a", "delta-b", "error:transport drop"])
  })
})

// Abort-путь btw/abort: abort предлагает в activeQueue терминальный кадр (error)
// и завершает abort-deferred. runSend гонится с Deferred.await, поэтому победа
// последнего прерывает тур, ensuring срабатывает (busy=false, Queue.end).
// Клиент должен получить терминал и нормальный EOF (не прерывание стрима).
// Инвариант проверяется на тех же примитивах, что использует runSend:
// Effect.race(turn, Deferred.await(deferred)) + ensuring(Queue.end).
describe("btw abort via deferred race", () => {
  test("abort offers terminal, interrupts the turn, drains cleanly", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string, Cause.Done>()
        const abortDeferred = yield* Deferred.make<void>()
        const runLoopLike = Effect.never.pipe(Effect.ensuring(Queue.end(queue)))
        yield* Effect.forkScoped(Effect.race(runLoopLike, Deferred.await(abortDeferred)))

        // Consumer стартует конкурентно (как SSE-потребитель в HTTP-handler).
        const consumer = yield* Effect.forkScoped(
          Stream.runCollect(Stream.fromQueue(queue)).pipe(Effect.map((c) => Array.from(c))),
        )

        // Abort-path: offer терминала, затем завершение deferred.
        yield* Queue.offer(queue, "error:aborted")
        yield* Deferred.succeed(abortDeferred, undefined)
        return yield* Fiber.join(consumer)
      }).pipe(Effect.scoped),
    )
    expect(collected).toEqual(["error:aborted"])
  })
})
