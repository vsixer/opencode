export * as ConfigAgentModels from "./agent-models.js"

import fs from "fs"
import path from "path"
import { type ParseError, printParseErrorCode, parse as parseJsonc } from "jsonc-parser"
import { Effect } from "effect"
import { isRecord } from "@opencode/ai/utils/record"
import type { ConfigMerge } from "./merge.js"

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
  // Режим принуждения (например, реестр oc-local): назначение перекрывает
  // явную model во frontmatter .md и в секции agent конфига. По умолчанию
  // выключен — там побеждает явно заданная модель.
  force: boolean
}

export type LoadedRegistry =
  | { status: "none" }
  // Битый базовый JSONC: слой реестра выключен на этой загрузке, отката по цепочке нет.
  | { status: "disabled" }
  | { status: "ok"; registry: Registry }

const FILENAME = "agent-models.jsonc"
const OVERLAY = "agent-models.disabled.jsonc"
// Deprecated-имя оверлея: пока файл не переименован на всех машинах, читается
// с warning-ом; при наличии обоих имён выигрывает новое.
const OVERLAY_LEGACY = "agent-models.local.jsonc"

// Имена файлов реестра для подписок на изменения: правка любого из них в
// config-каталоге должна пересобирать agентов и команды.
export const sourceFiles = [FILENAME, OVERLAY, OVERLAY_LEGACY] as const

