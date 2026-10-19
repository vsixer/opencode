import { describe, expect, mock, test } from "bun:test"
import { TuiKeybind } from "../../../src/config/keybind"

// Пользовательский конфиг приходит извне как unknown — deprecated/неизвестные ключи
// проверяются в рантайме parse(), поэтому вход типизируется намеренно свободно.
const asOverrides = (input: object) => input as unknown as TuiKeybind.KeybindOverrides

// UT-12 (FR-D9, AC-02): deprecated-биндинг не ломает старт — parse не бросает, возвращает
// дефолты, фиксирует предупреждение; неизвестное имя вне deprecated-списка — throw.
describe("keybind — deprecated allowlist (UT-12)", () => {
  test("diffann_open is ignored with a warning; defaults returned", () => {
    const warn = mock((_message: string) => {})
    const original = console.warn
    console.warn = warn as unknown as typeof console.warn
    try {
      const parsed = TuiKeybind.parse(asOverrides({ diffann_open: "<leader>d" }))
      expect(parsed["diff.toggle"]).toBe("none")
      expect(parsed["diff.annotate"]).toBe("return")
      expect(warn).toHaveBeenCalled()
      expect(warn.mock.calls[0]?.[0]).toContain("diffann_open")
    } finally {
      console.warn = original
    }
  })

  test("unknown key outside the deprecated set still throws", () => {
    expect(() => TuiKeybind.parse(asOverrides({ totally_bogus: "a" }))).toThrow(/Unrecognized keybind/)
  })

  test("fork annotation bindings keep their defaults", () => {
    expect(TuiKeybind.defaultValue("diff.annotate")).toBe("return")
    expect(TuiKeybind.defaultValue("diff.annotate_delete")).toBe("D")
    expect(TuiKeybind.defaultValue("diff.annotations_panel")).toBe("a")
    expect(TuiKeybind.defaultValue("diff.scroll.down")).toBe("shift+j")
    expect(TuiKeybind.defaultValue("diff.scroll.up")).toBe("shift+k")
    expect(TuiKeybind.defaultValue("diff.open_file")).toBe("e")
  })
})

// FR-6: diff открывается командой «diff.open»; deprecated-кейсы UT-12 не регрессируют.
describe("keybind — diff.open binding", () => {
  test("default is unbound and config resolves the command", () => {
    expect(TuiKeybind.defaultValue("diff.open")).toBe("none")
    expect(TuiKeybind.parse(asOverrides({ "diff.open": "<leader>d" }))["diff.open"]).toBe("<leader>d")
    expect(TuiKeybind.parse(asOverrides({}))["diff.open"]).toBe("none")
  })
})
