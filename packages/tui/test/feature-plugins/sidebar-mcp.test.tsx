/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, reconcile } from "solid-js/store"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarMcp } from "../../src/feature-plugins/sidebar/mcp"

// Секция MCP в сайдбаре сессии:
//  1. свёрнута по умолчанию (initial {open:false}) — виден только заголовок со счётчиком;
//  2. клик по заголовку сворачивает/разворачивает при любом числе серверов —
//     прежнего исключения «≤ 2 серверов всегда развёрнуты и не кликаются» больше нет;
//  3. сохранённое состояние (storage «view») главнее initial — явное {open:true}
//     разворачивает секцию даже при дефолте «свёрнуто».

type View = { open: boolean }

function harness(input: { servers: number; saved?: View }) {
  const color = RGBA.fromInts(200, 200, 200)
  let capturedInitial: View | undefined
  const storage = {
    store(_key: string, options: { readonly initial: View }) {
      capturedInitial = structuredClone(options.initial)
      const [store, setStore] = createStore<View>(structuredClone(input.saved ?? options.initial))
      return [
        store,
        (mutation: (draft: View) => void) => {
          // Spread reads through the Solid proxy into a plain object (structuredClone would throw on it).
          const draft = { ...store }
          mutation(draft)
          setStore(reconcile(draft))
          return Promise.resolve()
        },
      ] as const
    },
  }
  const servers = Array.from({ length: input.servers }, (_, index) => ({
    name: `server${index + 1}`,
    status: { status: index === 0 ? "connected" : "failed" },
  }))
  const context = {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { success: { base: color }, error: { base: color }, warning: { base: color } },
      },
    },
    storage,
    data: {
      session: { get: () => ({ location: { directory: "/workspace" } }) },
      location: { mcp: { server: { list: () => servers } } },
    },
    ui: { dialog: { show: (_render: () => unknown) => {} } },
  } as unknown as Context
  return { context, capturedInitial: () => capturedInitial }
}

async function mount(input: { servers: number; saved?: View }) {
  const harnessResult = harness(input)
  const app = await testRender(() => <SidebarMcp context={harnessResult.context} sessionID="session" />, {
    width: 42,
    height: 8,
  })
  return { ...app, capturedInitial: harnessResult.capturedInitial }
}

test("MCP section is collapsed by default with the active/error counter", async () => {
  const app = await mount({ servers: 3 })
  try {
    await app.renderOnce()
    expect(app.capturedInitial()).toEqual({ open: false })
    const frame = app.captureCharFrame()
    expect(frame).toContain("▶ MCP")
    expect(frame).toContain("(1 active, 2 errors)")
    expect(frame).not.toContain("server1")
    expect(frame).not.toContain("Connected")
  } finally {
    app.renderer.destroy()
  }
})

test("header click toggles the section at any server count", async () => {
  const app = await mount({ servers: 1 })
  try {
    await app.renderOnce()
    // Один сервер: раньше секция была принудительно развёрнута и не реагировала на клик.
    expect(app.captureCharFrame()).toContain("▶ MCP (1 active)")
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▼ MCP")
    expect(app.captureCharFrame()).toContain("server1")
    expect(app.captureCharFrame()).toContain("Connected")
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▶ MCP")
    expect(app.captureCharFrame()).not.toContain("server1")
  } finally {
    app.renderer.destroy()
  }
})

test("saved open state overrides the collapsed default", async () => {
  const app = await mount({ servers: 2, saved: { open: true } })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("▼ MCP")
    expect(frame).toContain("server1")
    expect(frame).not.toContain("active")
  } finally {
    app.renderer.destroy()
  }
})
