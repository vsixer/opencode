export * as ConfigCommandPlugin from "./command.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Info, type Entry } from "@opencode/schema/config"
import { ConfigCommand } from "@opencode/schema/config/command"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AppProcess } from "@opencode/util/process"
import path from "path"
import { Effect, Option, PubSub, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigAgentModels } from "../agent-models.js"
import { ConfigMarkdown } from "../markdown.js"
import { ConfigMerge } from "../merge.js"
import { Location } from "../../location.js"
import { Session } from "../../session.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { ShellSelect } from "../../shell/select.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

export const Plugin = define({
  id: "opencode.config.command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const start = yield* fs.resolve(location.directory)
    const projectRoot = yield* fs.resolve(location.project.directory)
    // Слой для layered merge: config dir в пределах рабочей директории или корня
    // проекта — "project", иначе — "global" (глобальный каталог конфигурации).
    const layerLabel = (entryPath: string) =>
      FSUtil.contains(projectRoot, entryPath) || FSUtil.contains(start, entryPath) ? "project" : "global"
    const loadRegistry = Effect.fn("ConfigCommandPlugin.loadRegistry")(function* (entries: Entry[]) {
      return yield* ConfigAgentModels.loadRegistry({
        worktree: projectRoot,
        directory: start,
        globalConfig: global.config,
        configPath: Config.latest(entries, "agent_models"),
      })
    })
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [{ commands: entry.info.commands }]
      if (entry.type !== "directory") return []
      // Directory entries contribute raw markdown definitions to the layered
      // fold; their decoded commands are appended after the fold below.
      const map: Record<string, ConfigMerge.Definition> = {}
      for (const filepath of yield* loadFiles(fs, entry.path)) {
        const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
        // Только отсутствующее чтение пропускает файл: пустой .md — валидная
        // команда с пустым шаблоном, как и в upstream-загрузчике.
        if (content === undefined) continue
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) continue
        const name = path
          .relative(entry.path, filepath)
          .replaceAll("\\", "/")
          .replace(/^(command|commands)\//, "")
          .replace(/\.md$/, "")
        map[name] = { frontmatter: { ...markdown.data }, body: markdown.content.trim(), source: filepath }
      }
      layers.push({ layer: layerLabel(entry.path), map })
      return []
    })
    const layers: ConfigMerge.LayerMap[] = []
    const load = Effect.fn("ConfigCommandPlugin.load")(function* () {
      layers.length = 0
      const entries = yield* config.entries()
      const registry = yield* loadRegistry(entries)
      const documents = yield* Effect.forEach(entries, loadEntry).pipe(Effect.map((parts) => parts.flat()))
      // Рукописный reasoningEffort в frontmatter команд вычищается всегда — даже
      // без реестра: канонический источник уровня — реестр agent-models, а
      // инъекция выполняется post-scan/pre-fold, пока у Definition есть source-путь.
      for (const layer of layers) {
        for (const definition of Object.values(layer.map)) delete definition.frontmatter.reasoningEffort
      }
      if (registry.status === "ok") {
        yield* ConfigAgentModels.applyRegistry(
          layers.flatMap((layer) => Object.values(layer.map)),
          registry.registry,
          global.home,
        )
      }
      // Слоистое слияние command: fold по упорядоченным слоям, затем один lenient-
      // decode над итогом. Ссклеенные .md-команды идут после JSON-документов
      // конфига — слоистый итог побеждает секцию commands из opencode.json, как и
      // в прежнем монолите конфигурации.
      const composed = ConfigMerge.foldEntries(layers)
      yield* Effect.forEach(
        Object.entries(composed),
        ([name, item]) =>
          Effect.forEach(
            item.warnings,
            (warning) =>
              Effect.logWarning(`layered merge command "${name}": ${warning.message}`, {
                source: item.source,
                kind: warning.kind,
              }),
            { discard: true },
          ),
        { discard: true },
      )
      const folded = yield* Effect.forEach(
        Object.entries(composed),
        ([name, item]) =>
          Effect.sync(() => {
            // reasoningEffort не поле команды, а приватный канал реестра:
            // извлекается до decode и попадает в Command.Info напрямую.
            // merge — директива слоистой склейки, в итоговой команде не нужна.
            const reasoningEffort =
              typeof item.frontmatter.reasoningEffort === "string" ? item.frontmatter.reasoningEffort : undefined
            const { reasoningEffort: _stripped, merge: _merge, ...frontmatter } = item.frontmatter
            const info = Option.getOrUndefined(decodeCommand({ ...frontmatter, template: item.body }))
            if (!info) return undefined
            return reasoningEffort === undefined ? { name, info } : { name, info, reasoningEffort }
          }),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((commands) =>
          commands.filter(
            (command): command is { name: string; info: ConfigCommand.Info; reasoningEffort?: string } =>
              command !== undefined,
          ),
        ),
      )
      return { documents, folded }
    })
    const processes = yield* AppProcess.Service
    const shell = yield* ShellSelect.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const subagents = yield* SubagentJob.Service
    const loaded = {
      documents: [] as { commands: Info["commands"] }[],
      commands: [] as { name: string; info: ConfigCommand.Info; reasoningEffort?: string }[],
    }
    const reload = load().pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          loaded.documents = result.documents
          loaded.commands = result.folded
        }),
      ),
      Effect.andThen(ctx.command.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isCommandSource(entries, update.path))),
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
    const initial = yield* load()
    loaded.documents = initial.documents
    loaded.commands = initial.folded
    yield* ctx.command.transform((editor) => {
      const add = (name: string, command: ConfigCommand.Info, reasoningEffort?: string) => {
        const subagent = command.subagent ?? command.subtask
        editor.add({
          name,
          description: command.description,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          execute: (input) =>
            Effect.gen(function* () {
              const agent = command.agent === undefined ? undefined : Agent.ID.make(command.agent)
              const commandAgent = agent === undefined ? undefined : (yield* ctx.agent.get({ agentID: agent })).data
              const model =
                command.model === undefined
                  ? commandAgent?.model
                  : {
                      id: Model.ID.make(command.model.model),
                      providerID: Provider.ID.make(command.model.providerID),
                      ...(command.model.variant === undefined
                        ? {}
                        : { variant: Model.VariantID.make(command.model.variant) }),
                    }
              const text = yield* evaluateTemplate(command.template, input.prompt.text, {
                location,
                processes,
                shell,
              })
              if (subagent ?? commandAgent?.mode === "subagent") {
                const parent = yield* sessions.get(input.sessionID)
                const selected = yield* agents.select(agent ?? parent.agent)
                const child = yield* sessions.create({
                  parentID: parent.id,
                  title: command.description ?? name,
                  agent: selected.id,
                  model: model ?? selected.info?.model ?? parent.model,
                })
                yield* sessions.prompt({
                  ...input.prompt,
                  sessionID: child.id,
                  text: ["You are a subagent spawned by another session.", text].join("\n"),
                  resume: false,
                })
                const recovery = {
                  kind: "subagent" as const,
                  parentSessionID: parent.id,
                  childSessionID: child.id,
                  agent: selected.id,
                  description: command.description ?? name,
                }
                yield* subagents.start(recovery)
                yield* subagents.background(recovery)
                return
              }
              if (agent !== undefined) {
                const session = yield* ctx.session.get({ sessionID: input.sessionID })
                if (session.agent !== agent) yield* ctx.session.switchAgent({ sessionID: input.sessionID, agent })
              }
              if (model !== undefined) yield* ctx.session.switchModel({ sessionID: input.sessionID, model })
              yield* ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text,
                delivery: input.delivery,
              })
            }).pipe(Effect.asVoid),
        })
      }
      for (const document of loaded.documents) {
        for (const [name, command] of Object.entries(document.commands ?? {})) add(name, command)
      }
      for (const command of loaded.commands) add(command.name, command.info, command.reasoningEffort)
    })
  }),
})

