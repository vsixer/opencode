import { isRecord } from "./record"

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
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
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}
