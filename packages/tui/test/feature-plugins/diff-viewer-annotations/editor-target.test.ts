import { describe, expect, test } from "bun:test"
import { resolveEditableFile } from "../../../src/feature-plugins/system/diff-viewer-annotations/editor-target"

// UT-70 (FR-7/FR-8): выбор стороны diff-файла для внешнего редактора.
describe("resolveEditableFile — side resolution from patch headers (UT-70)", () => {
  const existsOnly = (...present: string[]) => (candidate: string) => present.includes(candidate)

  test("modified file: new side exists → open it", () => {
    const result = resolveEditableFile({
      file: "src/file.ts",
      patch: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,1 +1,1 @@\n-one\n+new",
      exists: existsOnly("src/file.ts"),
    })
    expect(result).toEqual({ path: "src/file.ts" })
  })

  test("rename: old absent, new present → new path (AC-10)", () => {
    const result = resolveEditableFile({
      file: "old.ts",
      patch: "--- a/old.ts\n+++ b/renamed.ts\n@@ -1,1 +1,1 @@\n-x\n+x",
      exists: existsOnly("renamed.ts"),
    })
    expect(result).toEqual({ path: "renamed.ts" })
  })

  test("both sides present → new side preferred", () => {
    const result = resolveEditableFile({
      file: "old.ts",
      patch: "--- a/old.ts\n+++ b/renamed.ts\n@@ -1,1 +1,1 @@\n-x\n+x",
      exists: existsOnly("old.ts", "renamed.ts"),
    })
    expect(result).toEqual({ path: "renamed.ts" })
  })

  test("deleted file, neither side exists → missing (AC-9)", () => {
    const result = resolveEditableFile({
      file: "gone.ts",
      patch: "--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-only line",
      exists: existsOnly(),
    })
    expect(result).toEqual({ missing: true })
  })

  test("deleted file, old path exists on disk → old side", () => {
    const result = resolveEditableFile({
      file: "gone.ts",
      patch: "--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-only line",
      exists: existsOnly("gone.ts"),
    })
    expect(result).toEqual({ path: "gone.ts" })
  })

  test("new file: --- /dev/null, new side exists → new path", () => {
    const result = resolveEditableFile({
      file: "fresh.ts",
      patch: "--- /dev/null\n+++ b/fresh.ts\n@@ -0,0 +1,1 @@\n+hello",
      exists: existsOnly("fresh.ts"),
    })
    expect(result).toEqual({ path: "fresh.ts" })
  })

  test("quoted path with spaces is unquoted", () => {
    const result = resolveEditableFile({
      file: "foo bar.ts",
      patch: '--- a/foo.ts\n+++ "b/foo bar.ts"\n@@ -1,1 +1,1 @@\n-x\n+x',
      exists: existsOnly("foo bar.ts"),
    })
    expect(result).toEqual({ path: "foo bar.ts" })
  })

  test("no-newline trailer and hunk body lines do not confuse header parsing", () => {
    const result = resolveEditableFile({
      file: "f.ts",
      patch: "--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file",
      exists: existsOnly("f.ts"),
    })
    expect(result).toEqual({ path: "f.ts" })
  })

  test("header timestamp after tab is stripped", () => {
    const result = resolveEditableFile({
      file: "f.ts",
      patch: "--- a/f.ts\t2026-01-01 00:00:00\n+++ b/f.ts\t2026-01-01 00:00:00\n@@ -1,1 +1,1 @@\n-x\n+x",
      exists: existsOnly("f.ts"),
    })
    expect(result).toEqual({ path: "f.ts" })
  })

  test("no headers at all → file fallback: exists → open, absent → missing", () => {
    const ok = resolveEditableFile({ file: "plain.ts", patch: "", exists: existsOnly("plain.ts") })
    expect(ok).toEqual({ path: "plain.ts" })
    const bad = resolveEditableFile({ file: "plain.ts", patch: undefined, exists: existsOnly() })
    expect(bad).toEqual({ missing: true })
  })

  test("binary patch without headers, file absent → missing", () => {
    const result = resolveEditableFile({
      file: "logo.png",
      patch: "Binary files differ",
      exists: existsOnly(),
    })
    expect(result).toEqual({ missing: true })
  })
})
