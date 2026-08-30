import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ConfigAgentModels } from "@/config/agent-models"
import type { ConfigMerge } from "@/config/merge"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { InstanceRuntime } from "@/project/instance-runtime"
import { disposeInstance } from "@/effect/instance-registry"
import type { InstanceContext } from "@/project/instance-context"
import { applyCommandReasoning } from "@/session/llm/request"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const configLayer = () =>
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
  ])

const layer = configLayer()
const it = testEffect(layer)

const clear = () =>
  Effect.runPromise(
    Config.use
      .invalidate()
      .pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())),
      ),
  )

beforeEach(clear)
afterEach(clear)

// --- helpers ------------------------------------------------------------------

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-models-test-"))
}

function def(frontmatter: Record<string, unknown>, source: string): ConfigMerge.Definition {
  return { frontmatter: { ...frontmatter }, body: "body", source, layer: "project" }
}

function instance(directory: string): InstanceContext {
  return {
    directory,
    worktree: directory,
    project: {
      id: ProjectV2.ID.make(directory),
      worktree: directory,
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
  }
}

function writeRegistry(dir: string, text: string, name = "agent-models.jsonc") {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const registryText = (obj: unknown) => JSON.stringify(obj, null, 2)

function withEnv<T>(key: string, value: string | undefined, fn: () => T): Promise<T> {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  const restore = () => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
  return Promise.resolve()
    .then(fn)
    .then(
      (r) => (restore(), r),
      (e) => {
        restore()
        throw e
      },
    )
}

const apply = (defs: ConfigMerge.Definition[], registry: unknown) =>
  Effect.runPromise(ConfigAgentModels.applyRegistry(defs, registry as ConfigAgentModels.Registry))

// Effect.fn расширяет литеральные типы статуса до string — приводим к контрактному союзу.
const load = (ctx: InstanceContext) =>
  Effect.runPromise(ConfigAgentModels.loadRegistry(ctx)) as Promise<ConfigAgentModels.LoadedRegistry>

// --- unit: applyRegistry ------------------------------------------------------

describe("unit: applyRegistry", () => {
  const dir = tmp()
  const src = (rel: string) => path.join(dir, rel)
  const base = {
    prefixes: { p: dir },
    models: {
      m1: { model: "prov/m1", reasoning: { "0": "none", "1": "low", "2": "high" } },
      m2: { model: "prov/m2", reasoning: { "1": "medium" } },
      m3: { model: "other/m3" },
    },
    capabilities: { cap: ["m1"], twocap: ["m1", "m2"], groupcap: ["m1", "m3"] },
    roles: {},
    providerGroups: {},
    availability: { disabledProviders: [], disabledModels: [] },
  }

  test("assigns model and reasoning level to canonical key", async () => {
    const d = def({}, src("agent/x.md"))
    await apply([d], { ...base, roles: { "p:agent/x.md": "cap:2" } })
    expect(d.frontmatter.model).toBe("prov/m1")
    expect(d.frontmatter.reasoningEffort).toBe("high")
  })

  test("shortened key without segment and extension matches (B3)", async () => {
    const d = def({}, src("agent/review/primary.md"))
    await apply([d], { ...base, roles: { "p:review/primary": "cap" } })
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("non-empty frontmatter model suppresses assignment entirely (A2)", async () => {
    const d = def({ model: "keep/me" }, src("agent/x.md"))
    await apply([d], { ...base, roles: { "p:agent/x.md": "cap:2" } })
    expect(d.frontmatter.model).toBe("keep/me")
    expect(d.frontmatter.reasoningEffort).toBeUndefined()
  })

  test("empty model string is treated as absent (A3)", async () => {
    const d = def({ model: "" }, src("agent/x.md"))
    await apply([d], { ...base, roles: { "p:agent/x.md": "cap" } })
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("role without :N assigns model without reasoning (A5)", async () => {
    const d = def({}, src("agent/x.md"))
    await apply([d], { ...base, roles: { "p:agent/x.md": "cap" } })
    expect(d.frontmatter.model).toBe("prov/m1")
    expect(d.frontmatter.reasoningEffort).toBeUndefined()
  })

  test("reasoning quirks: cap: equals cap:0, cap:01 is 1 (B1)", async () => {
    const a = def({}, src("agent/a.md"))
    const b = def({}, src("agent/b.md"))
    await apply([a, b], { ...base, roles: { "p:agent/a.md": "cap:", "p:agent/b.md": "cap:01" } })
    expect(a.frontmatter.reasoningEffort).toBe("none")
    expect(b.frontmatter.reasoningEffort).toBe("low")
  })

  test("non-numeric and negative levels leave role unresolved (B1)", async () => {
    const a = def({}, src("agent/a.md"))
    const b = def({}, src("agent/b.md"))
    await apply([a, b], { ...base, roles: { "p:agent/a.md": "cap:abc", "p:agent/b.md": "cap:-1" } })
    expect(a.frontmatter.model).toBeUndefined()
    expect(b.frontmatter.model).toBeUndefined()
  })

  test("reasoning comes from the selected candidate mapping (A6)", async () => {
    const d = def({}, src("command/c.md"))
    await apply(
      [d],
      {
        ...base,
        roles: { "p:command/c.md": "twocap:1" },
        availability: { disabledProviders: [], disabledModels: ["m1"] },
      },
    )
    expect(d.frontmatter.model).toBe("prov/m2")
    expect(d.frontmatter.reasoningEffort).toBe("medium")
  })

  test("providerGroups expand one level for availability (A7)", async () => {
    const d = def({}, src("command/c.md"))
    await apply(
      [d],
      {
        ...base,
        roles: { "p:command/c.md": "groupcap" },
        providerGroups: { cloud: ["prov"] },
        availability: { disabledProviders: ["cloud"], disabledModels: [] },
      },
    )
    expect(d.frontmatter.model).toBe("other/m3")
  })

  test("STRICT-ABORT: broken candidate forbids fallback to next (N3, N4)", async () => {
    const d = def({}, src("command/c.md"))
    await apply(
      [d],
      {
        ...base,
        models: { m1: "", m2: { model: "prov/m2" } },
        roles: { "p:command/c.md": "twocap" },
      },
    )
    expect(d.frontmatter.model).toBeUndefined()
  })

  test("all candidates disabled leaves role unresolved (N5)", async () => {
    const d = def({}, src("command/c.md"))
    await apply(
      [d],
      {
        ...base,
        roles: { "p:command/c.md": "twocap" },
        availability: { disabledProviders: ["prov"], disabledModels: [] },
      },
    )
    expect(d.frontmatter.model).toBeUndefined()
  })

  test("loose mode: model applies without reasoning (N6)", async () => {
    const a = def({}, src("agent/a.md"))
    const b = def({}, src("agent/b.md"))
    await apply([a, b], {
      ...base,
      models: { m1: "prov/m1" },
      roles: { "p:agent/a.md": "cap:2", "p:agent/b.md": "cap:9" },
    })
    expect(a.frontmatter.model).toBe("prov/m1")
    expect(a.frontmatter.reasoningEffort).toBeUndefined()
    expect(b.frontmatter.model).toBe("prov/m1")
    expect(b.frontmatter.reasoningEffort).toBeUndefined()
  })

  test("two roles on one file: first wins (duplicate-role)", async () => {
    const d = def({}, src("agent/x.md"))
    await apply([d], {
      ...base,
      models: { ...base.models, m2: { model: "prov/m2" } },
      roles: { "p:agent/x.md": "cap", "p:x": "twocap" },
    })
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("unknown prefix, backslash and unknown capability skip only their role (N7)", async () => {
    const good = def({}, src("agent/good.md"))
    await apply(
      [good],
      {
        ...base,
        roles: {
          "nope:agent/good.md": "cap",
          "p:agent\\good.md": "cap",
          "p:agent/good.md2": "missing",
          "p:agent/good.md": "cap:1",
        },
      },
    )
    expect(good.frontmatter.model).toBe("prov/m1")
    expect(good.frontmatter.reasoningEffort).toBe("low")
  })

  test("global analog suppresses assignment (R1) and is skipped without prefixes.global (R3)", async () => {
    const global = tmp()
    fs.mkdirSync(path.join(global, "agents"), { recursive: true })
    fs.writeFileSync(path.join(global, "agents", "x.md"), "global")

    const suppressed = def({}, src("agent/x.md"))
    await apply([suppressed], { ...base, prefixes: { p: dir, global }, roles: { "p:agent/x.md": "cap" } })
    expect(suppressed.frontmatter.model).toBeUndefined()

    const free = def({}, src("agent/x.md"))
    await apply([free], { ...base, roles: { "p:agent/x.md": "cap" } })
    expect(free.frontmatter.model).toBe("prov/m1")
  })

  test("global analog with explicit model keeps the model (R2)", async () => {
    const global = tmp()
    fs.mkdirSync(path.join(global, "agents"), { recursive: true })
    fs.writeFileSync(path.join(global, "agents", "x.md"), "global")
    const d = def({ model: "explicit/model" }, src("agent/x.md"))
    await apply([d], { ...base, prefixes: { p: dir, global }, roles: { "p:agent/x.md": "cap" } })
    expect(d.frontmatter.model).toBe("explicit/model")
    expect(d.frontmatter.reasoningEffort).toBeUndefined()
  })
})

// --- unit: loadRegistry -------------------------------------------------------

describe("unit: loadRegistry", () => {
  const loadNoEnv = (ctx: InstanceContext) => withEnv("OPENCODE_AGENT_MODELS", undefined, () => load(ctx))

  test("env pointing to a missing path, empty string or directory continues the chain (N8)", async () => {
    const dir = tmp()
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: { "p:agent/x.md": "cap" } }))
    const ctx = instance(dir)
    const expectProjectLoaded = async (loaded: ConfigAgentModels.LoadedRegistry) => {
      expect(loaded.status).toBe("ok")
      if (loaded.status !== "ok") return
      expect(loaded.registry.roles["p:agent/x.md"]).toBe("cap")
    }

    await withEnv("OPENCODE_AGENT_MODELS", path.join(dir, "missing.jsonc"), async () => {
      await expectProjectLoaded(await load(ctx))
    })
    await withEnv("OPENCODE_AGENT_MODELS", "", async () => {
      await expectProjectLoaded(await load(ctx))
    })
    await withEnv("OPENCODE_AGENT_MODELS", dir, async () => {
      await expectProjectLoaded(await load(ctx))
    })
    await withEnv("OPENCODE_AGENT_MODELS", undefined, async () => {
      await expectProjectLoaded(await load(ctx))
    })
  })

  test("first found file wins, no cross-file merge (B5)", async () => {
    const dir = tmp()
    const envFile = writeRegistry(dir, registryText({ availability: { disabledProviders: ["x"] } }), "env.jsonc")
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: {} }))
    await withEnv("OPENCODE_AGENT_MODELS", envFile, async () => {
      const loaded = await load(instance(dir))
      expect(loaded.status).toBe("ok")
      if (loaded.status !== "ok") return
      expect(loaded.registry.availability.disabledProviders).toEqual(["x"])
      expect(Object.keys(loaded.registry.roles)).toEqual([])
    })
  })

  test("empty registry is a quiet no-op (B6)", async () => {
    const dir = tmp()
    writeRegistry(path.join(dir, ".opencode", "config"), "// comments only\n")
    const loaded = await loadNoEnv(instance(dir))
    expect(loaded.status).toBe("ok")
    if (loaded.status !== "ok") return
    expect(loaded.registry.roles).toEqual({})
  })

  test("duplicate role keys: JSONC parser is last-wins (B2)", async () => {
    const dir = tmp()
    writeRegistry(
      path.join(dir, ".opencode", "config"),
      registryText({ roles: { "p:agent/x.md": "cap:1" } }).replace(
        /}\s*$/,
        `, "roles": { "p:agent/x.md": "cap:2" } }`,
      ),
    )
    const loaded = await loadNoEnv(instance(dir))
    if (loaded.status !== "ok") throw new Error("expected ok")
    expect(loaded.registry.roles["p:agent/x.md"]).toBe("cap:2")
  })

  test("broken base disables the layer without fallback (N1)", async () => {
    const dir = tmp()
    const envFile = writeRegistry(dir, "{ broken", "env.jsonc")
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: {} }))
    await withEnv("OPENCODE_AGENT_MODELS", envFile, async () => {
      expect((await load(instance(dir))).status).toBe("disabled")
    })
  })

  test("overlay concatenates disabled lists, ignores foreign keys and non-arrays (B4, N2)", async () => {
    const dir = tmp()
    const configDir = path.join(dir, ".opencode", "config")
    writeRegistry(configDir, registryText({ availability: { disabledProviders: ["a"], disabledModels: ["m"] } }))
    writeRegistry(
      configDir,
      registryText({ availability: { disabledProviders: ["b"], disabledModels: ["m"], weird: 1, prefixes: 1 } }),
      "agent-models.local.jsonc",
    )
    const loaded = await loadNoEnv(instance(dir))
    if (loaded.status !== "ok") throw new Error("expected ok")
    expect(loaded.registry.availability.disabledProviders).toEqual(["a", "b"])
    expect(loaded.registry.availability.disabledModels).toEqual(["m", "m"])

    writeRegistry(configDir, "nope", "agent-models.local.jsonc")
    const broken = await loadNoEnv(instance(dir))
    if (broken.status !== "ok") throw new Error("expected ok")
    expect(broken.registry.availability.disabledProviders).toEqual(["a"])
  })

  test("overlay accepts root-level disabled lists written by external tooling (B4)", async () => {
    const dir = tmp()
    const configDir = path.join(dir, ".opencode", "config")
    writeRegistry(configDir, registryText({ availability: { disabledProviders: ["a"] } }))
    writeRegistry(configDir, JSON.stringify({ disabledProviders: ["b"], disabledModels: ["m"] }), "agent-models.local.jsonc")
    const loaded = await loadNoEnv(instance(dir))
    if (loaded.status !== "ok") throw new Error("expected ok")
    expect(loaded.registry.availability.disabledProviders).toEqual(["a", "b"])
    expect(loaded.registry.availability.disabledModels).toEqual(["m"])
  })
})

