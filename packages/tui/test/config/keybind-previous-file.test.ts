import { describe, expect, test } from "bun:test"
import { TuiKeybind, type TuiKeybind as TuiKeybindTypes } from "../../src/config/keybind"

// Дефолт предыдущего файла — «p» (плюс alt+up); конфиг с чистым «p»
// по-прежнему парсится (значение валидно, поведение — на совести слоя keymap).
describe("diff.previous_file default keybind", () => {
  test("default is p", () => {
    expect(TuiKeybind.defaultValue("diff.previous_file")).toBe("p,alt+up")
  })

  test("plain p user config still parses", () => {
    const parsed = TuiKeybind.parse({
      "diff.previous_file": "p",
    } satisfies TuiKeybindTypes.KeybindOverrides)
    expect(parsed["diff.previous_file"]).toBe("p")
  })
})
