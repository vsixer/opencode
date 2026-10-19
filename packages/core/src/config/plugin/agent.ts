export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import path from "path"
import { Effect, Option, PubSub, Schema, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigAgentModels } from "../agent-models.js"
import { ConfigMarkdown } from "../markdown.js"
import { ConfigMerge } from "../merge.js"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { Global } from "@opencode/util/global"
import { Permission } from "../../permission.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"
import { AbsolutePath } from "../../schema.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
// Keep in sync with the legacySources patterns and the name-strip regex in decode.
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Info)
type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])

export const Plugin = define({
  id: "opencode.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const start = yield* fs.resolve(ctx.location.directory)
    const projectRoot = yield* fs.resolve(ctx.location.project.directory)
    // Слой для layered merge: config dir в пределах рабочей директории или корня
    // проекта — "project", иначе — "global" (глобальный каталог конфигурации).
    const layerLabel = (entryPath: string) =>
      FSUtil.contains(projectRoot, entryPath) || FSUtil.contains(start, entryPath) ? "project" : "global"
    const loadRegistry = Effect.fn("ConfigAgentPlugin.loadRegistry")(function* (entries: Entry[]) {
      return yield* ConfigAgentModels.loadRegistry({
        worktree: projectRoot,
        directory: start,
        globalConfig: global.config,
        configPath: Config.latest(entries, "agent_models"),
      })
    })
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [entry]
      if (entry.type !== "directory") return []
      // Directory entries contribute raw markdown definitions to the layered
      // fold; their decoded documents are appended after the fold below.
      const map: Record<string, ConfigMerge.Definition> = {}
      for (const file of yield* discover(fs, entry.path)) {
        const content = yield* fs.readFileStringSafe(file.filepath).pipe(Effect.orElseSucceed(() => undefined))
        if (!content) continue
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) continue
        const name = path
          .relative(entry.path, file.filepath)
          .replaceAll("\\", "/")
          .replace(/^(agent|agents|mode|modes)\//, "")
          .replace(/\.md$/, "")
        // mode/*.md — альтернативный способ определить primary-агента.
        // mode: "primary" выставляется в frontmatter сразу, чтобы пройти через fold.
        const data = file.primary ? { ...markdown.data, mode: "primary" } : markdown.data
        map[name] = { frontmatter: { ...data }, body: markdown.content.trim(), source: file.filepath }
      }
      layers.push({ layer: layerLabel(entry.path), map })
      return []
    })
    const layers: ConfigMerge.LayerMap[] = []
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      layers.length = 0
      const entries = yield* config.entries()
      const registry = yield* loadRegistry(entries)
      const documents = yield* Effect.forEach(entries, loadEntry).pipe(Effect.map((parts) => parts.flat()))
      if (registry.status === "ok") {
        yield* ConfigAgentModels.applyRegistry(
          layers.flatMap((layer) => Object.values(layer.map)),
          registry.registry,
          global.home,
        )
      }
      // Слоистое слияние agent/mode: fold по упорядоченным слоям, затем один decode
      // над итогом. Ссклеенные .md-определения идут после JSON-документов конфига —
      // слоистый итог побеждает секцию agents из opencode.json, как и в прежнем
      // монолите конфигурации.
      const composed = ConfigMerge.foldEntries(layers)
      yield* Effect.forEach(
        Object.entries(composed),
        ([name, item]) =>
          Effect.forEach(
            item.warnings,
            (warning) =>
              Effect.logWarning(`layered merge agent "${name}": ${warning.message}`, {
                source: item.source,
                kind: warning.kind,
              }),
            { discard: true },
          ),
        { discard: true },
      )
      const folded = yield* Effect.forEach(
        Object.entries(composed),
        ([name, item]) => Effect.sync(() => decodeComposed(name, item)),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((documents) => documents.filter((document): document is Document => document !== undefined)))
      const section: Record<string, unknown> = {}
      if (registry.status === "ok") {
        // Встроенные агенты назначаются в сырую секцию agents из JSON-документов:
        // явная model в opencode.json остаётся приоритетнее реестра.
        for (const document of [...documents, ...folded]) {
          for (const [id, item] of Object.entries(document.info.agents ?? {})) section[id] = { ...item }
        }
      }
      const assigned =
        registry.status === "ok" ? yield* ConfigAgentModels.applyBuiltinRoles(section, registry.registry) : {}
      const builtin =
        registry.status === "ok" && Object.keys(assigned).length
          ? Option.getOrUndefined(decodeConfig({ agents: assigned }))
          : undefined
      return [...documents, ...folded, ...(builtin ? [new Document({ type: "document", info: builtin })] : [])]
    })
    const loaded = { documents: [] as Document[] }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.agent.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isAgentSource(entries, update.path))),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.documents = yield* load()
    yield* ctx.agent.transform((editor) => {
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          const agentID = Agent.ID.make(id)
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          const exists = editor.get(agentID) !== undefined
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            if (item.system !== undefined) agent.system = item.system
            if (item.description !== undefined) agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined) agent.steps = item.steps
            if (item.permissions !== undefined) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

// Matches anything at or under <root>/{agent,agents,mode,modes}, plus the
// agent-models registry files under <root>/config so registry edits rebuild too.
function isAgentSource(entries: Entry[], file: string) {
  const target = path.resolve(file)
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      (sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)) ||
        ConfigAgentModels.sourceFiles.some(
          (name) => path.join(entry.path, "config", name) === target || path.join(entry.path, name) === target,
        )),
  )
}

function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .scan(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

// Финальный decode после слоистого fold: каждое Composed → типизированное Info.
// Поддержка native и legacy frontmatter сохранена из upstream-загрузчика:
// legacy-детект по неизвестным ключам, склейка model#variant, миграция V1.
function decodeComposed(name: string, composed: ConfigMerge.Composed) {
  const data = composed.frontmatter
  const body = composed.body
  const legacy = Object.keys(data).some((key) => !agentKeys.has(key))
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const merged =
    typeof data.model === "string" &&
    !data.model.includes("#") &&
    typeof data.variant === "string" &&
    /^[^#]+$/.test(data.variant)
      ? { ...data, model: `${data.model}#${data.variant}` }
      : data
  const agent = legacy
    ? Option.getOrUndefined(
        Option.map(decodeLegacyAgent({ name, ...data, prompt: body }, { errors: "all" }), ConfigMigrateV1.migrateAgent),
      )
    : Option.getOrUndefined(decodeAgent({ ...merged, system: body }, { errors: "all" }))
  if (!agent) return undefined
  const info = Option.getOrUndefined(decodeConfig({ agents: { [name]: agent } }))
  if (!info) return undefined
  return new Document({ type: "document", path: AbsolutePath.make(composed.source), info })
}
