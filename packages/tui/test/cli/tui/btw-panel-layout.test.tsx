/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import type { SessionInfo } from "@opencode/client"
import { SESSION_SIDEBAR_WIDTH } from "../../../src/ui/layout"
import { createAppFixture } from "../../fixture/app"
import { directory, json } from "../../fixture/tui-client"
import { tmpdir } from "../../fixture/fixture"

// Раскладка btw-панели в реальном фрейме сессии:
//  1. открытая панель на время своей жизни прячет сайдбар сессии — панель и
//     основная колонка делят полную ширину строки сессии ровно пополам (50/50);
//  2. закрытие восстанавливает прежнюю видимость сайдбара: видимый до открытия
//     возвращается, скрытый до открытия остаётся скрытым.

async function createSessionFixture(
  state: string,
  input: { width?: number; sidebar?: "auto" | "hide" } = {},
) {
  const session = {
    id: `ses_btw_layout_${crypto.randomUUID()}`,
    title: "Btw layout fixture",
    projectID: "proj_btw_layout",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 12 },
  } satisfies SessionInfo
  const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
  const setup = await createAppFixture({
    width: input.width ?? 160,
    height: 36,
    state,
    args: { sessionID: session.id },
    config: {
      animations: false,
      tabs: { enabled: false },
      // "auto" keeps the sidebar visible by width (>120 columns), so the test can
      // pin its absence during btw and its return after closing.
      session: { sidebar: input.sidebar ?? "auto" },
      diffs: { tree: false, view: "unified" },
    },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs") return json({ location, data: { branch: { current: "panel", default: "v2" } } })
      if (url.pathname === "/api/vcs/base")
        return json({ location, data: { name: "v2", ref: "refs/heads/v2", source: "default" } })
      if (url.pathname === "/api/vcs/diff") return json({ location, data: [] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: Array.from({ length: 12 }, (_, index) => ({
            id: `msg_btw_layout_${String(index).padStart(2, "0")}`,
            type: "user",
            text: `Transcript item ${index}`,
            time: { created: index + 1 },
          })).toReversed(),
          cursor: {},
        })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/form`) return json({ data: [] })
      if (url.pathname === "/api/btw/open") return json({ btwID: `btw_${session.id}` })
      if (url.pathname === "/api/btw/close" || url.pathname === "/api/btw/abort") return json({ ok: true })
      return undefined
    },
  })
  return setup
}

type AppFixture = Awaited<ReturnType<typeof createAppFixture>>

async function ready(setup: AppFixture) {
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Transcript item 11") && frame.includes("Build · Model Fixture"), {
    maxPasses: 120,
  })
}

function node(setup: AppFixture, id: string) {
  const result = setup.renderer.root.findDescendantById(id)
  if (!result) throw new Error(`Missing renderable: ${id}\n${setup.captureCharFrame()}`)
  return result
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((item) => [item, ...descendants(item)])
}

/** The session sidebar box: full-height columns pinned to the right edge of the terminal. */
function sidebar(setup: AppFixture): Renderable {
  const matches = descendants(setup.renderer.root).filter(
    (item) => item.width === SESSION_SIDEBAR_WIDTH && item.x + item.width === setup.renderer.width,
  )
  const deepest = matches.at(-1)
  if (!deepest) throw new Error(`Session sidebar is not visible\n${setup.captureCharFrame()}`)
  return deepest
}

function sidebarMounted(setup: AppFixture): boolean {
  return descendants(setup.renderer.root).some(
    (item) => item.width === SESSION_SIDEBAR_WIDTH && item.x + item.width === setup.renderer.width,
  )
}

async function openBtw(setup: AppFixture) {
  setup.mockInput.typeText("/btw")
  await setup.waitForFrame((frame) => frame.includes("Open btw side chat"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("btw — side chat"))
  await setup.flush()
}

async function closeBtw(setup: AppFixture) {
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("p")
  await setup.waitFor(() => !setup.renderer.root.findDescendantById("btw-panel"))
  await setup.flush()
}

test.each([160, 161])("btw panel hides the sidebar and splits the full session row in half at width %i", async (width) => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width })
  await ready(setup)

  const content = () => node(setup, "session-content")
  expect(setup.renderer.root.findDescendantById("btw-panel")).toBeUndefined()
  // Vertical tabs are disabled, so the session row is the whole terminal; let the
  // flex layout settle (startup frames may transiently measure mid-mount).
  const rowWidth = setup.renderer.width
  await setup.waitFor(() => content().width === rowWidth - SESSION_SIDEBAR_WIDTH)
  const contentBefore = content().width
  const sidebarBeforeX = sidebar(setup).x

  await openBtw(setup)

  const btw = node(setup, "btw-panel")
  // The sidebar is hidden while btw is open: panel and main column split the
  // whole row. Halves of an odd row differ by one column (floor split).
  expect(sidebarMounted(setup)).toBe(false)
  expect(Math.abs(btw.width - content().width)).toBeLessThanOrEqual(1)
  expect(content().width + btw.width).toBe(rowWidth)
  expect(btw.x).toBe(content().x + content().width)
  expect(content().width).toBeGreaterThan(0)

  await closeBtw(setup)

  await setup.waitFor(() => content().width === contentBefore)
  expect(setup.renderer.root.findDescendantById("btw-panel")).toBeUndefined()
  const sidebarAfter = sidebar(setup)
  expect(sidebarAfter.width).toBe(SESSION_SIDEBAR_WIDTH)
  expect(sidebarAfter.x).toBe(sidebarBeforeX)
})

test("btw leaves an already hidden sidebar hidden after closing", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 160, sidebar: "hide" })
  await ready(setup)

  const content = () => node(setup, "session-content")
  expect(sidebarMounted(setup)).toBe(false)
  await setup.waitFor(() => content().width === setup.renderer.width)

  await openBtw(setup)

  const btw = node(setup, "btw-panel")
  expect(sidebarMounted(setup)).toBe(false)
  expect(Math.abs(btw.width - content().width)).toBeLessThanOrEqual(1)

  await closeBtw(setup)

  await setup.waitFor(() => content().width === setup.renderer.width)
  expect(setup.renderer.root.findDescendantById("btw-panel")).toBeUndefined()
  expect(sidebarMounted(setup)).toBe(false)
})

test("the sidebar toggle stays inert while btw is open", async () => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width: 160 })
  await ready(setup)

  const content = () => node(setup, "session-content")
  const rowWidth = setup.renderer.width
  await setup.waitFor(() => content().width === rowWidth - SESSION_SIDEBAR_WIDTH)

  await openBtw(setup)
  expect(sidebarMounted(setup)).toBe(false)

  // <leader>v (session.sidebar.toggle) must not fight the btw overlay: the
  // sidebar stays hidden and the split stays intact.
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("v")
  await setup.flush()
  expect(sidebarMounted(setup)).toBe(false)
  expect(setup.renderer.root.findDescendantById("btw-panel")).toBeDefined()
  expect(content().width + node(setup, "btw-panel").width).toBe(rowWidth)

  await closeBtw(setup)
  // The ignored toggle must not have persisted a hide: the sidebar returns.
  await setup.waitFor(() => content().width === rowWidth - SESSION_SIDEBAR_WIDTH)
  expect(sidebarMounted(setup)).toBe(true)
})
