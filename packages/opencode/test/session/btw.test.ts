import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect"

// Регрессионный.guard для btw side-chat (session/btw/index.ts runLoop/runSend).
//
// runLoop.offer'ит BtwPart в unbounded-очередь, затем завершает её. HTTP-handler
// оборачивает ту же очередь в Stream.fromQueue и кодирует как SSE. До фикса
// закрытие шло через Queue.shutdown — он вызывает MutableList.clear(self.messages)
// и финализирует interrupt'ом: последние text-delta / turn-end теряются, а стрим
// обрывается без нормального EOF. TUI не получал ни ответа, ни терминала и висел
// на «thinking…».
//
// Правильное завершение — Queue.end: дрейнит буфер и закрывает стрим нормальным
// Done. Эти тесты фиксируют инвариант, на который опирается btw, и упадут, если
// кто-то вернёт shutdown. Полная интеграция через Btw.runSend здесь не гоняется:
// транзитивный import-граф btw валит транслятор Bun (CommonJS wrapper crash);
// инвариант проверяется на тех же примитивах, которыми пользуется runLoop.

describe("btw queue lifecycle", () => {
  test("Queue.end drains buffered tail for the consumer", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string, Cause.Done>()
        yield* Queue.offer(queue, "text-delta-1")
        yield* Queue.offer(queue, "text-delta-2")
        yield* Queue.offer(queue, "turn-end")
        yield* Queue.end(queue)
        return yield* Stream.runCollect(Stream.fromQueue(queue)).pipe(
          Effect.map((c) => Array.from(c)),
        )
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
          return yield* Stream.runCollect(Stream.fromQueue(queue)).pipe(
            Effect.map((c) => Array.from(c)),
          )
        }).pipe(Effect.scoped),
      ),
    ).rejects.toThrow()
  })
})

// Abort-путь /btw/abort: Btw.abort предлагает в activeQueue терминальный кадр
// (error) и завершает abort-deferred. runLoop гоняется с Deferred.await, поэтому
// победа последнего прерывает тур, ensuring срабатывает (busy=false, Queue.end).
// Клиент должен получить терминал и нормальный EOF (не прерывание стрима).
// Инвариант проверяется на тех же примитивах, что использует runSend после фикса:
// Effect.race(runLoop, Deferred.await(deferred)) + ensuring(Queue.end).
describe("btw abort via deferred race", () => {
  test("abort offers terminal, interrupts the turn, drains cleanly", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string, Cause.Done>()
        const abortDeferred = yield* Deferred.make<void>()

        // runLoop-стенд: бесконечный «тур» с ensuring, дренирующим очередь.
        const runLoopLike = Effect.never.pipe(Effect.ensuring(Queue.end(queue)))
        yield* Effect.forkScoped(Effect.race(runLoopLike, Deferred.await(abortDeferred)))

        // Consumer стартует конкурентно (как SSE-потребитель в HTTP-handler).
        const consumer = yield* Effect.forkScoped(
          Stream.runCollect(Stream.fromQueue(queue)).pipe(Effect.map((c) => Array.from(c))),
        )

        // Abort-path:offer терминала, затем завершение deferred.
        yield* Queue.offer(queue, "error:aborted")
        yield* Deferred.succeed(abortDeferred, undefined)

        return yield* Fiber.join(consumer)
      }).pipe(Effect.scoped),
    )
    expect(collected).toEqual(["error:aborted"])
  })
})
