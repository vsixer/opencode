import { test, expect, describe } from "bun:test"
import { ConfigMerge } from "@/config/merge"

// Хелпер: построить Definition из frontmatter + body.
function def(frontmatter: Record<string, unknown>, body: string, source = "test", layer?: string): ConfigMerge.Definition {
  return { frontmatter, body, source, layer }
}

describe("ConfigMerge.compose — body strategy", () => {
  test("append (default): local body after global", () => {
    const g = def({ description: "g" }, "GLOBAL")
    const l = def({}, "LOCAL")
    const out = ConfigMerge.compose(g, l)
    expect(out.body).toBe("GLOBAL\n\nLOCAL")
    expect(out.strategy).toBe("append")
  })

  test("prepend: local body before global", () => {
    const g = def({}, "GLOBAL")
    const l = def({ merge: "prepend" }, "LOCAL")
    expect(ConfigMerge.compose(g, l).body).toBe("LOCAL\n\nGLOBAL")
  })

  test("replace: only local body", () => {
    const g = def({}, "GLOBAL\n<!-- slot: x -->\nTAIL")
    const l = def({ merge: "replace" }, "LOCAL")
    expect(ConfigMerge.compose(g, l).body).toBe("LOCAL")
  })
})

describe("ConfigMerge.compose — slots", () => {
  test("filled slot: marker replaced with fill content", () => {
    const g = def({}, "HEAD\n<!-- slot: post -->\nTAIL")
    const l = def({}, "<!-- slot: post -->\nFILL\n<!-- /slot: post -->")
    const out = ConfigMerge.compose(g, l)
    expect(out.body).toContain("FILL")
    expect(out.body).not.toContain("<!-- slot: post -->")
    expect(out.provenance.slots.filled).toEqual(["post"])
    expect(out.provenance.slots.unknown).toEqual([])
  })

  test("unfilled slot: marker removed, renders nothing", () => {
    const g = def({}, "HEAD\n<!-- slot: x -->\nTAIL")
    const l = def({}, "LOCAL")
    const out = ConfigMerge.compose(g, l)
    expect(out.body).not.toContain("<!-- slot: x -->")
    expect(out.provenance.slots.unfilled).toEqual(["x"])
  })

  test("unknown slot in local: warning", () => {
    const g = def({}, "GLOBAL")
    const l = def({}, "<!-- slot: nope -->\nX\n<!-- /slot: nope -->")
    const out = ConfigMerge.compose(g, l)
    expect(out.provenance.slots.unknown).toEqual(["nope"])
    expect(out.warnings.some((w) => w.kind === "unknown-slot")).toBe(true)
  })

  test("duplicate fill block: warning + concatenation", () => {
    const g = def({}, "GLOBAL\n<!-- slot: a -->")
    const l = def({}, "<!-- slot: a -->\nONE\n<!-- /slot: a -->\n<!-- slot: a -->\nTWO\n<!-- /slot: a -->")
    const out = ConfigMerge.compose(g, l)
    expect(out.warnings.some((w) => w.kind === "duplicate-fill")).toBe(true)
    expect(out.body).toContain("ONE")
    expect(out.body).toContain("TWO")
  })
})

