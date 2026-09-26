import { describe, expect, test } from "bun:test"
import {
  parseReviewBatchChildren,
  reviewBatchItems,
  reviewBatchTerminal,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an unexpected string", "other"],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns structured metadata for non-pending states", () => {
    const structured = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "completed", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "error", structured })).toBe(structured)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "pending", structured: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})

describe("reviewBatchTerminal", () => {
  test("marks completed, failed and skipped as terminal", () => {
    expect(reviewBatchTerminal("completed")).toBe(true)
    expect(reviewBatchTerminal("failed")).toBe(true)
    expect(reviewBatchTerminal("skipped")).toBe(true)
  })

  test("keeps dispatch and running states non-terminal", () => {
    for (const status of ["pending", "validating", "creating", "created", "running"]) {
      expect(reviewBatchTerminal(status)).toBe(false)
    }
  })
})

describe("parseReviewBatchChildren", () => {
  test("parses dispatched and undispatched children", () => {
    expect(
      parseReviewBatchChildren([
        { iid: 12, sessionID: "ses_a", status: "running" },
        { iid: 13, status: "pending" },
      ]),
    ).toEqual([
      { iid: 12, sessionID: "ses_a", status: "running" },
      { iid: 13, status: "pending" },
    ])
  })

  test("keeps terminal failure reasons", () => {
    expect(parseReviewBatchChildren([{ iid: 12, status: "failed", error: "boom" }])).toEqual([
      { iid: 12, status: "failed", error: "boom" },
    ])
  })

  test("drops malformed entries and non-arrays", () => {
    expect(parseReviewBatchChildren(["x", null, [], { iid: "no" }, { status: "running" }, { iid: 1 }])).toEqual([])
    expect(parseReviewBatchChildren(undefined)).toEqual([])
  })
})

describe("reviewBatchItems", () => {
  const batch = { mrs: [{ iid: 12 }, { iid: 13 }, { iid: 14 }] }

  test("fills undispatched MRs from the start input as pending", () => {
    const metadata = { children: [{ iid: 13, sessionID: "ses_b", status: "running" }] }
    expect(reviewBatchItems({ batch }, metadata)).toEqual([
      { iid: 12, status: "pending" },
      { iid: 13, sessionID: "ses_b", status: "running" },
      { iid: 14, status: "pending" },
    ])
  })

  test("uses metadata alone for resume inputs without batch", () => {
    const metadata = {
      children: [
        { iid: 12, sessionID: "ses_a", status: "completed" },
        { iid: 13, status: "pending" },
      ],
    }
    expect(reviewBatchItems({}, metadata)).toEqual([
      { iid: 12, sessionID: "ses_a", status: "completed" },
      { iid: 13, status: "pending" },
    ])
  })

  test("prefers metadata state when an MR appears in both sources", () => {
    const metadata = { children: [{ iid: 12, sessionID: "ses_a", status: "running" }] }
    expect(reviewBatchItems({ batch: { mrs: [{ iid: 12 }] } }, metadata)).toEqual([
      { iid: 12, sessionID: "ses_a", status: "running" },
    ])
  })

  test("returns empty when neither source has data", () => {
    expect(reviewBatchItems({}, {})).toEqual([])
  })
})
