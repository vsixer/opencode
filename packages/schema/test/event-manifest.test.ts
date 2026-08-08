import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { ConfigReloadEvent } from "../src/config-reload-event"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(61)
    expect(EventManifest.Definitions.length).toBe(91)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(91)
    expect(EventManifest.Durable.size).toBe(35)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    // SessionV1 live events remain in the manifest regardless of position.
    expect(EventManifest.Definitions).toContain(SessionV1.Event.PartDelta)
    expect(EventManifest.Definitions).toContain(SessionV1.Event.Diff)
    expect(EventManifest.Definitions).toContain(SessionV1.Event.Error)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })

  test("registers config.reload lifecycle events", () => {
    // 3 события зарегистрированы как canonical definitions
    expect(ConfigReloadEvent.Definitions).toEqual([ConfigReloadEvent.Pending, ConfigReloadEvent.Executing, ConfigReloadEvent.Done])
    // Попали в public manifest (ServerDefinitions + Definitions)
    expect(EventManifest.ServerDefinitions).toContain(ConfigReloadEvent.Pending)
    expect(EventManifest.ServerDefinitions).toContain(ConfigReloadEvent.Executing)
    expect(EventManifest.ServerDefinitions).toContain(ConfigReloadEvent.Done)
    expect(EventManifest.Definitions).toContain(ConfigReloadEvent.Done)
    // Latest резолвит их по type-строке с сохранением canonical identity
    expect(EventManifest.Latest.get("config.reload.pending")).toBe(ConfigReloadEvent.Pending)
    expect(EventManifest.Latest.get("config.reload.executing")).toBe(ConfigReloadEvent.Executing)
    expect(EventManifest.Latest.get("config.reload.done")).toBe(ConfigReloadEvent.Done)
    // config.reload события не durable — не должны попадать в Durable-манифест
    expect([...EventManifest.Durable.values()]).not.toContain(ConfigReloadEvent.Pending)
    expect([...EventManifest.Durable.values()]).not.toContain(ConfigReloadEvent.Done)
  })
})
