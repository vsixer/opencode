import { describe, expect, test } from "bun:test"
import { Keybinds, TuiKeybind } from "../../src/config/keybind"

// UT-72 (FR-3/FR-4): дефолт предыдущего файла — N; старый p уходит, конфиг
// с легаси-значением по-прежнему парсится (значение валидно, поведение — на
// совести слоя keymap, как в keybind-brackets.test.ts).
describe("diff_previous_file default keybind (UT-72)", () => {
  test("default is N", () => {
    expect(TuiKeybind.defaultValue("diff_previous_file")).toBe("N")
  })

  test("legacy user config with p still parses", () => {
    const parsed = Keybinds.parse({ diff_previous_file: "p" })
    expect(parsed.diff_previous_file).toBe("p")
  })
})
