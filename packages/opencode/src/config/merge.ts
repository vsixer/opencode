export * as ConfigMerge from "./merge"

import { ConfigMergeV1 } from "@opencode-ai/core/v1/config/merge"
import { isRecord } from "@/util/record"

// Слоистое слияние определений (commands/agents/skills) при совпадении имён
// между слоями конфигурации (global ~/.config/opencode + project .opencode).
// Чистая синхронная трансформация данных: Effect здесь намеренно нет.

export type Definition = {
  // raw frontmatter ДО schema-decode (включая директиву `merge`)
  frontmatter: Record<string, unknown>
  // markdown-тело после отрезания frontmatter
  body: string
  // путь к файлу-источнику (для диагностики)
  source: string
  // метка слоя для provenance в show-merged ("global" | "project" | ...)
  layer?: string
}

export type Strategy = ConfigMergeV1.Strategy

export type Warning = {
  kind: "unknown-slot" | "duplicate-fill" | "invalid-strategy"
  message: string
  source?: string
}

export type Provenance = {
  // Каждый ключ итогового frontmatter → слой-источник
  frontmatter: Record<string, string>
  // Для permission — key-level provenance: "global" | "local" | "overridden"
  permission: Record<string, "global" | "local" | "overridden">
  // Состояние слотов тела
  slots: { filled: string[]; unfilled: string[]; unknown: string[] }
}

export type Composed = {
  frontmatter: Record<string, unknown>
  body: string
  warnings: Warning[]
  provenance: Provenance
  strategy: Strategy
  // источник winning-слоя (для diagnostics/decode-ошибок/show-merged)
  source: string
}

const DEFAULT_STRATEGY: Strategy = "append"

// --- Slot parser -------------------------------------------------------------

// Одиночный маркер точки вставки в теле глобали: <!-- slot: NAME -->
const SLOT_OPEN = /<!--\s*slot:\s*([\w.-]+)\s*-->/g
// Парный блок заполнения в теле локали: <!-- slot: NAME --> ... <!-- /slot: NAME -->
const SLOT_PAIR = /<!--\s*slot:\s*([\w.-]+)\s*-->\r?\n?([\s\S]*?)<!--\s*\/slot:\s*\1\s*-->/g

type Marker = { name: string; index: number; length: number }

function findSlotMarkers(body: string): Marker[] {
  const out: Marker[] = []
  for (const m of body.matchAll(SLOT_OPEN)) {
    if (m.index === undefined) continue
    out.push({ name: m[1], index: m.index, length: m[0].length })
  }
  return out
}

type Fills = {
  // имя → массив содержимого блоков (по порядку появления)
  map: Map<string, string[]>
  // leftover-текст вне блоков заполнения
  leftover: string
  // имена, у которых больше одного fill-блока
  duplicates: string[]
}

function extractFills(body: string): Fills {
  const map = new Map<string, string[]>()
  const ranges: { start: number; end: number }[] = []
  const counts = new Map<string, number>()
  const duplicates: string[] = []

  for (const m of body.matchAll(SLOT_PAIR)) {
    if (m.index === undefined) continue
    const name = m[1]
    const content = m[2].replace(/\r?\n$/, "")
    if (!map.has(name)) map.set(name, [])
    map.get(name)!.push(content)
    const count = (counts.get(name) ?? 0) + 1
    counts.set(name, count)
    if (count === 2) duplicates.push(name)
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }

  // Вырезаем парные блоки из тела, идём сверху-вниз чтобы индексы не смещались
  ranges.sort((a, b) => b.start - a.start)
  let leftover = body
  for (const r of ranges) leftover = leftover.slice(0, r.start) + leftover.slice(r.end)

  return { map, leftover: leftover.trim(), duplicates }
}

// --- Body composition --------------------------------------------------------

