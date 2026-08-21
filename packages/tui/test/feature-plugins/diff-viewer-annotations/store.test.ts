import { describe, expect, test } from "bun:test"
import { createAnnotationStore, editorTargetForLine } from "../../../src/feature-plugins/system/diff-viewer-annotations/store"
import type { DiffFile } from "../../../src/feature-plugins/system/diff-viewer-annotations/patch-lines"

const makeFile = (file: string, patch: string | undefined, status: DiffFile["status"] = "modified"): DiffFile => ({
  file,
  patch,
  additions: 1,
  deletions: 1,
  status,
})

const ORIGINAL = `--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,5 @@
 one
 two
-three
+three!
 four
 five`

const originalFile = makeFile("a.ts", ORIGINAL)
// Якорь — старая строка 3 («three»): окно в пределах ханка, k=3 → вся сторона файла.
const target = editorTargetForLine(originalFile, "old", 3, 1)

// UT-07 (FR-N7…N10, AC-06/07/13): CRUD, префилл, пустой ввод, уникальность ключа.
describe("store — create/edit/delete (UT-07)", () => {
  test("create adds a bound annotation; count and per-file counters update", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    expect(store.editor().kind).toBe("open")
    store.confirmEditor("поменяй")
    expect(store.count()).toBe(1)
    expect(store.annotationAt("a.ts", "old", 3)?.text).toBe("поменяй")
    expect(store.countForFile("a.ts")).toBe(1)
    expect(store.countForFile("other.ts")).toBe(0)
  })

  test("whitespace input cancels creation; edit keeps previous text", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("   ")
    expect(store.count()).toBe(0)
    expect(store.editor().kind).toBe("closed")

    store.openCreate(target)
    store.confirmEditor("текст")
    const id = store.annotationAt("a.ts", "old", 3)!.id
    store.openEdit(id)
    expect(store.editor().kind).toBe("open")
    const editor = store.editor() as { kind: "open"; initial: string }
    expect(editor.initial).toBe("текст")
    store.confirmEditor("\t \n")
    expect(store.annotationAt("a.ts", "old", 3)?.text).toBe("текст")
    expect(store.count()).toBe(1)
  })

  test("edit updates text in place", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("старый")
    const id = store.annotationAt("a.ts", "old", 3)!.id
    store.openEdit(id)
    store.confirmEditor("новый")
    expect(store.visibleAnnotations()).toHaveLength(1)
    expect(store.annotationAt("a.ts", "old", 3)?.text).toBe("новый")
  })

  test("one annotation per file+line+side: duplicate create rewrites the existing record", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("первый")
    store.openCreate(target)
    store.confirmEditor("второй")
    expect(store.count()).toBe(1)
    expect(store.annotationAt("a.ts", "old", 3)?.text).toBe("второй")
    // та же строка, другая сторона — отдельная запись
    store.openCreate(editorTargetForLine(originalFile, "new", 3, 1))
    store.confirmEditor("по новой стороне")
    expect(store.count()).toBe(2)
  })

  test("deleteAt removes exactly the keyed record", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("x")
    store.deleteAt("a.ts", "old", 3)
    expect(store.count()).toBe(0)
  })
})

// UT-08 (FR-S1/S2/Y4, AC-17/30): rebindAll против нового снапшота.
describe("store — rebindAll (UT-08)", () => {
  test("shifted patch rebinds bound and updates line", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("якорь")
    const shifted = makeFile(
      "a.ts",
      `--- a/a.ts
+++ b/a.ts
@@ -1,6 +1,6 @@
 zero
 one
 two
-three
+three!
 four
 five`,
    )
    store.rebindAll([shifted])
    const ann = store.visibleAnnotations()[0]
    expect(ann.state).toBe("bound")
    expect(ann.anchor.line).toBe(4)
  })

  test("diverged content marks unbound; nothing is silently removed", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("потеря")
    const diverged = makeFile(
      "a.ts",
      `--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,4 @@
 completely
 different
 content
-here`,
    )
    store.rebindAll([diverged])
    const ann = store.visibleAnnotations()[0]
    expect(ann.state).toBe("unbound")
    expect(ann.text).toBe("потеря")
    expect(store.count()).toBe(1)
  })

  test("file removed from the new snapshot becomes unbound; deleted file has no targets", () => {
    const store = createAnnotationStore()
    store.openCreate(target)
    store.confirmEditor("x")
    store.rebindAll([])
    expect(store.visibleAnnotations()[0].state).toBe("unbound")

    const store2 = createAnnotationStore()
    store2.openCreate(target)
    store2.confirmEditor("y")
    store2.rebindAll([makeFile("a.ts", ORIGINAL, "deleted")])
    expect(store2.visibleAnnotations()[0].state).toBe("unbound")
  })
})
