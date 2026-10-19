import { describe, expect, test } from "bun:test"
import {
  canonicalToolName,
  finiteNumber,
  parseReviewBatchChildren,
  primitiveInputSummary,
  reviewBatchItems,
  reviewBatchTerminal,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "subagent",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Web Search via Parallel")
    expect(webSearchProviderLabel("exa")).toBe("Web Search via Exa")
    expect(webSearchProviderLabel("firecrawl")).toBe("Web Search via Firecrawl")
    expect(webSearchProviderLabel("tavily")).toBe("Web Search via Tavily")
    expect(webSearchProviderLabel("opencode")).toBe("Web Search via OpenCode")
  })

  test("labels providers dynamically", () => {
    expect(webSearchProviderLabel("other")).toBe("Web Search via Other")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an empty string", ""],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns tool metadata for non-pending states", () => {
    const metadata = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "completed", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "error", metadata })).toBe(metadata)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", metadata: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: [] })).toEqual({})
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