function composeBody(global: string, local: string, strategy: Strategy): {
  body: string
  slots: Provenance["slots"]
  warnings: Warning[]
} {
  const warnings: Warning[] = []

  // replace — только тело локали, слоты не обрабатываются.
  if (strategy === "replace") {
    return { body: local, slots: { filled: [], unfilled: [], unknown: [] }, warnings }
  }

  const markers = findSlotMarkers(global)
  const globalSlotNames = new Set(markers.map((m) => m.name))
  const fills = extractFills(local)

  const unknown = [...fills.map.keys()].filter((n) => !globalSlotNames.has(n))
  for (const name of unknown) {
    warnings.push({ kind: "unknown-slot", message: `slot "${name}" не объявлен в глобальном определении` })
  }
  for (const name of fills.duplicates) {
    warnings.push({ kind: "duplicate-fill", message: `slot "${name}" заполнен более одного раза — блоки склеены` })
  }

  const filled: string[] = []
  // Заменяем маркеры в теле глобали (снизу вверх), незаполненные — удаляем.
  const sorted = [...markers].sort((a, b) => b.index - a.index)
  let composed = global
  for (const m of sorted) {
    const arr = fills.map.get(m.name)
    if (arr && arr.length) {
      filled.push(m.name)
      composed = composed.slice(0, m.index) + arr.join("\n\n") + composed.slice(m.index + m.length)
    } else {
      composed = composed.slice(0, m.index) + composed.slice(m.index + m.length)
    }
  }
  composed = composed.replace(/\n{3,}/g, "\n\n").trim()

  const unfilled = [...globalSlotNames].filter((n) => !fills.map.has(n))

  // Локальный leftover (текст вне fill-блоков) комбинируется со склеенной глобалью.
  const parts = strategy === "prepend" ? [fills.leftover, composed] : [composed, fills.leftover]
  const body = parts.filter((p) => p && p.trim()).join("\n\n")

  return { body, slots: { filled, unfilled, unknown }, warnings }
}

// --- Frontmatter merge -------------------------------------------------------

function readStrategy(value: unknown): { strategy: Strategy; warning?: Warning } {
  if (value === undefined) return { strategy: DEFAULT_STRATEGY }
  if (value === "append" || value === "prepend" || value === "replace") return { strategy: value }
  return {
    strategy: DEFAULT_STRATEGY,
    warning: {
      kind: "invalid-strategy",
      message: `невалидное значение merge (${String(value)}), использовано "${DEFAULT_STRATEGY}"`,
    },
  }
}

// permission — shallow per-key: local перекрывает global по ключу.
// Sub-record (permission.edit = {...}) замещается целиком — это и есть shallow per-key.
function mergePermission(
  global: Record<string, unknown>,
  local: Record<string, unknown>,
): { value: Record<string, unknown>; provenance: Record<string, "global" | "local" | "overridden"> } {
  const value: Record<string, unknown> = { ...global }
  const provenance: Record<string, "global" | "local" | "overridden"> = {}
  for (const k of Object.keys(global)) provenance[k] = "global"
  for (const k of Object.keys(local)) {
    provenance[k] = k in global ? "overridden" : "local"
    value[k] = local[k]
  }
  return { value, provenance }
}

// скаляры и объекты/массивы — wholesale local-wins; permission — per-key.
function mergeFrontmatter(
  global: Record<string, unknown>,
  local: Record<string, unknown>,
  globalLabel: string,
  localLabel: string,
): {
  frontmatter: Record<string, unknown>
  frontmatterProvenance: Record<string, string>
  permissionProvenance: Record<string, "global" | "local" | "overridden">
} {
  const frontmatter: Record<string, unknown> = {}
  const frontmatterProvenance: Record<string, string> = {}
  let permissionProvenance: Record<string, "global" | "local" | "overridden"> = {}

  for (const [k, v] of Object.entries(global)) {
    frontmatter[k] = v
    frontmatterProvenance[k] = globalLabel
  }

  for (const [k, v] of Object.entries(local)) {
    if (k === "permission" && isRecord(frontmatter.permission) && isRecord(v)) {
      const merged = mergePermission(frontmatter.permission as Record<string, unknown>, v)
      frontmatter.permission = merged.value
      permissionProvenance = merged.provenance
      frontmatterProvenance.permission = localLabel
      continue
    }
    frontmatter[k] = v
    frontmatterProvenance[k] = localLabel
  }

  return { frontmatter, frontmatterProvenance, permissionProvenance }
}

