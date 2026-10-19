import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { isRecord } from "./record"

export function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

export function primitiveInputSummary(input: Record<string, unknown>, omit: readonly string[] = []) {
  const entries = Object.entries(input).filter(([key, value]) => {
    if (omit.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

export type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

export function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!isRecord(call)) return []
    const tool = call.tool
    const status = call.status
    if (typeof tool !== "string" || (status !== "running" && status !== "completed" && status !== "error")) return []
    return [{ tool, status, input: isRecord(call.input) ? call.input : undefined }]
  })
}

export function executeCallSummary(call: ExecuteCall) {
  const args = primitiveInputSummary(call.input ?? {}).replace(/\s+/g, " ")
  return `${call.tool}${args ? ` ${args}` : ""}`
}

export function webSearchProviderName(provider: unknown) {
  if (typeof provider !== "string" || !provider) return ""
  if (provider === "opencode") return "OpenCode"
  return `${provider[0].toUpperCase()}${provider.slice(1)}`
}

export function webSearchProviderLabel(provider: unknown) {
  const name = webSearchProviderName(provider)
  return name ? `Web Search via ${name}` : "Web Search"
}

// One entry per MR in a review_batch_run queue, as streamed through tool metadata.
// `sessionID` appears only after the MR has been dispatched to a child session;
// `error` only on terminal failures the queue could explain.
export type ReviewBatchChild = {
  iid: number
  status: string
  sessionID?: string
  error?: string
}

const reviewBatchTerminalStatuses = new Set(["completed", "failed", "skipped"])

export function reviewBatchTerminal(status: string) {
  return reviewBatchTerminalStatuses.has(status)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parseReviewBatchChildren(value: unknown): ReviewBatchChild[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const iid = numberValue(item.iid)
    const status = stringValue(item.status)
    if (iid === undefined || !status) return []
    const sessionID = stringValue(item.sessionID)
    const error = stringValue(item.error)
    return [
      {
        iid,
        status,
        ...(sessionID ? { sessionID } : {}),
        ...(error ? { error } : {}),
      },
    ]
  })
}

export function parseReviewBatchMrs(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.mrs)) return []
  return value.mrs.flatMap((mr) => {
    const iid = isRecord(mr) ? numberValue(mr.iid) : undefined
    return iid === undefined ? [] : [{ iid }]
  })
}

// Metadata children carry live queue state, but undispatched MRs have no child yet
// and resume inputs carry no batch at all, so the start input fills in pending MRs
// that metadata has not reached. Metadata wins per IID; batch order fills the gaps.
export function reviewBatchItems(input: Record<string, unknown>, metadata: Record<string, unknown>): ReviewBatchChild[] {
  const children = parseReviewBatchChildren(metadata.children)
  const byID = new Map(children.map((child) => [child.iid, child]))
  const items: ReviewBatchChild[] = []
  const seen = new Set<number>()
  for (const mr of parseReviewBatchMrs(input.batch)) {
    seen.add(mr.iid)
    items.push(byID.get(mr.iid) ?? { iid: mr.iid, status: "pending" })
  }
  for (const child of children) {
    if (!seen.has(child.iid)) items.push(child)
  }
  return items
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "streaming") return {}
  if (!("metadata" in state) || !state.metadata || typeof state.metadata !== "object") return {}
  if (Array.isArray(state.metadata)) return {}
  return state.metadata as Record<string, unknown>
}

export function toolDisplayContent(state: SessionMessageAssistantTool["state"]) {
  if (state.status === "streaming" || state.status === "running") return []
  return state.content ?? []
}

export function nonEmptyToolContent<T>(content: ReadonlyArray<T> | undefined): [T, ...T[]] | undefined {
  if (!content) return undefined
  const [first, ...rest] = content
  return first === undefined ? undefined : [first, ...rest]
}