describe("ConfigMerge.compose — frontmatter policy", () => {
  test("scalar: local-wins", () => {
    const g = def({ model: "gpt-a", description: "global desc" }, "")
    const l = def({ model: "gpt-b" }, "")
    const out = ConfigMerge.compose(g, l)
    expect(out.frontmatter.model).toBe("gpt-b")
    expect(out.frontmatter.description).toBe("global desc") // локаль не переопределяла
  })

  test("options (object): wholesale local-wins, not key-merge", () => {
    const g = def({ options: { a: 1, b: 2 } }, "")
    const l = def({ options: { c: 3 } }, "")
    const out = ConfigMerge.compose(g, l)
    expect(out.frontmatter.options).toEqual({ c: 3 })
  })

  test("permission: per-key override (union, local wins on conflict)", () => {
    const g = def({ permission: { bash: "allow", edit: "deny", read: "allow" } }, "")
    const l = def({ permission: { edit: "allow", webfetch: "ask" } }, "")
    const out = ConfigMerge.compose(g, l)
    const perm = out.frontmatter.permission as Record<string, unknown>
    expect(perm.bash).toBe("allow") // только global
    expect(perm.read).toBe("allow") // только global
    expect(perm.edit).toBe("allow") // конфликт → local wins
    expect(perm.webfetch).toBe("ask") // только local
    expect(out.provenance.permission.bash).toBe("global")
    expect(out.provenance.permission.edit).toBe("overridden")
    expect(out.provenance.permission.webfetch).toBe("local")
  })

  test("permission nested sub-record: wholesale replace per key", () => {
    const g = def({ permission: { edit: { "src/**": "allow" } } }, "")
    const l = def({ permission: { edit: { "test/**": "deny" } } }, "")
    const out = ConfigMerge.compose(g, l)
    // shallow per-key: весь permission.edit из local заменяет global.edit
    expect(out.frontmatter.permission).toEqual({ edit: { "test/**": "deny" } })
  })
})

describe("ConfigMerge.fold — N-layer", () => {
  test("3 layers compose in order", () => {
    const layers = [
      def({ description: "base" }, "BASE", "base.md", "global"),
      def({ model: "m1" }, "L1", "l1.md", "project"),
      def({ model: "m2", merge: "append" }, "L2", "l2.md", "project"),
    ]
    const out = ConfigMerge.fold(layers)
    // model: local-wins последнего слоя
    expect(out.frontmatter.model).toBe("m2")
    // description из base (не переопределён)
    expect(out.frontmatter.description).toBe("base")
    // body: append → BASE + L1 + L2
    expect(out.body).toBe("BASE\n\nL1\n\nL2")
  })

  test("single layer: passthrough", () => {
    const out = ConfigMerge.fold([def({ a: 1 }, "BODY", "x.md", "global")])
    expect(out.frontmatter.a).toBe(1)
    expect(out.body).toBe("BODY")
    expect(out.provenance.frontmatter.a).toBe("global")
  })

  test("empty layers: neutral element", () => {
    const out = ConfigMerge.fold([])
    expect(out.body).toBe("")
    expect(out.frontmatter).toEqual({})
  })
})

describe("ConfigMerge.foldEntries", () => {
  test("per-name fold across layer maps", () => {
    const layers: ConfigMerge.LayerMap[] = [
      { layer: "global", map: { foo: def({ model: "g" }, "G", "g.md") } },
      { layer: "project", map: { foo: def({ merge: "append" }, "P", "p.md"), bar: def({}, "B", "b.md") } },
    ]
    const out = ConfigMerge.foldEntries(layers)
    expect(out.foo.body).toBe("G\n\nP")
    expect(out.foo.frontmatter.model).toBe("g")
    expect(out.bar.body).toBe("B") // single layer
  })
})

describe("ConfigMerge — killer case (/task/start)", () => {
  test("global declares slot, project fills it, model from local, description from global", () => {
    const g = def(
      { description: "Create task and load context", merge: "append" },
      "## Step 1. Create folder/task.md\n\n<!-- slot: post-create -->\n\n## Step 2. Summary",
      "~/.config/opencode/commands/task/start.md",
      "global",
    )
    const l = def(
      { model: "openai/gpt-5.6-luna" },
      "<!-- slot: post-create -->\n### MacroCRM extras\nCall init-task.\n<!-- /slot: post-create -->",
      ".opencode/command/task/start.md",
      "project",
    )
    const out = ConfigMerge.compose(g, l)
    expect(out.frontmatter.model).toBe("openai/gpt-5.6-luna")
    expect(out.frontmatter.description).toBe("Create task and load context")
    expect(out.body).toContain("## Step 1. Create folder/task.md")
    expect(out.body).toContain("### MacroCRM extras")
    expect(out.body).toContain("Call init-task.")
    expect(out.body).toContain("## Step 2. Summary")
    expect(out.provenance.slots.filled).toEqual(["post-create"])
  })
})
