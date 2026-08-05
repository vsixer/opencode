import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { Config } from "../../config/config"
import { ConfigCommand } from "../../config/command"
import { ConfigAgent } from "../../config/agent"
import { ConfigMerge } from "../../config/merge"
import { ConfigMarkdown } from "../../config/markdown"
import { isRecord } from "@/util/record"
import { effectCmd, fail } from "../effect-cmd"

type Type = "command" | "agent" | "skill"

// Классификация слоя по cwd процесса (аппроксимация workspace для CLI-инспекции).
function classifyLayer(dir: string): string {
  const cwd = process.cwd()
  return dir === cwd || dir.startsWith(cwd + path.sep) ? "project" : "global"
}

const loadComposed = Effect.fnUntraced(function* (type: Type, name: string) {
  const config = yield* Config.Service
  const dirs = yield* config.directories()

  const layers: ConfigMerge.LayerMap[] = []
  for (const dir of dirs) {
    let map: Record<string, ConfigMerge.Definition> = {}
    if (type === "command") {
      map = yield* Effect.promise(() => ConfigCommand.load(dir))
    } else if (type === "agent") {
      const [a, m] = yield* Effect.all([
        Effect.promise(() => ConfigAgent.load(dir)),
        Effect.promise(() => ConfigAgent.loadMode(dir)),
      ])
      map = { ...a, ...m }
    } else {
      // skill: собственный скан {skill,skills}/**/SKILL.md
      const matches = yield* Effect.promise(async () => {
        try {
          return await Glob.scan("{skill,skills}/**/SKILL.md", {
            cwd: dir,
            absolute: true,
            symlink: true,
            include: "file",
          })
        } catch {
          return [] as string[]
        }
      })
      for (const match of matches) {
        const md = yield* Effect.promise(async () => {
          try {
            return await ConfigMarkdown.parse(match)
          } catch {
            return null
          }
        })
        if (!md || !isRecord(md.data) || typeof md.data.name !== "string") continue
        map[md.data.name] = { frontmatter: md.data, body: md.content, source: match }
      }
    }
    if (Object.keys(map).length) layers.push({ layer: classifyLayer(dir), map })
  }

  const composed = ConfigMerge.foldEntries(layers)
  const c = composed[name]
  if (!c) return yield* fail(`${type} "${name}" not found in any layer`)
  return c
})

function render(name: string, type: Type, c: ConfigMerge.Composed): string {
  const lines: string[] = []
  lines.push(`type: ${type}`)
  lines.push(`name: ${name}`)
  lines.push(`strategy: ${c.strategy}`)
  lines.push(`source (winning): ${c.source}`)
  lines.push("")
  lines.push("## frontmatter (provenance)")
  for (const [k, v] of Object.entries(c.frontmatter)) {
    const prov = c.provenance.frontmatter[k] ?? "?"
    lines.push(`  [${prov}] ${k}: ${JSON.stringify(v)}`)
  }
  if (Object.keys(c.provenance.permission).length) {
    lines.push("")
    lines.push("## permission provenance")
    for (const [k, p] of Object.entries(c.provenance.permission)) lines.push(`  [${p}] ${k}`)
  }
  lines.push("")
  lines.push(
    `## slots: filled=[${c.provenance.slots.filled.join(", ")}] unfilled=[${c.provenance.slots.unfilled.join(
      ", ",
    )}] unknown=[${c.provenance.slots.unknown.join(", ")}]`,
  )
  if (c.warnings.length) {
    lines.push("")
    lines.push("## warnings")
    for (const w of c.warnings) lines.push(`  [${w.kind}] ${w.message}`)
  }
  lines.push("")
  lines.push("## body")
  lines.push(c.body)
  return lines.join(EOL)
}

export const ShowMergedCommand = effectCmd({
  command: "show-merged <type> <name>",
  describe: "show the layered-merged definition (frontmatter, body, slots, permission provenance)",
  builder: (yargs) =>
    yargs
      .positional("type", { choices: ["command", "agent", "skill"] as const, demandOption: true })
      .positional("name", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.showMerged")(function* (args: { type: Type; name: string }) {
    const c = yield* loadComposed(args.type, args.name)
    process.stdout.write(render(args.name, args.type, c) + EOL)
  }),
})
