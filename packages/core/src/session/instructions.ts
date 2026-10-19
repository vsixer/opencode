export * as SessionInstructions from "./instructions.js"

import { sep } from "path"
import { relative } from "path"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Location } from "../location.js"
import { SessionEvent } from "./event.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

const InjectedMetadata = Schema.Struct({
  instruction: Schema.Struct({ paths: Schema.Array(Schema.String) }),
})

export interface Interface {
  readonly load: (input: {
    readonly sessionID: SessionSchema.ID
    readonly paths: ReadonlyArray<string>
  }) => Effect.Effect<void, MessageDecodeError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const fs = yield* FSUtil.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    // Resolved once for the Location layer; the synthetic text and dedup ledger keep
    // absolute paths, but the human-facing description shows paths relative to the project
    // root so opening a subdirectory still describes paths from the project root.
    const root = yield* fs.resolve(location.project.directory)
    const directory = yield* fs.resolve(location.directory)
    // Exclude-паттерны применяются к walk-up-attach-путям до claim-регистрации:
    // исключённый файл не должен ни инъектироваться, ни попадать в ledger.
    // Конфиг и Global читаются опционально: в минимальных сборках их нет, и
    // фильтр там просто неактивен.
    const base = root === sep ? directory : root
    const applyExclusions = (paths: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
        const global = Option.getOrUndefined(yield* Effect.serviceOption(Global.Service))
        if (!global || !config) return paths
        const patterns = InstructionDiscovery.exclusionPatterns(yield* config.entries())
        if (patterns.length === 0) return paths
        const home = yield* fs.resolve(global.home)
        return paths.filter((path) => !InstructionDiscovery.excluded({ patterns, base, home, filepath: path }))
      })
    // Same-step parallel reads settle concurrently, so an in-memory claim guards each
    // Session/path pair while a load is in flight. The claim is released once the load
    // settles: the synthetic message metadata scanned below is the only lasting ledger,
    // so paths whose synthetics drop out of model-visible history (compaction, revert)
    // are re-discovered and re-injected instead of staying silently lost.
    const inFlight = yield* Ref.make<Map<SessionSchema.ID, Set<string>>>(new Map())

    const load = Effect.fn("SessionInstructions.load")(function* (input: Parameters<Interface["load"]>[0]) {
      const allowed = yield* applyExclusions(input.paths)
      const claimed = yield* Ref.modify(inFlight, (map) => {
        const existing = map.get(input.sessionID) ?? new Set<string>()
        const newlyClaimed = allowed.filter((path) => !existing.has(path))
        if (newlyClaimed.length === 0) return [newlyClaimed, map]
        const next = new Map(map)
        next.set(input.sessionID, new Set([...existing, ...newlyClaimed]))
        return [newlyClaimed, next]
      })
      if (claimed.length === 0) return
      yield* Effect.gen(function* () {
        const alreadyInjected = yield* previouslyInjected(store, input.sessionID)
        const toInject = claimed.filter((path) => !alreadyInjected.has(path))
        if (toInject.length === 0) return
        const files = yield* Effect.forEach(
          toInject,
          (path) =>
            fs
              .readFileStringSafe(path)
              .pipe(Effect.map((content) => (content === undefined ? undefined : { path, content }))),
          { concurrency: "unbounded" },
        )
        const readable = files.filter((file): file is { path: string; content: string } => file !== undefined)
        if (readable.length === 0) return
        // Publish directly rather than through Session.synthetic: a Location-scoped layer
        // cannot depend on Session (it routes through LocationServiceMap, forming a type
        // cycle with this node). The durable publish commits the synthetic and its metadata
        // ledger atomically, so releasing the claim afterwards cannot readmit the paths.
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          text: readable.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n"),
          description: `Loaded ${readable.map((file) => describePath(root, file.path)).join(", ")}`,
          metadata: { instruction: { paths: readable.map((file) => file.path) } },
        })
      }).pipe(
        Effect.ensuring(
          Ref.update(inFlight, (map) => {
            const existing = map.get(input.sessionID)
            if (!existing) return map
            const remaining = new Set([...existing].filter((path) => !claimed.includes(path)))
            const next = new Map(map)
            if (remaining.size === 0) next.delete(input.sessionID)
            else next.set(input.sessionID, remaining)
            return next
          }),
        ),
      )
    })

    return Service.of({ load })
  }),
)

function previouslyInjected(store: SessionStore.Interface, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const history = yield* store.context(sessionID)
    return new Set(
      history
        .filter((message): message is SessionMessage.Synthetic => message.type === "synthetic")
        .flatMap(
          (message) =>
            Option.getOrUndefined(Schema.decodeUnknownOption(InjectedMetadata)(message.metadata))?.instruction.paths ??
            [],
        ),
    )
  })
}

// Paths are normally discovered under the project root, so the description shows them
// relative to it. A directly-loaded path outside the root falls back to its absolute form
// rather than emitting `../..` chains.
function describePath(root: string, path: string) {
  return FSUtil.contains(root, path) ? relative(root, path) : path
}

export const node = makeLocationNode({
  name: "session-instructions",
  layer,
  deps: [Bus.node, FSUtil.node, Location.node, SessionStore.node],
})
