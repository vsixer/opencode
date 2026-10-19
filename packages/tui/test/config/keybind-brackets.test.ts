import { describe, expect, test } from "bun:test"
import { Definitions, TuiKeybind, type TuiKeybind as TuiKeybindTypes } from "../../src/config/keybind"

// Дефолты [ / ]: next — «]», previous — «[»; пользовательский конфиг с любой
// раскладкой парсится одинаково, конфликт остаётся на совести слоя keymap
// (значения — валидные BindingValue).
describe("bracket hunk bindings", () => {
  test("defaults are next ] / previous [", () => {
    expect(TuiKeybind.defaultValue("diff.next_hunk")).toBe("]")
    expect(TuiKeybind.defaultValue("diff.previous_hunk")).toBe("[")
  })

  test("swapped and legacy user configs parse without throwing", () => {
    const legacy = TuiKeybind.parse({
      "diff.next_hunk": "[",
      "diff.previous_hunk": "]",
    } satisfies TuiKeybindTypes.KeybindOverrides)
    const swapped = TuiKeybind.parse({
      "diff.next_hunk": "]",
      "diff.previous_hunk": "[",
    } satisfies TuiKeybindTypes.KeybindOverrides)
    expect(legacy["diff.next_hunk"]).toBe("[")
    expect(swapped["diff.next_hunk"]).toBe("]")
  })

  test("unknown keys are rejected", () => {
    expect(() =>
      // @ts-expect-error намеренно неизвестный ключ
      TuiKeybind.parse({ "diff.next_hunk_typo": "[" }),
    ).toThrow()
  })

  test("descriptions survive remapping", () => {
    expect(Definitions["diff.next_hunk"].description).toBe("Jump to next diff hunk")
    expect(Definitions["diff.previous_hunk"].description).toBe("Jump to previous diff hunk")
  })
})
