/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { TuiKeybind } from "../src/config/keybind"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

// Команды btw регистрируются в app.tsx с bind:false, поэтому их биндинг существует
// только если идёнкоманда есть в списке bindings-слоя (appBindingCommands).
// Пропуск записи молча отключает и дефолт (<leader>b / <leader>p), и оверрайд из cli.json.

test("btw commands are listed in the app bindings layer", async () => {
  const { appBindingCommands } = await import("../src/app")
  expect(appBindingCommands).toContain("session.btw")
  expect(appBindingCommands).toContain("session.btw.close")
})

async function bootHarness(keybinds?: Partial<TuiKeybind.Keybinds>) {
  const { appBindingCommands } = await import("../src/app")
  let read = () => ({ btw: [] as string[], close: [] as string[] })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    // Точная форма подключения из app.tsx: слой команд с bind:false плюс отдельный слой bindings.
    Keymap.createLayer(() => ({
      commands: [{ id: "session.btw", run() {} }, { id: "session.btw.close", run() {} }].map(
        ({ id, ...command }) =>
          ({ id, group: "Session", bind: false, palette: true as const, ...command }) as const,
      ),
    }))
    Keymap.createLayer(() => ({
      bindings: appBindingCommands,
    }))
    read = () => ({
      btw: shortcuts.list("session.btw"),
      close: shortcuts.list("session.btw.close"),
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig({ keybinds })}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  return { app, read }
}

test("btw defaults resolve through the app wiring shape", async () => {
  const { app, read } = await bootHarness()
  try {
    const result = read()
    expect(result.btw.length).toBeGreaterThan(0)
    expect(result.close.length).toBeGreaterThan(0)
  } finally {
    app.renderer.destroy()
  }
})

test("configured override replaces the btw default", async () => {
  const { app, read } = await bootHarness({ "session.btw": "ctrl+shift+b", "session.btw.close": "none" })
  try {
    const result = read()
    expect(result.btw.map((key) => key.toLowerCase())).toEqual(["ctrl+shift+b"])
    expect(result.close).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
