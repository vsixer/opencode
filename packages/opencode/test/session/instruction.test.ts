import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const instructionLayer = (
  global: Partial<Global.Interface>,
  flags: Partial<RuntimeFlags.Info> = {},
  configOverrides: Partial<Config.Interface> = {},
) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make(configOverrides))],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>, configOverrides?: Partial<Config.Interface>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags, configOverrides)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  withFilesConfig(files, {}, self)

const withFilesConfig = <A, E, R>(
  files: Record<string, string>,
  configOverrides: Partial<Config.Interface>,
  self: (dir: string) => Effect.Effect<A, E, R>,
) =>
  // git-репозиторий даёт worktree = корню tmpdir; без git worktree = "/" и
  // include-паттерны с ** уходит в glob по всей корневой ФС.
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* writeFiles(dir, files)
        return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }, undefined, configOverrides))
      }),
    { git: true },
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

describe("Instruction.instructionsExclude", () => {
  it.live("root pattern excludes the root AGENTS.md from systemPaths", () =>
    withFilesConfig({ "AGENTS.md": "# Root Instructions" }, { get: () => Effect.succeed({ instructionsExclude: ["AGENTS.md"] }) }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(dir, "AGENTS.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }),
    ),
  )

  it.live("nested and recursive patterns exclude explicit instructions entries", () =>
    withFilesConfig(
      { "AGENTS.md": "# Root", "docs/AGENTS.md": "# Docs" },
      {
        get: () =>
          Effect.succeed({ instructions: ["**/AGENTS.md"], instructionsExclude: ["docs/AGENTS.md"] }),
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const paths = yield* svc.systemPaths()
          expect(paths.has(path.join(dir, "docs", "AGENTS.md"))).toBe(false)
        }),
    ),
  )

  it.live("exclude wins over explicit instructions include", () =>
    withFilesConfig(
      { "extra.md": "# Extra" },
      {
        get: () =>
          Effect.succeed({ instructions: ["extra.md"], instructionsExclude: ["extra.md"] }),
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const paths = yield* svc.systemPaths()
          expect(paths.has(path.join(dir, "extra.md"))).toBe(false)
        }),
    ),
  )

  it.live("home-relative pattern excludes the global instruction file", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(false)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
          get: () => Effect.succeed({ instructionsExclude: ["~/AGENTS.md"] }),
        }),
      )
    }),
  )

  it.live("resolve walk-up does not attach an excluded nearby file", () =>
    withFilesConfig(
      { "AGENTS.md": "# Root", "docs/AGENTS.md": "# Docs", "docs/file.ts": "const x = 1" },
      { get: () => Effect.succeed({ instructionsExclude: ["docs/AGENTS.md"] }) },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const paths = yield* svc.systemPaths()
          expect(paths.has(path.join(dir, "docs", "AGENTS.md"))).toBe(false)

          const results = yield* svc.resolve([], path.join(dir, "docs", "file.ts"), MessageID.make("msg_message-exclude-1"))
          expect(results).toEqual([])
        }),
    ),
  )

  it.live("without instructionsExclude the explicit instructions entry is kept", () =>
    withFilesConfig(
      { "extra.md": "# Extra" },
      { get: () => Effect.succeed({ instructions: ["extra.md"] }) },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const paths = yield* svc.systemPaths()
          expect(paths.has(path.join(dir, "extra.md"))).toBe(true)
        }),
    ),
  )
})
