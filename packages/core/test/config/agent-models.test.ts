import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { ConfigAgentModels } from "@opencode/core/config/agent-models"
import type { ConfigMerge } from "@opencode/core/config/merge"

// --- helpers ------------------------------------------------------------------

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-agent-models-")))
}

function def(frontmatter: Record<string, unknown>, source: string): ConfigMerge.Definition {
  return { frontmatter, body: "", source }
}

function registryText(fields: Record<string, unknown>) {
  return JSON.stringify({
    prefixes: {},
    models: {},
    capabilities: {},
    roles: {},
    ...fields,
  })
}

function writeRegistry(directory: string, text: string, name = "agent-models.jsonc") {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, name)
  fs.writeFileSync(file, text)
  return file
}

async function withEnv<T>(key: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

const runApply = (defs: ConfigMerge.Definition[], registry: ConfigAgentModels.Registry, home: string) =>
  Effect.runPromise(ConfigAgentModels.applyRegistry(defs, registry, home))

const runLoad = (input: {
  worktree: string
  directory: string
  globalConfig: string
  configPath?: string
}): Promise<ConfigAgentModels.LoadedRegistry> =>
  Effect.runPromise(ConfigAgentModels.loadRegistry(input)) as Promise<ConfigAgentModels.LoadedRegistry>

const runBuiltin = (section: Record<string, unknown>, registry: ConfigAgentModels.Registry) =>
  Effect.runPromise(ConfigAgentModels.applyBuiltinRoles(section, registry))

// --- unit: applyRegistry ------------------------------------------------------

describe("unit: applyRegistry", () => {
  const dir = tmp()
  const home = tmp()
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
    force: false,
  }

  test("assigns model and reasoning level to canonical key", async () => {
    const d = def({}, src("agent/x.md"))
    await runApply([d], { ...base, roles: { "p:agent/x.md": "cap:2" } }, home)
    expect(d.frontmatter.model).toBe("prov/m1")
    expect(d.frontmatter.reasoningEffort).toBe("high")
  })

  test("shortened key without segment and extension matches", async () => {
    const d = def({}, src("agent/review/primary.md"))
    await runApply([d], { ...base, roles: { "p:review/primary": "cap" } }, home)
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("non-empty frontmatter model suppresses assignment entirely", async () => {
    const d = def({ model: "keep/me" }, src("agent/x.md"))
    await runApply([d], { ...base, roles: { "p:agent/x.md": "cap:2" } }, home)
    expect(d.frontmatter.model).toBe("keep/me")
    expect(d.frontmatter.reasoningEffort).toBeUndefined()
  })

  test("force overrides baked frontmatter model", async () => {
    const d = def({ model: "baked/cloud-model", reasoningEffort: "max" }, src("agent/x.md"))
    await runApply([d], { ...base, roles: { "p:agent/x.md": "cap" }, force: true }, home)
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("empty model string is treated as absent", async () => {
    const d = def({ model: "" }, src("agent/x.md"))
    await runApply([d], { ...base, roles: { "p:agent/x.md": "cap" } }, home)
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("role without :N assigns model without reasoning", async () => {
    const d = def({}, src("agent/x.md"))
    await runApply([d], { ...base, roles: { "p:agent/x.md": "cap" } }, home)
    expect(d.frontmatter.model).toBe("prov/m1")
    expect(d.frontmatter.reasoningEffort).toBeUndefined()
  })

  test("reasoning quirks: cap: equals cap:0, cap:01 is 1", async () => {
    const a = def({}, src("agent/a.md"))
    const b = def({}, src("agent/b.md"))
    await runApply([a, b], { ...base, roles: { "p:agent/a.md": "cap:", "p:agent/b.md": "cap:01" } }, home)
    expect(a.frontmatter.reasoningEffort).toBe("none")
    expect(b.frontmatter.reasoningEffort).toBe("low")
  })

  test("non-numeric and negative levels leave role unresolved", async () => {
    const a = def({}, src("agent/a.md"))
    const b = def({}, src("agent/b.md"))
    await runApply([a, b], { ...base, roles: { "p:agent/a.md": "cap:abc", "p:agent/b.md": "cap:-1" } }, home)
    expect(a.frontmatter.model).toBeUndefined()
    expect(b.frontmatter.model).toBeUndefined()
  })

  test("reasoning comes from the selected candidate mapping", async () => {
    const d = def({}, src("command/c.md"))
    await runApply(
      [d],
      {
        ...base,
        roles: { "p:command/c.md": "twocap:1" },
        availability: { disabledProviders: [], disabledModels: ["m1"] },
      },
      home,
    )
    expect(d.frontmatter.model).toBe("prov/m2")
    expect(d.frontmatter.reasoningEffort).toBe("medium")
  })

  test("providerGroups expand one level for availability", async () => {
    const d = def({}, src("command/c.md"))
    await runApply(
      [d],
      {
        ...base,
        roles: { "p:command/c.md": "groupcap" },
        providerGroups: { cloud: ["prov"] },
        availability: { disabledProviders: ["cloud"], disabledModels: [] },
      },
      home,
    )
    expect(d.frontmatter.model).toBe("other/m3")
  })

  test("broken candidate forbids fallback to next", async () => {
    const d = def({}, src("command/c.md"))
    await runApply(
      [d],
      {
        ...base,
        models: { m1: "", m2: { model: "prov/m2" } },
        roles: { "p:command/c.md": "twocap" },
      },
      home,
    )
    expect(d.frontmatter.model).toBeUndefined()
  })

  test("all candidates disabled leaves role unresolved", async () => {
    const d = def({}, src("command/c.md"))
    await runApply(
      [d],
      {
        ...base,
        roles: { "p:command/c.md": "twocap" },
        availability: { disabledProviders: ["prov"], disabledModels: [] },
      },
      home,
    )
    expect(d.frontmatter.model).toBeUndefined()
  })

  test("loose mode: model applies without reasoning", async () => {
    const a = def({}, src("agent/a.md"))
    const b = def({}, src("agent/b.md"))
    await runApply(
      [a, b],
      {
        ...base,
        models: { m1: "prov/m1" },
        roles: { "p:agent/a.md": "cap:2", "p:agent/b.md": "cap:9" },
      },
      home,
    )
    expect(a.frontmatter.model).toBe("prov/m1")
    expect(a.frontmatter.reasoningEffort).toBeUndefined()
    expect(b.frontmatter.model).toBe("prov/m1")
    expect(b.frontmatter.reasoningEffort).toBeUndefined()
  })

  test("two roles on one file: first wins", async () => {
    const d = def({}, src("agent/x.md"))
    await runApply(
      [d],
      {
        ...base,
        models: { ...base.models, m2: { model: "prov/m2" } },
        roles: { "p:agent/x.md": "cap", "p:x": "twocap" },
      },
      home,
    )
    expect(d.frontmatter.model).toBe("prov/m1")
  })

  test("unknown prefix, backslash and unknown capability skip only their role", async () => {
    const good = def({}, src("agent/good.md"))
    await runApply(
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
      home,
    )
    expect(good.frontmatter.model).toBe("prov/m1")
    expect(good.frontmatter.reasoningEffort).toBe("low")
  })

  test("global analog suppresses assignment and is skipped without prefixes.global", async () => {
    const global = tmp()
    fs.mkdirSync(path.join(global, "agents"), { recursive: true })
    fs.writeFileSync(path.join(global, "agents", "x.md"), "global")

    const suppressed = def({}, src("agent/x.md"))
    await runApply([suppressed], { ...base, prefixes: { p: dir, global }, roles: { "p:agent/x.md": "cap" } }, home)
    expect(suppressed.frontmatter.model).toBeUndefined()

    const free = def({}, src("agent/x.md"))
    await runApply([free], { ...base, roles: { "p:agent/x.md": "cap" } }, home)
    expect(free.frontmatter.model).toBe("prov/m1")
  })

  test("global analog with explicit model keeps the model", async () => {
    const global = tmp()
    fs.mkdirSync(path.join(global, "agents"), { recursive: true })
    fs.writeFileSync(path.join(global, "agents", "x.md"), "global")
    const d = def({ model: "explicit/model" }, src("agent/x.md"))
    await runApply([d], { ...base, prefixes: { p: dir, global }, roles: { "p:agent/x.md": "cap" } }, home)
    expect(d.frontmatter.model).toBe("explicit/model")
    expect(d.frontmatter.reasoningEffort).toBeUndefined()
  })
})

// --- unit: loadRegistry -------------------------------------------------------

describe("unit: loadRegistry", () => {
  const loadNoEnv = (input: { worktree: string; directory: string; globalConfig: string; configPath?: string }) =>
    withEnv("OPENCODE_AGENT_MODELS", undefined, () => runLoad(input))

  test("env pointing to a missing path, empty string or directory continues the chain", async () => {
    const dir = tmp()
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: { "p:agent/x.md": "cap" } }))
    const input = { worktree: dir, directory: dir, globalConfig: path.join(dir, "global") }
    const expectProjectLoaded = async (loaded: ConfigAgentModels.LoadedRegistry) => {
      expect(loaded.status).toBe("ok")
      if (loaded.status !== "ok") return
      expect(loaded.registry.roles["p:agent/x.md"]).toBe("cap")
    }

    await withEnv("OPENCODE_AGENT_MODELS", path.join(dir, "missing.jsonc"), async () => {
      await expectProjectLoaded(await runLoad(input))
    })
    await withEnv("OPENCODE_AGENT_MODELS", "", async () => {
      await expectProjectLoaded(await runLoad(input))
    })
    await withEnv("OPENCODE_AGENT_MODELS", dir, async () => {
      await expectProjectLoaded(await runLoad(input))
    })
    await withEnv("OPENCODE_AGENT_MODELS", undefined, async () => {
      await expectProjectLoaded(await runLoad(input))
    })
  })

  test("first found file wins, no cross-file merge", async () => {
    const dir = tmp()
    const envFile = writeRegistry(dir, registryText({ availability: { disabledProviders: ["x"] } }), "env.jsonc")
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: {} }))
    await withEnv("OPENCODE_AGENT_MODELS", envFile, async () => {
      const loaded = await runLoad({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
      expect(loaded.status).toBe("ok")
      if (loaded.status !== "ok") return
      expect(loaded.registry.availability.disabledProviders).toEqual(["x"])
      expect(Object.keys(loaded.registry.roles)).toEqual([])
    })
  })

  test("empty registry is a quiet no-op", async () => {
    const dir = tmp()
    writeRegistry(path.join(dir, ".opencode", "config"), "// comments only\n")
    const loaded = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    expect(loaded.status).toBe("ok")
    if (loaded.status !== "ok") return
    expect(loaded.registry.roles).toEqual({})
  })

  test("duplicate role keys: JSONC parser is last-wins", async () => {
    const dir = tmp()
    writeRegistry(
      path.join(dir, ".opencode", "config"),
      registryText({ roles: { "p:agent/x.md": "cap:1" } }).replace(/}\s*$/, `, "roles": { "p:agent/x.md": "cap:2" } }`),
    )
    const loaded = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    if (loaded.status !== "ok") throw new Error("expected ok")
    expect(loaded.registry.roles["p:agent/x.md"]).toBe("cap:2")
  })

  test("broken base disables the layer without fallback", async () => {
    const dir = tmp()
    const envFile = writeRegistry(dir, "{ broken", "env.jsonc")
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: {} }))
    await withEnv("OPENCODE_AGENT_MODELS", envFile, async () => {
      const loaded = await runLoad({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
      expect(loaded.status).toBe("disabled")
    })
  })

  test("overlay concatenates disabled lists, ignores foreign keys and non-arrays", async () => {
    const dir = tmp()
    const configDir = path.join(dir, ".opencode", "config")
    writeRegistry(configDir, registryText({ availability: { disabledProviders: ["a"], disabledModels: ["m"] } }))
    writeRegistry(
      configDir,
      registryText({ availability: { disabledProviders: ["b"], disabledModels: ["m"], weird: 1, prefixes: 1 } }),
      "agent-models.disabled.jsonc",
    )
    const loaded = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    if (loaded.status !== "ok") throw new Error("expected ok")
    expect(loaded.registry.availability.disabledProviders).toEqual(["a", "b"])
    expect(loaded.registry.availability.disabledModels).toEqual(["m", "m"])

    writeRegistry(configDir, "nope", "agent-models.disabled.jsonc")
    const broken = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    if (broken.status !== "ok") throw new Error("expected ok")
    expect(broken.registry.availability.disabledProviders).toEqual(["a"])
  })

  test("overlay accepts root-level disabled lists written by external tooling", async () => {
    const dir = tmp()
    const configDir = path.join(dir, ".opencode", "config")
    writeRegistry(configDir, registryText({ availability: { disabledProviders: ["a"] } }))
    writeRegistry(
      configDir,
      JSON.stringify({ disabledProviders: ["b"], disabledModels: ["m"] }),
      "agent-models.disabled.jsonc",
    )
    const loaded = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    if (loaded.status !== "ok") throw new Error("expected ok")
    expect(loaded.registry.availability.disabledProviders).toEqual(["a", "b"])
    expect(loaded.registry.availability.disabledModels).toEqual(["m"])
  })

  test("legacy overlay name applies with deprecation; new name wins when both exist", async () => {
    const dir = tmp()
    const configDir = path.join(dir, ".opencode", "config")
    writeRegistry(configDir, registryText({ availability: { disabledProviders: ["a"] } }))
    writeRegistry(configDir, JSON.stringify({ disabledProviders: ["legacy"] }), "agent-models.local.jsonc")
    const viaLegacy = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    if (viaLegacy.status !== "ok") throw new Error("expected ok")
    expect(viaLegacy.registry.availability.disabledProviders).toEqual(["a", "legacy"])

    writeRegistry(configDir, JSON.stringify({ disabledProviders: ["new"] }), "agent-models.disabled.jsonc")
    const both = await loadNoEnv({ worktree: dir, directory: dir, globalConfig: path.join(dir, "global") })
    if (both.status !== "ok") throw new Error("expected ok")
    expect(both.registry.availability.disabledProviders).toEqual(["a", "new"])
  })

  test("config key wins over worktree file, env wins over config key", async () => {
    const dir = tmp()
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: { "p:agent/w.md": "cap" } }))
    const configFile = writeRegistry(dir, registryText({ roles: { "p:agent/c.md": "cap" } }), "custom.jsonc")
    const envFile = writeRegistry(dir, registryText({ roles: { "p:agent/e.md": "cap" } }), "env.jsonc")
    const input = { worktree: dir, directory: dir, globalConfig: path.join(dir, "global"), configPath: configFile }

    const byConfig = await withEnv("OPENCODE_AGENT_MODELS", undefined, () => runLoad(input))
    if (byConfig.status !== "ok") throw new Error("expected ok")
    expect(Object.keys(byConfig.registry.roles)).toEqual(["p:agent/c.md"])

    await withEnv("OPENCODE_AGENT_MODELS", envFile, async () => {
      const byEnv = await runLoad(input)
      if (byEnv.status !== "ok") throw new Error("expected ok")
      expect(Object.keys(byEnv.registry.roles)).toEqual(["p:agent/e.md"])
    })
  })

  test("missing config-key file and relative path fall through to worktree", async () => {
    const dir = tmp()
    writeRegistry(path.join(dir, ".opencode", "config"), registryText({ roles: { "p:agent/w.md": "cap" } }))

    const missing = await loadNoEnv({
      worktree: dir,
      directory: dir,
      globalConfig: path.join(dir, "global"),
      configPath: path.join(dir, "nope.jsonc"),
    })
    if (missing.status !== "ok") throw new Error("expected ok")
    expect(Object.keys(missing.registry.roles)).toEqual(["p:agent/w.md"])

    const relative = await loadNoEnv({
      worktree: dir,
      directory: dir,
      globalConfig: path.join(dir, "global"),
      configPath: "relative/agent-models.jsonc",
    })
    if (relative.status !== "ok") throw new Error("expected ok")
    expect(Object.keys(relative.registry.roles)).toEqual(["p:agent/w.md"])
  })
})

