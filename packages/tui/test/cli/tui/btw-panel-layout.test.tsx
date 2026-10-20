/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import type { SessionInfo } from "@opencode/client"
import { SESSION_SIDEBAR_WIDTH } from "../../../src/ui/layout"
import { createAppFixture } from "../../fixture/app"
import { directory, json } from "../../fixture/tui-client"
import { tmpdir } from "../../fixture/fixture"

// Раскладка btw-панели в реальном фрейме сессии:
//  1. панель и основная колонка делят строку сессии ровно пополам (50/50);
//  2. открытая панель не трогает сайдбар сессии — он остаётся смонтированным
//     до открытия, во время и после закрытия (same renderable, те же 42 колонки).

async function createSessionFixture(state: string, input: { width?: number } = {}) {
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
      // Sidebar visible by width (auto + >120 columns), so the test can pin it across btw open/close.
      session: { sidebar: "auto" },
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

test.each([160, 161])("btw panel splits the session area in half and keeps the sidebar mounted at width %i", async (width) => {
  await using state = await tmpdir()
  await using setup = await createSessionFixture(state.path, { width })
  await ready(setup)

  const sidebarBefore = sidebar(setup)
  const content = () => node(setup, "session-content")
  expect(setup.renderer.root.findDescendantById("btw-panel")).toBeUndefined()
  // Session row = terminal width minus the sidebar columns; let the flex layout settle
  // (startup frames may transiently measure mid-mount) before pinning the baseline.
  const rowWidth = sidebarBefore.x
  await setup.waitFor(() => content().width === rowWidth)
  const contentBefore = content().width

  await openBtw(setup)

  const btw = node(setup, "btw-panel")
  const sidebarDuring = sidebar(setup)
  // Halves of an odd session row differ by one column (floor split).
  expect(Math.abs(btw.width - content().width)).toBeLessThanOrEqual(1)
  expect(content().width + btw.width).toBe(rowWidth)
  expect(btw.x).toBe(content().x + content().width)
  expect(sidebarDuring).toBe(sidebarBefore)
  expect(sidebarDuring.x).toBe(btw.x + btw.width)
  expect(content().width).toBeGreaterThan(0)

  await closeBtw(setup)

  await setup.waitFor(() => content().width === rowWidth)
  expect(setup.renderer.root.findDescendantById("btw-panel")).toBeUndefined()
  expect(sidebar(setup)).toBe(sidebarBefore)
  expect(content().width).toBe(contentBefore)
})
