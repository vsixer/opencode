export * as ConfigAgentModels from "./agent-models"

import path from "path"
import fs from "fs"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigParse } from "./parse"
import type { ConfigMerge } from "./merge"
import { isRecord } from "@/util/record"
import type { InstanceContext } from "../project/instance-context"

// Реестр моделей агентов и команд (agent-models.jsonc).
// Ошибки в любом поле — warning и пропуск, ядро конфигурации не падает:
// реестр — аддитивный слой поверх обычной загрузки .md-определений.

export type ModelEntry = string | { model: string; reasoning?: Record<string, string> }

export type Registry = {
  prefixes: Record<string, string>
  models: Record<string, ModelEntry>
  capabilities: Record<string, string[]>
  roles: Record<string, string>
  providerGroups: Record<string, string[]>
  availability: { disabledProviders: string[]; disabledModels: string[] }
}

export type LoadedRegistry =
  | { status: "none" }
  // Битый базовый JSONC: слой реестра выключен на этой загрузке, отката по цепочке нет.
  | { status: "disabled" }
  | { status: "ok"; registry: Registry }

const FILENAME = "agent-models.jsonc"
const OVERLAY = "agent-models.local.jsonc"

function isFile(p: string) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function emptyRegistry(): Registry {
  return {
    prefixes: {},
    models: {},
    capabilities: {},
    roles: {},
    providerGroups: {},
    availability: { disabledProviders: [], disabledModels: [] },
  }
}

function asRegistry(data: unknown): Registry {
  const registry = emptyRegistry()
  if (!isRecord(data)) return registry
  if (isRecord(data.prefixes)) registry.prefixes = data.prefixes as Record<string, string>
  if (isRecord(data.models)) registry.models = data.models as Record<string, ModelEntry>
  if (isRecord(data.capabilities)) registry.capabilities = data.capabilities as Record<string, string[]>
  if (isRecord(data.roles)) registry.roles = data.roles as Record<string, string>
  if (isRecord(data.providerGroups)) registry.providerGroups = data.providerGroups as Record<string, string[]>
  if (isRecord(data.availability)) {
    const availability = data.availability as Record<string, unknown>
    if (Array.isArray(availability.disabledProviders)) registry.availability.disabledProviders = availability.disabledProviders
    if (Array.isArray(availability.disabledModels)) registry.availability.disabledModels = availability.disabledModels
  }
  return registry
}

// Оверлей рядом с найденным базовым файлом: учитываются только списки отключения,
// значения конкатенируются с базой. Битый оверлей игнорируется целиком.
function applyOverlay(registry: Registry, file: string): Effect.Effect<Registry> {
  const overlayPath = path.join(path.dirname(file), OVERLAY)
  if (!isFile(overlayPath)) return Effect.succeed(registry)
  return Effect.gen(function* () {
    const text = yield* Effect.promise(() => fs.promises.readFile(overlayPath, "utf8"))
    let data: unknown
    try {
      data = ConfigParse.jsonc(text, overlayPath)
    } catch (error) {
      yield* Effect.logWarning("agent-models registry: broken overlay ignored", { path: overlayPath, error: String(error) })
      return registry
    }
    if (!isRecord(data)) return registry
    // Оверлей пишется внешним тулингом (/misc/sync-agent-models disable/enable)
    // списками отключения на верхнем уровне файла; ручная форма — под "availability",
    // как в базовом реестре. Принимаются обе, значения конкатенируются.
    const sources = [data, isRecord(data.availability) ? data.availability : {}]
    for (const source of sources) {
      for (const key of ["disabledProviders", "disabledModels"] as const) {
        const value = (source as Record<string, unknown>)[key]
        if (value === undefined) continue
        if (!Array.isArray(value)) {
          yield* Effect.logWarning(`agent-models registry: overlay "${key}" is not an array, ignored`, { path: overlayPath })
          continue
        }
        registry.availability[key] = [...registry.availability[key], ...value]
      }
    }
    return registry
  })
}

