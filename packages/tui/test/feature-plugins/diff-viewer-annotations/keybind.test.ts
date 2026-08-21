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
      expect(parsed.diff_toggle).toBe("space")
      expect(parsed.diff_annotate).toBe("return")
      expect(warn).toHaveBeenCalled()
      expect(warn.mock.calls[0]?.[0]).toContain("diffann_open")
    } finally {
      console.warn = original
    }
  })

  test("unknown key outside the deprecated set still throws", () => {
    expect(() => TuiKeybind.parse(asOverrides({ totally_bogus: "a" }))).toThrow(/Unrecognized keybind/)
  })

  test("demolition: no live records reference the removed mode", () => {
    expect(TuiKeybind.defaultValue("diff_toggle")).toBe("space")
    expect(TuiKeybind.defaultValue("diff_annotate")).toBe("return")
    expect(TuiKeybind.defaultValue("diff_annotate_delete")).toBe("d")
    expect(TuiKeybind.defaultValue("diff_switch_source")).toBe("o")
    expect(TuiKeybind.defaultValue("diff_compact_toggle")).toBe("c")
    expect(TuiKeybind.defaultValue("diff_annotations_panel")).toBe("a")
    expect((TuiKeybind.CommandMap as Record<string, string | undefined>).diffann_open).toBeUndefined()
  })
})

// UT-K1 (FR-6, AC-14): дефолт <leader>d, override уважается, command map указывает
// на diff.open; deprecated-кейсы UT-12 не регрессируют.
describe("keybind — diff_open default binding (UT-K1)", () => {
  test("default is <leader>d and maps to diff.open", () => {
    expect(TuiKeybind.defaultValue("diff_open")).toBe("<leader>d")
    expect(TuiKeybind.CommandMap.diff_open).toBe("diff.open")
  })

  test("parse respects user override and empty config returns default", () => {
    expect(TuiKeybind.parse(asOverrides({ diff_open: "<leader>x" })).diff_open).toBe("<leader>x")
    expect(TuiKeybind.parse(asOverrides({})).diff_open).toBe("<leader>d")
    expect(TuiKeybind.parse(asOverrides({})).diff_toggle).toBe("space")
  })
})