// --- unit: applyBuiltinRoles --------------------------------------------------

describe("unit: applyBuiltinRoles", () => {
  const base = {
    prefixes: {},
    models: {
      m1: { model: "prov/m1", reasoning: { "1": "low" } },
      m2: { model: "prov/m2" },
    },
    capabilities: { cap: ["m1"], twocap: ["m1", "m2"] },
    roles: {},
    providerGroups: {},
    availability: { disabledProviders: [], disabledModels: [] },
    force: false,
  }

  test("assigns model and reasoning to a missing agent entry", async () => {
    const section: Record<string, unknown> = {}
    const assigned = await runBuiltin(section, { ...base, roles: { "builtin:plan": "cap:1" } })
    const plan = section["plan"] as Record<string, unknown>
    expect(plan.model).toBe("prov/m1")
    expect((plan.request as Record<string, unknown>).body).toEqual({ reasoningEffort: "low" })
    expect(assigned["plan"]).toEqual(plan)
  })

  test("explicit model in agent section wins, no assignment recorded", async () => {
    const section: Record<string, unknown> = { plan: { model: "keep/me", description: "d" } }
    const assigned = await runBuiltin(section, { ...base, roles: { "builtin:plan": "cap" } })
    expect(section["plan"]).toEqual({ model: "keep/me", description: "d" })
    expect(assigned["plan"]).toBeUndefined()
  })

  test("fills model into existing entry without model, preserving fields", async () => {
    const section: Record<string, unknown> = { general: { description: "general helper" } }
    await runBuiltin(section, { ...base, roles: { "builtin:general": "cap" } })
    expect(section["general"]).toEqual({ description: "general helper", model: "prov/m1" })
  })

  test("unknown builtin name is skipped", async () => {
    const section: Record<string, unknown> = {}
    const assigned = await runBuiltin(section, { ...base, roles: { "builtin:nope": "cap" } })
    expect(section["nope"]).toBeUndefined()
    expect(Object.keys(assigned)).toEqual([])
  })

  test("availability shifts builtin candidate", async () => {
    const section: Record<string, unknown> = {}
    await runBuiltin(section, {
      ...base,
      roles: { "builtin:build": "twocap" },
      availability: { disabledProviders: [], disabledModels: ["m1"] },
    })
    expect((section["build"] as Record<string, unknown>).model).toBe("prov/m2")
  })

  test("force overrides explicit agent-section model", async () => {
    const section: Record<string, unknown> = { build: { model: "baked/old" } }
    await runBuiltin(section, { ...base, roles: { "builtin:build": "cap" }, force: true })
    expect((section["build"] as Record<string, unknown>).model).toBe("prov/m1")
  })
})