// --- command reasoning merge --------------------------------------------------

describe("command reasoning pipeline", () => {
  test("command reasoning overrides agent options and variants, undefined does not clobber", () => {
    const withAgentReasoning = { reasoningEffort: "agent" }
    applyCommandReasoning(withAgentReasoning, "high", false)
    expect(withAgentReasoning.reasoningEffort).toBe("high")

    const agentOnly = { reasoningEffort: "agent" }
    applyCommandReasoning(agentOnly, undefined, false)
    expect(agentOnly.reasoningEffort).toBe("agent")

    const small = { reasoningEffort: "agent" }
    applyCommandReasoning(small, "high", true)
    expect(small.reasoningEffort).toBe("agent")
  })
})

// --- integration: config pipeline ---------------------------------------------

const AGENT_MD = `---
description: registry driven agent
---
You are a test agent.
`

const COMMAND_MD = `---
description: registry driven command
reasoningEffort: handwritten
---
Do the thing $ARGUMENTS.
`

function writeProjectFiles(dir: string, registry: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, ".opencode", "agent"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".opencode", "command"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".opencode", "agent", "x.md"), AGENT_MD)
  fs.writeFileSync(path.join(dir, ".opencode", "command", "c.md"), COMMAND_MD)
  writeRegistry(
    path.join(dir, ".opencode", "config"),
    registryText({
      prefixes: { project: path.join(dir, ".opencode") },
      models: { m1: { model: "prov/m1", reasoning: { "2": "high" } } },
      capabilities: { cap: ["m1"] },
      ...registry,
    }),
  )
}