// Keep in sync with the loadFiles scan pattern and the name-strip regex in decode.
const sourceDirectories = ["command", "commands"] as const

// Matches anything at or under <root>/{command,commands}, plus the agent-models
// registry files under <root>/config so registry edits rebuild too.
function isCommandSource(entries: Entry[], file: string) {
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

function loadFiles(fs: FSUtil.Interface, directory: string) {
  return fs.scan("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true }).pipe(
    Effect.map((files) => files.toSorted()),
    Effect.orElseSucceed(() => [] as string[]),
  )
}

function evaluateTemplate(
  template: string,
  input: string,
  services: {
    readonly location: Location.Info
    readonly processes: AppProcess.Interface
    readonly shell: ShellSelect.Interface
  },
) {
  return Effect.gen(function* () {
    const args = parseArguments(input)
    const placeholders = template.match(placeholderRegex) ?? []
    const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
    const expanded = template.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const withArguments = expanded.replaceAll("$ARGUMENTS", () => input)
    const text =
      placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim()
        ? `${withArguments}\n\n${input}`.trim()
        : withArguments.trim()
    const matches = Array.from(text.matchAll(shellRegex))
    if (matches.length === 0) return text
    const shell = yield* services.shell.resolve({ priority: "config" })
    const outputs = yield* Effect.forEach(
      matches,
      (match) => {
        const source = match[1] ?? ""
        return services.processes
          .run(
            ChildProcess.make(shell, ShellSelect.args(shell, source), {
              cwd: services.location.directory,
              stdin: "ignore",
            }),
            { combineOutput: true },
          )
          .pipe(
            Effect.map((result) => (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")),
            Effect.mapError(
              (error) => new Error(`Shell interpolation failed for ${JSON.stringify(source)}: ${error.message}`),
            ),
          )
      },
      { concurrency: 2 },
    )
    const iterator = outputs[Symbol.iterator]()
    return text.replace(shellRegex, () => iterator.next().value ?? "")
  })
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
const shellRegex = /!`([^`]+)`/g
