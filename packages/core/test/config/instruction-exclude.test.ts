import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction"
import { Database } from "@opencode/core/database/database"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionStore } from "@opencode/core/session/store"
import { SessionProjector } from "@opencode/core/session/projector"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { tempGlobalLayer } from "../fixture/global"
import { location, tempLocationLayer } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { globalProjectNode } from "../lib/project"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const document = (fields: Record<string, unknown>) =>
  new Document({ type: "document", info: new Info(fields as ConstructorParameters<typeof Info>[0]) })

const instructionLayer = (input: {
  entries: Entry[]
  global?: string
  home?: string
  locationServiceLayer: Layer.Layer<Location.Service>
}) => {
  const watcher = Watcher.testLayer
  const config = Config.testLayer(input.entries)
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([
        InstructionDiscovery.node,
        Bus.node,
        Config.node,
        FSUtil.node,
        Global.node,
        Location.node,
        Watcher.node,
      ]),
      [
        Config.node.replace(config),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured()),
        Global.node.replace(
          input.global || input.home
            ? Global.layerWith({
                ...(input.global ? { config: input.global } : {}),
                ...(input.home ? { home: input.home } : {}),
              })
            : tempGlobalLayer,
        ),
        Location.node.replace(input.locationServiceLayer),
        Watcher.node.replace(watcher),
      ],
    ),
    watcher,
    config,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
      ),
    ),
  )
}

const projectLocation = (directory: string, project: string) =>
  Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }),
    ),
  )

const it = testEffect(Layer.empty)

const start = Effect.fnUntraced(function* () {
  yield* ConfigInstructionPlugin.Plugin.effect(host())
  const discovery = yield* InstructionDiscovery.Service
  const files = yield* discovery.list()
  return Array.isArray(files) ? files.map((file) => file.path) : []
})

const withTmp = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
)

describe("InstructionDiscovery.instructionsExclude", () => {
  it.live("root pattern excludes the root AGENTS.md from discovery", () =>
    withTmp.pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "AGENTS.md"), "# Root Instructions"))
          const paths = yield* start().pipe(
            Effect.provide(
              instructionLayer({
                entries: [document({ instructionsExclude: ["AGENTS.md"] })],
                locationServiceLayer: projectLocation(tmp.path, tmp.path),
              }),
            ),
          )
          expect(paths).toEqual([])
        }),
      ),
    ),
  )

  it.live("nested and recursive patterns exclude explicit instructions entries", () =>
    withTmp.pipe(
      Effect.flatMap((tmp) => {
        const project = path.join(tmp.path, "repo")
        const directory = path.join(project, "packages", "core")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(project, "docs"), { recursive: true })
            await fs.writeFile(path.join(project, "AGENTS.md"), "# Root")
            await fs.writeFile(path.join(project, "docs", "AGENTS.md"), "# Docs")
          })
          const paths = yield* start().pipe(
            Effect.provide(
              instructionLayer({
                entries: [document({ instructions: ["**/AGENTS.md"], instructionsExclude: ["docs/AGENTS.md"] })],
                locationServiceLayer: projectLocation(directory, project),
              }),
            ),
          )
          expect(paths).toEqual([path.join(project, "AGENTS.md")])
        })
      }),
    ),
  )

  it.live("exclude wins over an explicit instructions include", () =>
    withTmp.pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "extra.md"), "# Extra"))
          const paths = yield* start().pipe(
            Effect.provide(
              instructionLayer({
                entries: [document({ instructions: ["extra.md"], instructionsExclude: ["extra.md"] })],
                locationServiceLayer: projectLocation(tmp.path, tmp.path),
              }),
            ),
          )
          expect(paths).toEqual([])
        }),
      ),
    ),
  )

  it.live("home-relative pattern excludes the global instruction file", () =>
    withTmp.pipe(
      Effect.flatMap((tmp) => {
        const globalTmp = path.join(tmp.path, "global")
        const projectTmp = path.join(tmp.path, "project")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(globalTmp, { recursive: true })
            await fs.mkdir(projectTmp, { recursive: true })
            await fs.writeFile(path.join(globalTmp, "AGENTS.md"), "# Global Instructions")
          })
          const paths = yield* start().pipe(
            Effect.provide(
              instructionLayer({
                entries: [document({ instructionsExclude: ["~/AGENTS.md"] })],
                global: globalTmp,
                home: globalTmp,
                locationServiceLayer: projectLocation(projectTmp, projectTmp),
              }),
            ),
          )
          expect(paths).toEqual([])
        })
      }),
    ),
  )

  it.live("without instructionsExclude the explicit instructions entry is kept", () =>
    withTmp.pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "extra.md"), "# Extra"))
          const paths = yield* start().pipe(
            Effect.provide(
              instructionLayer({
                entries: [document({ instructions: ["extra.md"] })],
                locationServiceLayer: projectLocation(tmp.path, tmp.path),
              }),
            ),
          )
          expect(paths).toEqual([path.join(tmp.path, "extra.md")])
        }),
      ),
    ),
  )
})

// Walk-up attach: the read tool discovers nearby AGENTS.md files and hands them to
// SessionInstructions; exclusions must drop them before injection.
const walkUpConfig = Config.testLayer([])
const walkUpLayer = Layer.merge(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Location.node,
      FSUtil.node,
      SessionInstructions.node,
      Global.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Location.node.replace(tempLocationLayer),
      Config.node.replace(walkUpConfig),
    ],
  ),
  walkUpConfig,
)

const itWalkUp = testEffect(walkUpLayer)

describe("SessionInstructions.instructionsExclude", () => {
  itWalkUp.live("walk-up attach does not inject an excluded nearby file", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const docsPath = path.resolve(dir, "docs", "AGENTS.md")
      yield* Effect.promise(() => fs.mkdir(path.resolve(dir, "docs"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(docsPath, "# Docs"))

      const session = yield* Session.Service
      const sessionInstructions = yield* SessionInstructions.Service
      const store = yield* SessionStore.Service
      const bus = yield* Bus.Service
      const configTest = yield* Config.Test
      const published: unknown[][] = []
      yield* bus.subscribe(SessionEvent.Synthetic).pipe(
        Stream.mapEffect((event) =>
          Effect.sync(() => {
            published.push((event.data as { instruction?: { paths?: string[] } }).instruction?.paths ?? [])
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )

      // Control: without exclusions the nearby file is injected.
      const first = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id
      yield* sessionInstructions.load({ sessionID: first, paths: [docsPath] })
      expect((yield* store.context(first)).filter((message) => message.type === "synthetic")).toHaveLength(1)

      // Exclusions apply per config entries: a fresh session gets nothing.
      yield* configTest.setEntries([document({ instructionsExclude: ["docs/AGENTS.md"] })])
      const second = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id
      yield* sessionInstructions.load({ sessionID: second, paths: [docsPath] })
      expect(published).toHaveLength(1)
      expect((yield* store.context(second)).filter((message) => message.type === "synthetic")).toHaveLength(0)
    }),
  )
})
