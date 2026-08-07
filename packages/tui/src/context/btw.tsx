import { createSignal } from "solid-js"
import { createSimpleContext } from "./helper"

// Реф на поле ввода панели btw. Через него команда cycle переключает фокус
// между основным промптом и btw, а также опрашивает, кто сейчас в фокусе.
export type BtwRef = {
  focused(): boolean
  focus(): void
  blur(): void
}

export type BtwContext = {
  // Текущая открытая панель. parentID — сессия, на контексте которой заморожен btw.
  state(): { parentID: string } | undefined
  open(parentID: string): void
  close(): void
  ref(): BtwRef | undefined
  setRef(ref: BtwRef | undefined): void
}

export const { use: useBtw, provider: BtwProvider } = createSimpleContext({
  name: "Btw",
  init: (): BtwContext => {
    const [state, setState] = createSignal<{ parentID: string } | undefined>()
    let current: BtwRef | undefined

    return {
      state,
      open(parentID) {
        setState({ parentID })
      },
      close() {
        setState(undefined)
      },
      ref() {
        return current
      },
      setRef(next) {
        current = next
      },
    }
  },
})
