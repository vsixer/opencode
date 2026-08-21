// Отображение путей и ширины колонки номеров в листинге аннотаций:
// basename с минимальной дизамбигуацией при коллизиях имён.

export function pathBasename(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? filePath
}

// Map fullPath → display label: без коллизии — basename; при коллизии —
// наращивание родительских сегментов справа налево до различия внутри группы;
// префикс получают все участники. Полный путь уникален, поэтому алгоритм
// завершается; дубликаты полного пути схлопываются (Set).
export function displayPathLabels(paths: readonly string[]): Map<string, string> {
  const unique = [...new Set(paths)]
  const byBasename = new Map<string, string[]>()
  for (const filePath of unique) {
    const basename = pathBasename(filePath)
    byBasename.set(basename, [...(byBasename.get(basename) ?? []), filePath])
  }
  const labels = new Map<string, string>()
  for (const [, group] of byBasename) {
    if (group.length === 1) {
      labels.set(group[0]!, pathBasename(group[0]!))
      continue
    }
    const segmentsOf = (filePath: string) => filePath.split("/").filter(Boolean)
    const maxDepth = Math.max(...group.map((filePath) => segmentsOf(filePath).length))
    let depth = 0
    let candidates: string[]
    do {
      depth++
      candidates = group.map((filePath) => segmentsOf(filePath).slice(-depth).join("/"))
    } while (depth < maxDepth && new Set(candidates).size !== group.length)
    group.forEach((filePath, index) => labels.set(filePath, candidates[index]!))
  }
  return labels
}

// Ширина колонки номеров листинга: по максимальному видимому номеру с clamp
// 2…5 — на узких терминалах потеря разрядов вместо разрушения вёрстки.
export function numberColumnWidth(numbers: readonly (number | undefined)[]): number {
  const max = numbers.reduce((acc: number, value) => (value !== undefined && value > acc ? value : acc), 0)
  return Math.min(5, Math.max(2, String(max).length))
}
