import type { SideLine } from "./patch-lines"

// K — полуразмер окна отпечатка: K строк выше + сама строка + K строк ниже.
export const FINGERPRINT_K = 3

export type RebindResult = { readonly found: true; readonly newLine: number } | { readonly found: false }

// Перепривязка якоря по side-последовательности нового снапшота. Ищет window как
// непрерывный фрагмент; anchorOffset — зафиксированная при создании позиция якоря
// внутри окна (снимок FR-Y3). При нескольких совпадениях выбирается ближайший к
// originLine номер строки; при равенстве расстояний — меньший номер (детерминизм FR-Y2).
export function rebind(
  side: readonly SideLine[],
  window: readonly string[],
  anchorOffset: number,
  originLine: number,
): RebindResult {
  if (window.length === 0 || side.length < window.length) return { found: false }
  if (anchorOffset < 0 || anchorOffset >= window.length) return { found: false }
  const limit = side.length - window.length
  let best: number | null = null
  let bestDist = Infinity
  for (let start = 0; start <= limit; start++) {
    let match = true
    for (let i = 0; i < window.length; i++) {
      if (side[start + i].text !== window[i]) {
        match = false
        break
      }
    }
    if (!match) continue
    const candidate = side[start + anchorOffset].lineNumber
    const dist = Math.abs(candidate - originLine)
    // строгое < сохраняет первое (меньший номер) при равноудалённых совпадениях
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best === null ? { found: false } : { found: true, newLine: best }
}
