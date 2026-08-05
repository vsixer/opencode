export * as ConfigCommand from "./command"

import path from "path"
import { Glob } from "@opencode-ai/core/util/glob"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import type { ConfigMerge } from "./merge"
import { isRecord } from "@/util/record"

// Возвращает raw-определения команд ДО schema-decode.
// Слоистое слияние (fold) и финальный decode выполняются в config.ts.
export async function load(dir: string): Promise<Record<string, ConfigMerge.Definition>> {
  const result: Record<string, ConfigMerge.Definition> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    result[configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])] = {
      frontmatter: isRecord(md.data) ? md.data : {},
      body: md.content.trim(),
      source: item,
    }
  }
  return result
}
