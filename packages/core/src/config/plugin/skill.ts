export * as ConfigSkillPlugin from "./skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import path from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { Config } from "../../config.js"
import { ConfigMarkdown } from "../markdown.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"
import { SkillDiscovery } from "../../skill/discovery.js"
import { ConfigMerge } from "../merge.js"
import { SkillFile } from "./skill-file.js"
import { SkillScan } from "./skill-scan.js"

type Source = Skill.DirectorySource | Skill.UrlSource

// raw frontmatter для слоистой склейки: без string name скилл в fold не попадает.
const parseRaw = (content: string) => {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return undefined
  return { data: markdown.data as Record<string, unknown>, content: markdown.content }
}

export const Plugin = define({
  id: "opencode.config.skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const start = yield* fs.resolve(location.directory)
    const projectRoot = yield* fs.resolve(location.project.directory)
    const loaded: { entries: Entry[]; skills: Skill.Info[] } = {
      entries: yield* config.entries(),
      skills: [],
    }
    const watches = yield* FiberMap.make<string>()
    const changes = yield* PubSub.sliding<string>(1)
    const lock = Semaphore.makeUnsafe(1)

    const watch = Effect.fn("ConfigSkillPlugin.watch")(function* (directory: string, type: "file" | "directory") {
      const target = path.resolve(directory)
      const updates = yield* watcher.subscribe(
        type === "directory" ? { path: target, type, ignore: SkillScan.ignore } : { path: target, type },
      )
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    function firstMissing(target: string): Effect.Effect<string | undefined> {
      const parent = path.dirname(target)
      if (parent === target) return Effect.undefined
      return fs.isDir(parent).pipe(Effect.flatMap((exists) => (exists ? Effect.succeed(target) : firstMissing(parent))))
    }

    const watchDirectory: (directory: string) => Effect.Effect<string[]> = Effect.fn(
      "ConfigSkillPlugin.watchDirectory",
    )(function* (directory: string) {
      const target = path.resolve(directory)
      const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
      if (resolved) {
        yield* watch(resolved, "directory")
        if (resolved !== target) yield* watch(target, "file")
        return resolved === target ? [target] : [target, resolved]
      }
      const missing = yield* firstMissing(target)
      if (missing) yield* watch(missing, "file")
      if (
        yield* fs.realPath(directory).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      ) {
        if (missing) yield* FiberMap.remove(watches, `file:${path.resolve(missing)}`)
        return yield* watchDirectory(directory)
      }
      return [target]
    })

    // Слоистое слияние применяется только к opencode-configDir слоям (global
    // ~/.config/opencode vs project .opencode). Скиллы из skills.paths/urls —
    // plain-источники: last-write-wins поверх склеенных opencode-слоёв.
    const layerLabel = (entryPath: string) =>
      FSUtil.contains(projectRoot, entryPath) || FSUtil.contains(start, entryPath) ? "project" : "global"

    const loadDirectoryEntry = Effect.fn("ConfigSkillPlugin.loadDirectoryEntry")(function* (entryPath: string) {
      const directories = [path.join(entryPath, "skill"), path.join(entryPath, "skills")]
      yield* Effect.forEach(directories, watchDirectory, { discard: true })
      const map: Record<string, ConfigMerge.Definition> = {}
      for (const directory of directories) {
        for (const filepath of yield* SkillScan.scan(directory).pipe(Effect.orElseSucceed(() => [] as string[]))) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
          if (!content) continue
          const markdown = parseRaw(content)
          if (!markdown) continue
          const name = markdown.data.name
          if (typeof name !== "string" || name === "") continue
          map[name] = { frontmatter: { ...markdown.data }, body: markdown.content.trim(), source: filepath }
        }
      }
      return { layer: layerLabel(entryPath), map }
    })

    const sources = () => {
      const result: Source[] = []
      const add = (source: Source) => {
        if (result.some((item) => Skill.Source.equals(item, source))) return
        result.push(source)
      }
      const items = loaded.entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
      for (const item of items) {
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          add(Skill.UrlSource.make({ type: "url", url: item }))
          continue
        }
        const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
        add(
          Skill.DirectorySource.make({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(start, expanded)),
          }),
        )
      }
      return result
    }

    const load = Effect.fn("ConfigSkillPlugin.load")(function* (source: Source) {
      const directories =
        source.type === "directory"
          ? [source.path]
          : yield* discovery.pull(source.url).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to load skill source", {
                  source: Skill.Source.key(source),
                  cause,
                }).pipe(Effect.as([] as AbsolutePath[])),
              ),
            )
      const roots = (yield* Effect.forEach(directories, watchDirectory)).flat()
      const skills: Skill.Info[] = []
      for (const directory of directories) {
        for (const filepath of yield* SkillScan.scan(directory)) {
          const resolved = yield* fs.realPath(filepath).pipe(Effect.orElseSucceed(() => filepath))
          if (!roots.some((root) => FSUtil.contains(root, resolved))) yield* watch(resolved, "file")
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
          if (!content) continue
          const parsed = SkillFile.parse(directory, filepath, content)
          if (parsed._tag === "Skipped") {
            yield* Effect.logDebug("skill file skipped", {
              filepath,
              reason: parsed.reason,
              ...(parsed.reason === "frontmatter" ? { issue: parsed.issue } : {}),
            })
            continue
          }
          skills.push(parsed.skill)
        }
      }
      yield* Effect.logDebug("skill source loaded", {
        source: Skill.Source.key(source),
        type: source.type,
        directories,
        skills: skills.map((skill) => skill.id),
      })
      return skills
    })

    const refresh = Effect.fn("ConfigSkillPlugin.refresh")(
      function* (file?: string) {
        yield* FiberMap.clear(watches)
        // 1. opencode-configDir слои → parse → fold (frontmatter/body, до decode).
        const layers: ConfigMerge.LayerMap[] = []
        for (const entry of loaded.entries) {
          if (entry.type !== "directory") continue
          layers.push(yield* loadDirectoryEntry(entry.path))
        }
        const composed = ConfigMerge.foldEntries(layers.filter((layer) => Object.keys(layer.map).length > 0))
        const skills = new Map<Skill.ID, Skill.Info>()
        for (const [key, item] of Object.entries(composed)) {
          const skill = SkillFile.folded({ key, frontmatter: item.frontmatter, body: item.body, source: item.source })
          if (!skill) continue
          skills.set(skill.id, skill)
          for (const warning of item.warnings) {
            yield* Effect.logWarning(`layered merge skill "${key}": ${warning.message}`, {
              source: item.source,
              kind: warning.kind,
            })
          }
        }
        // 2. plain-источники поверх склеенных opencode-слоёв (last-write-wins).
        const current = sources()
        for (const source of current) {
          for (const skill of yield* load(source)) {
            const existing = skills.get(skill.id)
            if (existing) {
              yield* Effect.logWarning("duplicate skill name", {
                name: skill.id,
                existing: existing.path,
                duplicate: skill.path,
              })
            }
            skills.set(skill.id, skill)
          }
        }
        loaded.skills = Array.from(skills.values())
        if (file) {
          yield* Effect.logInfo("skills rescanned", {
            file,
            sources: current.map(Skill.Source.key),
            skills: loaded.skills.map((skill) => skill.id),
          })
        }
      },
      (effect, ..._args: [file?: string]) => lock.withPermit(effect),
    )

    // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
    // before debouncing so no update slips through while the debounce starts its pull.
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(ctx.skill.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh()
    yield* ctx.skill.transform((editor) => {
      for (const skill of loaded.skills) editor.add(skill)
    })
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
          Effect.andThen(refresh()),
          Effect.andThen(ctx.skill.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
