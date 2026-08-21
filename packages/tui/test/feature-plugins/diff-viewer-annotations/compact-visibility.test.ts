import { describe, expect, test } from "bun:test"
import {
  COMPACT_CONTEXT_RADIUS,
  compactPatchText,
  compactVisibilityMask,
} from "../../../src/feature-plugins/system/diff-viewer-annotations/compact-visibility"
import { parsePatchFileLines } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"

const PATCH = `--- a/a.ts
+++ b/a.ts
@@ -1,12 +1,12 @@
 ctx1
 ctx2
 ctx3
-old4
+new4
 ctx5
 ctx6
 ctx7
 ctx8
 ctx9
 ctx10
 ctx11
-old12
+new12`

// UT-10 (FR-8.3/8.4): маска видимости компакт-режима.
describe("compact-visibility — mask (UT-10)", () => {
  const parsed = parsePatchFileLines(PATCH)
  const mask = compactVisibilityMask(parsed)

  test("changed and service lines are always visible", () => {
    parsed.forEach((line, index) => {
      if (line.kind !== "context") expect(mask[index]).toBeTrue()
    })
  })

  test("context within ±radius of a change is visible, far context is hidden", () => {
    // Индексы: 3 ctx1 … 6 -old4/+new4(7) … 8 ctx5, 9 ctx6, 10 ctx7 …
    expect(mask[3]).toBeFalse() // ctx1 — дальше радиуса от обоих изменений
    expect(mask[4]).toBeTrue() // ctx2
    expect(mask[5]).toBeTrue() // ctx3
    expect(mask[8]).toBeTrue() // ctx5
    expect(mask[9]).toBeTrue() // ctx6
    expect(mask[10]).toBeFalse() // ctx7 — вне окон
    expect(mask[11]).toBeFalse() // ctx8
    expect(mask[12]).toBeFalse() // ctx9
  })

  test("close changes merge without holes: gap of 4 context lines is contiguous", () => {
    const close = parsePatchFileLines(`@@ -1,6 +1,6 @@
 a
-b
+c
 d
 e
 f
 g
-h
+i`)
    const mask = compactVisibilityMask(close)
    // Все контексты в пределах ±2 от изменённых строк: дыр нет.
    expect(mask.every(Boolean)).toBeTrue()
  })

  test("radius is ±2 by contract", () => {
    expect(COMPACT_CONTEXT_RADIUS).toBe(2)
  })

  test("file of only changed lines keeps everything", () => {
    const all = parsePatchFileLines("@@ -1,1 +1,2 @@\n-a\n+b\n+c")
    expect(compactVisibilityMask(all).every(Boolean)).toBeTrue()
  })
})

// UT-12: трансформация patch-текста и маска построены из одного источника;
// нумерация оставшихся строк не смещается.
describe("compact-visibility — patch text transform (UT-12)", () => {
  test("visible body lines keep exact kind/side/lineNumber after transform", () => {
    const parsed = parsePatchFileLines(PATCH)
    const mask = compactVisibilityMask(parsed)
    const transformed = parsePatchFileLines(compactPatchText(PATCH))
    // Суб-ханк добавляет заголовок — сверяем body-строки, а не весь массив.
    const expected = parsed.filter((_, index) => mask[index] && parsed[index].kind !== "service")
    const transformedBody = transformed.filter((line) => line.kind !== "service")
    expect(transformedBody).toHaveLength(expected.length)
    transformedBody.forEach((line, index) => {
      expect(line.kind).toBe(expected[index].kind)
      expect(line.side).toBe(expected[index].side)
      expect(line.lineNumber).toBe(expected[index].lineNumber)
    })
  })

  test("hunk splitting keeps numbering exact around hidden context", () => {
    const compact = compactPatchText(PATCH)!
    expect(compact).toContain("@@ -2,5 +2,5 @@")
    expect(compact).toContain("@@ -10,3 +10,3 @@")
    expect(compact).not.toContain("ctx1\n")
    expect(compact).not.toContain("ctx7")
    expect(compact).toContain("ctx6")
    expect(compact).toContain("ctx11")
  })

  test("no-op when nothing is hidden; empty patch stays empty", () => {
    const dense = "@@ -1,3 +1,3 @@\n-a\n+b\n c"
    expect(compactPatchText(dense)).toBe(dense)
    expect(compactPatchText(undefined)).toBeUndefined()
  })

  test("\\ No newline marker survives the transform", () => {
    const noNl = "@@ -1,2 +1,2 @@\n ctx\n-a\n+b\n\\ No newline at end of file"
    const transformed = compactPatchText(noNl)!
    expect(transformed).toContain("\\ No newline at end of file")
  })
})
