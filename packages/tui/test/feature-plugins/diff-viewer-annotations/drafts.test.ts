import { afterEach, describe, expect, test } from "bun:test"
import {
  disposeDraft,
  draftExists,
  getOrCreateDraft,
  resetDrafts,
  SESSIONLESS_OWNER,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/drafts"
import { editorTargetForLine } from "../../../src/feature-plugins/system/diff-viewer-annotations/store"

afterEach(() => resetDrafts())

// UT-11 (FR-C1/C5, AC-34/35): изоляция черновиков по владельцу; повторное получение — тот же
// стор; dispose очищает.
describe("drafts — owner-keyed registry (UT-11)", () => {
  test("drafts of different owners do not mix", () => {
    const first = getOrCreateDraft("sess-1")
    const second = getOrCreateDraft("sess-2")
    const sessionless = getOrCreateDraft(SESSIONLESS_OWNER)

    first.openCreate(editorTargetForLine({ file: "a.ts", patch: undefined, additions: 0, deletions: 0, status: "modified" }, "old", 1, 1))
    first.confirmEditor("для первой сессии")

    expect(first.count()).toBe(1)
    expect(second.count()).toBe(0)
    expect(sessionless.count()).toBe(0)
    expect(SESSIONLESS_OWNER).toBe("__sessionless")
  })

  test("getOrCreateDraft returns the same store for the same owner", () => {
    const first = getOrCreateDraft("sess-1")
    const again = getOrCreateDraft("sess-1")
    expect(again).toBe(first)
    expect(draftExists("sess-1")).toBe(true)
  })

  test("disposeDraft clears the owner entry", () => {
    const store = getOrCreateDraft("sess-1")
    store.openCreate(editorTargetForLine({ file: "a.ts", patch: undefined, additions: 0, deletions: 0, status: "modified" }, "old", 1, 1))
    store.confirmEditor("x")
    disposeDraft("sess-1")
    expect(draftExists("sess-1")).toBe(false)
    // новый черновик того же владельца — пуст
    expect(getOrCreateDraft("sess-1").count()).toBe(0)
  })
})
