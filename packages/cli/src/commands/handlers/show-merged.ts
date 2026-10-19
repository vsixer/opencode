import { EOL } from "node:os"
import { existsSync, readFileSync } from "node:fs"
import path from "path"
import { Effect } from "effect"
import { ConfigAgentModels } from "@opencode/core/config/agent-models"
import { ConfigMarkdown } from "@opencode/core/config/markdown"
import { ConfigMerge } from "@opencode/core/config/merge"
import { Global } from "@opencode/util/global"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

type Kind = "commands" | "agents" | "skills"

// Слоистые каталоги конфигурации в порядке возрастания приоритета: глобальный
// каталог — базовый слой, каталоги .opencode от верха дерева к рабочей
// директории перекрывают друг друга. Аппроксимация серверного discovery:
// wellknown-интеграции, ~/.claude и внешние источники в инспекцию не входят.
function configDirectories(globalConfig: string, start: string) {
  const dirs: { path: string; layer: string }[] = [{ path: globalConfig, layer: "global" }]
  // Собирается от рабочей директории вверх: ближайший .opencode — первый,
  // внешний — последний (он же кандидат в корень git-worktree).
  const project: { path: string; worktree: string }[] = []
  let current = path.resolve(start)
  for (;;) {
    const candidate = path.join(current, ".opencode")
    if (candidate !== globalConfig && existsSync(candidate)) project.push({ path: candidate, worktree: current })
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const entry of [...project].reverse()) dirs.push({ path: entry.path, layer: "project" })
  const worktree = project.length > 0 ? project[project.length - 1].worktree : start
  return { dirs, worktree }
}

function scanMarkdown(directory: string, pattern: string) {
  try {
    return Array.from(
      new Bun.Glob(pattern).scanSync({ cwd: directory, absolute: true, dot: true, followSymlinks: true, onlyFiles: true }),
    )
      .filter((file) => !file.includes("/node_modules/") && !file.includes("/.git/"))
      .toSorted()
  } catch {
    return []
  }
}

function parseMarkdownFile(filepath: string) {
  try {
    return ConfigMarkdown.parseOption(readFileSync(filepath, "utf8"))
  } catch {
    return undefined
  }
}

function relativeName(directory: string, filepath: string, strip: RegExp) {
  return path
    .relative(directory, filepath)
    .replaceAll("\\", "/")
    .replace(strip, "")
    .replace(/\.md$/, "")
}

// Raw-определения слоя до schema-decode — те же входные данные, на которых
// серверный конфигурационный плагин выполняет ConfigMerge.foldEntries.
function loadCommandLayer(directory: string): Record<string, ConfigMerge.Definition> {
  const map: Record<string, ConfigMerge.Definition> = {}
  for (const filepath of scanMarkdown(directory, "{command,commands}/**/*.md")) {
    const markdown = parseMarkdownFile(filepath)
    if (!markdown) continue
    const name = relativeName(directory, filepath, /^(command|commands)\//)
    map[name] = { frontmatter: { ...markdown.data }, body: markdown.content.trim(), source: filepath }
  }
  return map
}

// mode/*.md — альтернативная форма primary-агента: mode: "primary"
// проставляется в frontmatter до fold, как в core-загрузчике агентов.
const AGENT_SOURCES = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const

function loadAgentLayer(directory: string): Record<string, ConfigMerge.Definition> {
  const map: Record<string, ConfigMerge.Definition> = {}
  for (const source of AGENT_SOURCES) {
    for (const filepath of scanMarkdown(directory, source.pattern)) {
      const markdown = parseMarkdownFile(filepath)
      if (!markdown) continue
      const data = source.primary ? { ...markdown.data, mode: "primary" } : markdown.data
      const name = relativeName(directory, filepath, /^(agent|agents|mode|modes)\//)
      map[name] = { frontmatter: { ...data }, body: markdown.content.trim(), source: filepath }
    }
  }
  return map
}

function loadSkillLayer(directory: string): Record<string, ConfigMerge.Definition> {
  const map: Record<string, ConfigMerge.Definition> = {}
  for (const leaf of ["skill", "skills"]) {
    for (const filepath of scanMarkdown(path.join(directory, leaf), "**/SKILL.md")) {
      const markdown = parseMarkdownFile(filepath)
      if (!markdown) continue
      const name = markdown.data.name
      if (typeof name !== "string" || name === "") continue
      map[name] = { frontmatter: { ...markdown.data }, body: markdown.content.trim(), source: filepath }
    }
  }
  return map
}

const loadComposed = Effect.fnUntraced(function* (kind: Kind, name: string) {
  const global = yield* Global.Service
  const start = process.cwd()
  const { dirs, worktree } = configDirectories(global.config, start)

  const layers: ConfigMerge.LayerMap[] = []
  for (const dir of dirs) {
    const map =
      kind === "commands" ? loadCommandLayer(dir.path) : kind === "agents" ? loadAgentLayer(dir.path) : loadSkillLayer(dir.path)
    if (Object.keys(map).length > 0) layers.push({ layer: dir.layer, map })
  }

  if (kind !== "skills") {
    // reasoningEffort в frontmatter — приватный канал реестра agent-models:
    // рукописные значения вычищаются до инъекции, как в core-загрузчиках.
    // Значение ключа agent_models из opencode.json здесь не читается (для него
    // нужна полная конфигурационная сессия); файл реестра и переменная
    // окружения OPENCODE_AGENT_MODELS работают как обычно.
    for (const layer of layers) {
      for (const definition of Object.values(layer.map)) delete definition.frontmatter.reasoningEffort
    }
    const registry = yield* ConfigAgentModels.loadRegistry({
      worktree,
      directory: start,
      globalConfig: global.config,
    })
    if (registry.status === "ok") {
      yield* ConfigAgentModels.applyRegistry(
        layers.flatMap((layer) => Object.values(layer.map)),
        registry.registry,
        global.home,
      )
    }
  }

  const composed = ConfigMerge.foldEntries(layers)
  const found = composed[name]
  if (!found) return yield* Effect.fail(new Error(`${kind.slice(0, -1)} "${name}" not found in any config layer`))
  return found
})

function render(kind: Kind, name: string, c: ConfigMerge.Composed): string {
  const lines: string[] = []
  lines.push(`type: ${kind}`)
  lines.push(`name: ${name}`)
  lines.push(`strategy: ${c.strategy}`)
  lines.push(`source (winning): ${c.source}`)
  lines.push("")
  lines.push("## frontmatter (provenance)")
  for (const [k, v] of Object.entries(c.frontmatter)) {
    const prov = c.provenance.frontmatter[k] ?? "?"
    lines.push(`  [${prov}] ${k}: ${JSON.stringify(v)}`)
  }
  if (Object.keys(c.provenance.permission).length > 0) {
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
  if (c.warnings.length > 0) {
    lines.push("")
    lines.push("## warnings")
    for (const w of c.warnings) lines.push(`  [${w.kind}] ${w.message}`)
  }
  lines.push("")
  lines.push("## body")
  lines.push(c.body)
  return lines.join(EOL)
}

export default Runtime.handler(
  Commands.commands["show-merged"],
  Effect.fn("cli.showMerged")(function* (input: Runtime.Input<typeof Commands.commands["show-merged"]>) {
    const composed = yield* loadComposed(input.type, input.name)
    process.stdout.write(render(input.type, input.name, composed) + EOL)
  }),
)