describe("integration: config pipeline", () => {
  it.instance("registry assigns model and reasoning to agent and command (A1, strip, A5)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      writeProjectFiles(test.directory, {
        roles: { "project:agent/x.md": "cap:2", "project:command/c.md": "cap" },
      })
      const config = yield* Config.use.get()
      const agent = config.agent?.["x"]
      expect(agent?.model).toBe("prov/m1")
      expect((agent?.options as Record<string, unknown>)?.reasoningEffort).toBe("high")
      const command = config.command?.["c"]
      expect(command?.model).toBe("prov/m1")
      expect(command?.reasoningEffort).toBeUndefined()
    }),
  )

  it.instance("registry role with :N sets command reasoningEffort", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      writeProjectFiles(test.directory, { roles: { "project:command/c.md": "cap:2" } })
      const config = yield* Config.use.get()
      expect(config.command?.["c"]?.reasoningEffort).toBe("high")
    }),
  )

  it.instance("registry assignment beats json agent section (A4)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      writeProjectFiles(test.directory, { roles: { "project:agent/x.md": "cap" } })
      fs.writeFileSync(
        path.join(test.directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { x: { model: "json/model" } } }),
      )
      const config = yield* Config.use.get()
      expect(config.agent?.["x"]?.model).toBe("prov/m1")
    }),
  )
})