// --- Public API --------------------------------------------------------------

export function compose(global: Definition, local: Definition): Composed {
  const globalLabel = global.layer ?? "global"
  const localLabel = local.layer ?? "local"
  const { strategy, warning } = readStrategy(local.frontmatter.merge)

  const fm = mergeFrontmatter(global.frontmatter, local.frontmatter, globalLabel, localLabel)
  const body = composeBody(global.body, local.body, strategy)

  const warnings = [...body.warnings]
  if (warning) warnings.push(warning)

  return {
    frontmatter: fm.frontmatter,
    body: body.body,
    warnings,
    provenance: {
      frontmatter: fm.frontmatterProvenance,
      permission: fm.permissionProvenance,
      slots: body.slots,
    },
    strategy,
    // winning-источник — локаль (верхний слой); она определяет финальное поведение.
    source: local.source || global.source,
  }
}

// N-layer fold: первый слой — база, каждый следующий композится поверх аккумулятора.
// Обрабатывает произвольное число project .opencode вверх по дереву + глобальные слои.
export function fold(layers: Definition[]): Composed {
  if (layers.length === 0) {
    return {
      frontmatter: {},
      body: "",
      warnings: [],
      provenance: { frontmatter: {}, permission: {}, slots: { filled: [], unfilled: [], unknown: [] } },
      strategy: DEFAULT_STRATEGY,
      source: "",
    }
  }

  const [first, ...rest] = layers
  const baseLabel = first.layer ?? "global"
  let acc: Composed = {
    frontmatter: { ...first.frontmatter },
    body: first.body,
    warnings: [],
    provenance: {
      frontmatter: Object.fromEntries(Object.keys(first.frontmatter).map((k) => [k, baseLabel])),
      permission: {},
      slots: { filled: [], unfilled: [], unknown: [] },
    },
    strategy: DEFAULT_STRATEGY,
    source: first.source,
  }

  // Если базовый слой уже объявляет permission — фиксируем его provenance.
  if (isRecord(first.frontmatter.permission)) {
    for (const k of Object.keys(first.frontmatter.permission)) acc.provenance.permission[k] = "global"
  }

  for (const next of rest) {
    acc = compose({ frontmatter: acc.frontmatter, body: acc.body, source: acc.source, layer: baseLabel }, next)
  }

  return acc
}

// Слой с меткой global/project и картой raw-определений этого слоя.
export type LayerMap = { layer: string; map: Record<string, Definition> }

// Для каждого имени собирает упорядоченный список слоёв и fold'ит.
// Возвращает Composed по каждому имени (frontmatter ещё raw, до schema-decode).
export function foldEntries(layers: LayerMap[]): Record<string, Composed> {
  const names = new Set<string>()
  for (const l of layers) for (const n of Object.keys(l.map)) names.add(n)

  const out: Record<string, Composed> = {}
  for (const name of names) {
    const defs: Definition[] = []
    for (const l of layers) {
      const d = l.map[name]
      if (d) defs.push({ ...d, layer: l.layer })
    }
    if (defs.length === 1) {
      const d = defs[0]
      const label = d.layer ?? "global"
      out[name] = {
        frontmatter: { ...d.frontmatter },
        body: d.body,
        warnings: [],
        provenance: {
          frontmatter: Object.fromEntries(Object.keys(d.frontmatter).map((k) => [k, label])),
          permission: {},
          slots: { filled: [], unfilled: [], unknown: [] },
        },
        strategy: DEFAULT_STRATEGY,
        source: d.source,
      }
    } else {
      out[name] = fold(defs)
    }
  }
  return out
}