export const loadRegistry = Effect.fn("ConfigAgentModels.loadRegistry")(function* (ctx: InstanceContext) {
  // worktree-корень — каноническое место .opencode; directory покрывает рабочую
  // директорию вне git-репозитория.
  const envPath = Flag.OPENCODE_AGENT_MODELS
  // Env задан, но файла нет — типовая опечатка при запуске; молча слой бы
  // выключился, и диагностировать это по логу невозможно.
  if (envPath && !isFile(envPath)) {
    yield* Effect.logWarning("agent-models registry: OPENCODE_AGENT_MODELS is set but the file does not exist, ignored", {
      path: envPath,
    })
  }
  const candidates = [
    envPath,
    path.join(ctx.worktree, ".opencode", "config", FILENAME),
    path.join(ctx.directory, ".opencode", "config", FILENAME),
    path.join(Global.Path.config, "config", FILENAME),
  ].filter((p): p is string => !!p)

  const file = candidates.find(isFile)
  if (!file) {
    yield* Effect.logDebug("agent-models registry: none found, layer off", { searched: candidates })
    return { status: "none" } as LoadedRegistry
  }

  // Пустой файл или файл из одних комментариев — тихий no-op, не ошибка.
  // Оверлей при этом всё равно применяется: availability-списки живут отдельно
  // от прочего содержимого реестра.
  const read = yield* Effect.tryPromise({
    try: () => fs.promises.readFile(file, "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("agent-models registry: unreadable file", { path: file, error: String(error) }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  if (read === undefined) return { status: "disabled" } as LoadedRegistry
  const withoutComments = read.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim()
  if (withoutComments === "") {
    const registry = yield* applyOverlay(emptyRegistry(), file)
    yield* Effect.logInfo("agent-models registry: loaded (empty)", { path: file })
    return { status: "ok", registry }
  }
  let data: unknown
  try {
    data = ConfigParse.jsonc(read, file)
  } catch (error) {
    yield* Effect.logWarning("agent-models registry: broken file, registry layer disabled", {
      path: file,
      error: String(error),
    })
    return { status: "disabled" } as LoadedRegistry
  }
  if (!isRecord(data)) {
    yield* Effect.logWarning("agent-models registry: root is not an object, registry layer disabled", { path: file })
    return { status: "disabled" } as LoadedRegistry
  }
  const registry = yield* applyOverlay(asRegistry(data), file)
  // Диагностика включённости слоя: без этой строки «реестр не найден» и
  // «реестр применён» неотличимы по логу.
  yield* Effect.logInfo("agent-models registry: loaded", { path: file, roles: Object.keys(registry.roles).length })
  return { status: "ok", registry }
})

// --- Resolver -----------------------------------------------------------------

// Канонический ключ — prefix:путь/к/файлу.md; дополнительно матчатся сокращённые
// формы без сегмента agent/agents/command/commands и/или без .md — детерминированный
// порядок попыток ниже фиксирует неоднозначность.
const SEGMENTS = ["agent", "agents", "command", "commands"]

const PLURAL: Record<string, string> = { agent: "agents", command: "commands" }

function expandHome(base: string) {
  return base.startsWith("~") ? path.join(Global.Path.home, base.slice(1)) : base
}

function rolePaths(base: string, rel: string) {
  const norm = rel.split("/").filter((s) => s.length > 0)
  const attempts: string[] = []
  const withMd = (segs: string[]) => {
    const joined = path.resolve(base, ...segs)
    attempts.push(joined)
    if (!joined.endsWith(".md")) attempts.push(joined + ".md")
  }
  withMd(norm)
  for (const s of SEGMENTS) withMd([s, ...norm])
  return attempts
}

// Двойник глобального слоя: плюрализация первого сегмента пути (регистрозависимо),
// проверяется только когда под базой роли лежит вложенная директория.
function globalAnalogPath(globalBase: string, roleBase: string, source: string) {
  const rel = path.relative(roleBase, source)
  const segments = rel.split(/[\\/]/)
  if (segments.length <= 1) return undefined
  const plural = PLURAL[segments[0]]
  if (!plural) return undefined
  return path.resolve(globalBase, plural, ...segments.slice(1))
}

function disabledProviders(registry: Registry) {
  const out = new Set<string>()
  for (const entry of registry.availability.disabledProviders) {
    // Раскрытие групп провайдеров ровно на один уровень: ключ группы выигрывает
    // у литерального id, повторно группы не раскрываются.
    const group = registry.providerGroups[entry]
    for (const p of group ?? [entry]) out.add(p)
  }
  return out
}

function modelString(entry: unknown) {
  if (typeof entry === "string") return entry
  if (isRecord(entry) && typeof entry.model === "string") return entry.model
  return undefined
}

export const applyRegistry = Effect.fn("ConfigAgentModels.applyRegistry")(function* (
  defs: ConfigMerge.Definition[],
  registry: Registry,
) {
  const bySource = new Map(defs.map((def) => [path.resolve(def.source), def]))
  const claimed = new Set<string>()
  const providersOff = disabledProviders(registry)
  const modelsOff = new Set(registry.availability.disabledModels)

  for (const [key, value] of Object.entries(registry.roles)) {
    const warn = (reason: string, extra: Record<string, unknown> = {}) =>
      Effect.logWarning(`agent-models registry: ${reason}`, { role: key, ...extra })

    if (typeof value !== "string") {
      yield* warn("role value is not a string")
      continue
    }
    const sep = key.indexOf(":")
    if (sep <= 0) {
      yield* warn("role key must be prefix:path")
      continue
    }
    const prefix = key.slice(0, sep)
    const rel = key.slice(sep + 1)
    const baseRaw = registry.prefixes[prefix]
    if (typeof baseRaw !== "string" || baseRaw === "") {
      yield* warn("unknown prefix")
      continue
    }
    if (rel.includes("\\")) {
      yield* warn("role path must use forward slashes")
      continue
    }
    const base = expandHome(baseRaw)
    const target = rolePaths(base, rel).find((p) => bySource.has(p))
    if (!target) {
      yield* warn("role targets a non-existent file or not an agent/command")
      continue
    }
    const def = bySource.get(target)!
    // Роль «клеймит» файл в момент матча, а не в момент записи: даже если ниже
    // сработает global-analog или frontmatter-гейт и назначения не будет,
    // последующие роли на этот файл не переопределяют первую — детерминированное
    // «первая роль выигрывает» в порядке объявления ключей roles.
    if (claimed.has(target)) {
      yield* warn("duplicate role target, first role wins", { source: def.source })
      continue
    }
    claimed.add(target)

    const globalBaseRaw = registry.prefixes["global"]
    if (typeof globalBaseRaw === "string" && globalBaseRaw !== "") {
      const analog = globalAnalogPath(expandHome(globalBaseRaw), base, target)
      if (analog && fs.existsSync(analog)) {
        const current = def.frontmatter.model
        if (typeof current === "string" && current !== "") {
          yield* Effect.logWarning("agent-models registry: global analog exists, frontmatter model drifts from it", {
            role: key,
            source: def.source,
          })
        }
        continue
      }
    }

    const current = def.frontmatter.model
    if (typeof current === "string" && current !== "") continue

    const [capRaw, levelRaw] = value.includes(":") ? (value.split(/:(.*)/, 2) as [string, string]) : [value, undefined]
    const cap = capRaw
    const levelStr = levelRaw === "" ? "0" : levelRaw
    if (levelStr !== undefined && !/^\d+$/.test(levelStr)) {
      yield* warn(`invalid reasoning level "${levelStr}"`, { source: def.source })
      continue
    }

    const candidates = registry.capabilities[cap]
    if (!Array.isArray(candidates) || candidates.length === 0) {
      yield* warn(`unknown capability "${cap}"`, { source: def.source })
      continue
    }

    let chosen: { model: string; entry: unknown } | undefined
    let aborted = false
    for (const alias of candidates) {
      if (typeof alias !== "string") {
        yield* warn("capability candidate is not a string", { source: def.source })
        aborted = true
        break
      }
      if (modelsOff.has(alias)) continue
      const entry = registry.models[alias]
      const model = modelString(entry)
      // STRICT-ABORT: кандидат заявлен, но неразрешим — переход к следующему запрещён.
      // Строка модели обязана иметь вид "provider/id" с непустыми частями, чтобы
      // Provider.parseModel ниже по стеку не получал мусор.
      const parts = model === undefined ? [] : model.split("/")
      if (entry === undefined || model === undefined || model === "" || parts.length < 2 || parts.some((p) => p === "")) {
        yield* warn(`candidate "${alias}" has no valid provider/model entry, role unresolved`, { source: def.source })
        aborted = true
        break
      }
      if (providersOff.has(model.split("/")[0])) continue
      chosen = { model, entry }
      break
    }
    if (!chosen) {
      if (!aborted) yield* warn("all candidates disabled, role unresolved", { source: def.source })
      continue
    }

    // Frontmatter может быть общим объектом между Definition с байт-идентичным
    // содержимым .md (кэш gray-matter по строке) — клонируем перед мутацией,
    // чтобы назначение не протекло в чужой слой.
    def.frontmatter = { ...def.frontmatter }
    def.frontmatter.model = chosen.model

    if (levelStr === undefined) continue
    const mapping = isRecord(chosen.entry) ? chosen.entry.reasoning : undefined
    const level = isRecord(mapping) ? mapping[String(Number(levelStr))] : undefined
    if (typeof level !== "string" || level === "") {
      // Loose mode: reasoning недоступен, но модель применяется.
      yield* warn(`reasoning level ${Number(levelStr)} not found for selected model, applied without reasoning`, {
        source: def.source,
      })
      continue
    }
    def.frontmatter.reasoningEffort = level
  }
})