function jsonc(text: string, filepath: string): unknown {
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid JSONC in ${filepath}: ${details}`)
  }
  return data
}

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
    force: false,
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
  if (typeof data.force === "boolean") registry.force = data.force
  if (isRecord(data.availability)) {
    const availability = data.availability
    if (Array.isArray(availability.disabledProviders))
      registry.availability.disabledProviders = availability.disabledProviders
    if (Array.isArray(availability.disabledModels)) registry.availability.disabledModels = availability.disabledModels
  }
  return registry
}

// Оверлей рядом с найденным базовым файлом: учитываются только списки отключения,
// значения конкатенируются с базой. Битый оверлей игнорируется целиком.
function applyOverlay(registry: Registry, file: string): Effect.Effect<Registry> {
  const dir = path.dirname(file)
  const overlayPath = path.join(dir, OVERLAY)
  const legacyPath = path.join(dir, OVERLAY_LEGACY)
  const found = isFile(overlayPath) ? overlayPath : isFile(legacyPath) ? legacyPath : undefined
  if (found === undefined) return Effect.succeed(registry)
  return Effect.gen(function* () {
    if (found === legacyPath) {
      yield* Effect.logWarning(
        "agent-models registry: legacy overlay name agent-models.local.jsonc is deprecated, rename to agent-models.disabled.jsonc",
        { path: legacyPath },
      )
    }
    const text = yield* Effect.promise(() => fs.promises.readFile(found, "utf8"))
    let data: unknown
    try {
      data = jsonc(text, found)
    } catch (error) {
      yield* Effect.logWarning("agent-models registry: broken overlay ignored", { path: found, error: String(error) })
      return registry
    }
    if (!isRecord(data)) return registry
    // Оверлей пишется внешним тулингом (/misc/sync-agent-models disable/enable)
    // списками отключения на верхнем уровне файла; ручная форма — под "availability",
    // как в базовом реестре. Принимаются обе, значения конкатенируются.
    const sources = [data, isRecord(data.availability) ? data.availability : {}]
    for (const source of sources) {
      for (const key of ["disabledProviders", "disabledModels"] as const) {
        const value = source[key]
        if (value === undefined) continue
        if (!Array.isArray(value)) {
          yield* Effect.logWarning(`agent-models registry: overlay "${key}" is not an array, ignored`, { path: found })
          continue
        }
        registry.availability[key] = [...registry.availability[key], ...value]
      }
    }
    return registry
  })
}

export const loadRegistry = Effect.fn("ConfigAgentModels.loadRegistry")(function* (input: {
  // Корень git-worktree; внутри него ищется .opencode/config/agent-models.jsonc.
  worktree: string
  // Рабочая директория: покрывает случай без git-репозитория, где worktree-поиск неприменим.
  directory: string
  // Глобальный конфигурационный каталог (~/.config/opencode).
  globalConfig: string
  // Значение ключа agent_models из конфигурации (опционально).
  configPath?: string
}) {
  // Путь из opencode.json (ключ agent_models): относительный путь неоднозначен
  // (относительно чего — worktree, directory, глобального файла?), поэтому
  // принимаются только абсолютные пути и формы от ~.
  let fromConfig: string | undefined
  if (typeof input.configPath === "string" && input.configPath !== "") {
    if (!input.configPath.startsWith("/") && !input.configPath.startsWith("~")) {
      yield* Effect.logWarning("agent-models registry: agent_models must be an absolute or ~-relative path, ignored", {
        path: input.configPath,
      })
    } else {
      fromConfig = input.configPath
    }
  }
  // Env задан, но файла нет — типовая опечатка при запуске; молча слой бы
  // выключился, и диагностировать это по логу невозможно.
  const envPath = process.env["OPENCODE_AGENT_MODELS"]
  if (envPath && !isFile(envPath)) {
    yield* Effect.logWarning(
      "agent-models registry: OPENCODE_AGENT_MODELS is set but the file does not exist, ignored",
      { path: envPath },
    )
  }
  if (fromConfig && !isFile(fromConfig)) {
    yield* Effect.logWarning("agent-models registry: agent_models points to a missing file, ignored", {
      path: fromConfig,
    })
    fromConfig = undefined
  }
  // worktree-корень — каноническое место .opencode; directory покрывает рабочую
  // директорию вне git-репозитория.
  const candidates = [
    envPath,
    fromConfig,
    path.join(input.worktree, ".opencode", "config", FILENAME),
    path.join(input.directory, ".opencode", "config", FILENAME),
    path.join(input.globalConfig, "config", FILENAME),
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
  const withoutComments = read
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim()
  if (withoutComments === "") {
    const registry = yield* applyOverlay(emptyRegistry(), file)
    yield* Effect.logInfo("agent-models registry: loaded (empty)", { path: file })
    return { status: "ok", registry }
  }
  let data: unknown
  try {
    data = jsonc(read, file)
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

function expandHome(base: string, home: string) {
  return base.startsWith("~") ? path.join(home, base.slice(1)) : base
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

type RoleResolution = { model?: string; reasoning?: string; warnings: string[] }

// Общая логика разрешения "capability[:N]" для файловых и builtin-ролей:
// warnings возвращаются данными — вызывающий логирует со своим контекстом.
function resolveRoleValue(
  registry: Registry,
  providersOff: Set<string>,
  modelsOff: Set<string>,
  value: string,
): RoleResolution {
  const warnings: string[] = []
  const [cap, levelRaw] = value.includes(":") ? (value.split(/:(.*)/, 2) as [string, string]) : [value, undefined]
  const levelStr = levelRaw === "" ? "0" : levelRaw
  if (levelStr !== undefined && !/^\d+$/.test(levelStr)) {
    warnings.push(`invalid reasoning level "${levelStr}"`)
    return { warnings }
  }
  const candidates = registry.capabilities[cap]
  if (!Array.isArray(candidates) || candidates.length === 0) {
    warnings.push(`unknown capability "${cap}"`)
    return { warnings }
  }
  let chosen: { model: string; entry: unknown } | undefined
  for (const alias of candidates) {
    if (typeof alias !== "string") {
      warnings.push("capability candidate is not a string")
      return { warnings }
    }
    if (modelsOff.has(alias)) continue
    const entry = registry.models[alias]
    const model = modelString(entry)
    // STRICT-ABORT: кандидат заявлен, но неразрешим — переход к следующему запрещён.
    // Строка модели обязана иметь вид "provider/id" с непустыми частями, чтобы
    // parse модели ниже по стеку не получал мусор.
    const parts = model === undefined ? [] : model.split("/")
    if (entry === undefined || model === undefined || model === "" || parts.length < 2 || parts.some((p) => p === "")) {
      warnings.push(`candidate "${alias}" has no valid provider/model entry, role unresolved`)
      return { warnings }
    }
    if (providersOff.has(model.split("/")[0])) continue
    chosen = { model, entry }
    break
  }
  if (!chosen) {
    warnings.push("all candidates disabled, role unresolved")
    return { warnings }
  }
  if (levelStr === undefined) return { model: chosen.model, warnings }
  const mapping = isRecord(chosen.entry) ? chosen.entry.reasoning : undefined
  const level = isRecord(mapping) ? mapping[String(Number(levelStr))] : undefined
  if (typeof level !== "string" || level === "") {
    warnings.push(`reasoning level ${Number(levelStr)} not found for selected model, applied without reasoning`)
    return { model: chosen.model, warnings }
  }
  return { model: chosen.model, reasoning: level, warnings }
}

export const applyRegistry = Effect.fn("ConfigAgentModels.applyRegistry")(function* (
  defs: ConfigMerge.Definition[],
  registry: Registry,
  home: string,
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
    // builtin:<name> обслуживается applyBuiltinRoles — файловой цели у него нет.
    if (key.startsWith("builtin:")) continue
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
    const base = expandHome(baseRaw, home)
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
      const analog = globalAnalogPath(expandHome(globalBaseRaw, home), base, target)
      if (analog && fs.existsSync(analog)) {
        const current = def.frontmatter.model
        if (!registry.force && typeof current === "string" && current !== "") {
          yield* Effect.logWarning("agent-models registry: global analog exists, frontmatter model drifts from it", {
            role: key,
            source: def.source,
          })
        }
        continue
      }
    }

    const current = def.frontmatter.model
    if (!registry.force && typeof current === "string" && current !== "") continue

    const resolved = resolveRoleValue(registry, providersOff, modelsOff, value)
    for (const message of resolved.warnings) yield* warn(message, { source: def.source })
    if (resolved.model === undefined) continue

    // Frontmatter может быть общим объектом между Definition с байт-идентичным
    // содержимым .md (кэш gray-matter по строке) — клонируем перед мутацией,
    // чтобы назначение не протекло в чужой слой.
    def.frontmatter = { ...def.frontmatter }
    def.frontmatter.model = resolved.model
    if (resolved.reasoning !== undefined) def.frontmatter.reasoningEffort = resolved.reasoning
  }
})

// Встроенные агенты без .md-файла (plan/build/general/explore/title/summary/compaction)
// назначаются ролью "builtin:<name>" через секцию agents конфига. Возвращает только
// назначенные имена со значениями в форме нативной секции agents: model — короткая
// строка "provider/id" (п принимается схемой ConfigModel.Selection), reasoning — в
// request.body.reasoningEffort. Явная модель в секции agents (opencode.json)
// побеждает — гейт, эквивалентный frontmatter для файловых определений.
const BUILTIN_AGENTS = ["plan", "build", "general", "explore", "title", "summary", "compaction"]

export const applyBuiltinRoles = Effect.fn("ConfigAgentModels.applyBuiltinRoles")(function* (
  agentSection: Record<string, unknown>,
  registry: Registry,
) {
  const assigned: Record<string, unknown> = {}
  const providersOff = disabledProviders(registry)
  const modelsOff = new Set(registry.availability.disabledModels)
  for (const [key, value] of Object.entries(registry.roles)) {
    if (!key.startsWith("builtin:")) continue
    const name = key.slice("builtin:".length)
    const warn = (reason: string) => Effect.logWarning(`agent-models registry: ${reason}`, { role: key, builtin: name })
    if (!BUILTIN_AGENTS.includes(name)) {
      yield* warn("unknown builtin agent, role skipped")
      continue
    }
    if (typeof value !== "string") {
      yield* warn("role value is not a string")
      continue
    }
    const resolved = resolveRoleValue(registry, providersOff, modelsOff, value)
    for (const message of resolved.warnings) yield* warn(message)
    if (resolved.model === undefined) continue
    const current = agentSection[name]
    const currentModel = isRecord(current) ? current.model : undefined
    if (!registry.force && currentModel !== undefined && currentModel !== "") continue
    const request = isRecord(current) && isRecord(current.request) ? current.request : {}
    const body = isRecord(request.body) ? request.body : {}
    const next: Record<string, unknown> = {
      ...(isRecord(current) ? current : {}),
      model: resolved.model,
      ...(resolved.reasoning !== undefined
        ? { request: { ...request, body: { ...body, reasoningEffort: resolved.reasoning } } }
        : {}),
    }
    agentSection[name] = next
    assigned[name] = next
  }
  return assigned
})
