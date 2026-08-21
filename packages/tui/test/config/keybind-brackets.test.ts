import { describe, expect, test } from "bun:test"
import { Definitions, Keybinds, TuiKeybind } from "../../src/config/keybind"

// Дефолты [ / ]: next — «[», previous — «]»; пользовательский конфиг со старой
// раскладкой и с новой парсится одинаково, конфликт остаётся на совести слоя
// keymap (значения — валидные BindingValue).
describe("bracket hunk bindings", () => {
  test("defaults are swapped", () => {
    expect(TuiKeybind.defaultValue("diff_next_hunk")).toBe("[")
    expect(TuiKeybind.defaultValue("diff_previous_hunk")).toBe("]")
  })

  test("legacy and swapped user configs parse without throwing", () => {
    const legacy = Keybinds.parse({
      diff_next_hunk: "]",
      diff_previous_hunk: "[",
    })
    const swapped = Keybinds.parse({
      diff_next_hunk: "[",
      diff_previous_hunk: "]",
    })
    expect(legacy.diff_next_hunk).toBe("]")
    expect(swapped.diff_next_hunk).toBe("[")
  })

  test("unknown keys are rejected", () => {
    expect(() =>
      // @ts-expect-error намеренно неизвестный ключ
      Keybinds.parse({ diff_next_hunk_typo: "[" }),
    ).toThrow()
  })

  test("descriptions survive the swap", () => {
    expect(Definitions.diff_next_hunk.description).toBe("Jump to next diff hunk")
    expect(Definitions.diff_previous_hunk.description).toBe("Jump to previous diff hunk")
  })
})