// --- reload -------------------------------------------------------------------

// ScopedCache конфига живёт в InstanceState; его инвалидация зарегистрирована
// через instance-registry disposer по directory — это и есть канал /reload.
const reload = (directory: string) => Effect.promise(() => disposeInstance(directory))

describe("reload", () => {
  it.instance("config reload picks up registry edits (A10)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      writeProjectFiles(test.directory, { roles: { "project:agent/x.md": "cap" } })
      const first = yield* Config.use.get()
      expect(first.agent?.["x"]?.model).toBe("prov/m1")

      writeProjectFiles(test.directory, {
        roles: { "project:agent/x.md": "cap" },
        models: { m2: { model: "prov/m2" } },
        capabilities: { cap: ["m2"] },
      })
      yield* reload(test.directory)
      const second = yield* Config.use.get()
      expect(second.agent?.["x"]?.model).toBe("prov/m2")
    }),
  )

  it.instance("removing the overlay re-enables the model after reload (A11)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      writeProjectFiles(test.directory, { roles: { "project:agent/x.md": "cap" } })
      writeRegistry(
        path.join(test.directory, ".opencode", "config"),
        registryText({ availability: { disabledModels: ["m1"] } }),
        "agent-models.local.jsonc",
      )
      yield* reload(test.directory)
      const disabled = yield* Config.use.get()
      expect(disabled.agent?.["x"]?.model).toBeUndefined()

      fs.rmSync(path.join(test.directory, ".opencode", "config", "agent-models.local.jsonc"))
      yield* reload(test.directory)
      const enabled = yield* Config.use.get()
      expect(enabled.agent?.["x"]?.model).toBe("prov/m1")
    }),
  )
})
