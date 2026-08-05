export * as ConfigAgent from "./agent"

import path from "path"
import { Glob } from "@opencode-ai/core/util/glob"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import type { ConfigMerge } from "./merge"
import { isRecord } from "@/util/record"

// Возвращает raw-определения агентов ДО schema-decode.
export async function load(dir: string): Promise<Record<string, ConfigMerge.Definition>> {
  const result: Record<string, ConfigMerge.Definition> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    result[configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])] = {
      frontmatter: isRecord(md.data) ? md.data : {},
      body: md.content.trim(),
      source: item,
    }
  }
  return result
}

// mode/*.md — альтернативный способ определить primary-агента.
// mode: "primary" выставляется в frontmatter сразу, чтобы пройти через fold.
export async function loadMode(dir: string): Promise<Record<string, ConfigMerge.Definition>> {
  const result: Record<string, ConfigMerge.Definition> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const data = isRecord(md.data) ? md.data : {}
    result[configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"])] = {
      frontmatter: { ...data, mode: "primary" },
      body: md.content.trim(),
      source: item,
    }
  }
  return result
}
