# `/btw` Ephemeral Side-Chat — Feasibility Report

Scope: TUI at `packages/tui`, core/session layer at `packages/opencode/src/session` (active V1) and `packages/core/src/session` (in-development V2 Session Core). All paths are repo-relative unless noted.

> **Headline:** Every UI primitive needed for a modal side-chat **already exists** (dialog stack, overlay layering, focus/mode management, reusable input). The session layer has a clean `fork` precedent. **The one thing that does NOT exist is an ephemeral / in-memory / non-persisted session** — sessions are unconditionally Drizzle/SQLite rows, and every prompt flow writes through event subscribers into the DB. That is the single largest build gap.

---

## 1. TUI Rendering Framework

**(a)** The TUI is **TypeScript + SolidJS rendered via `@opentui/solid`** on top of `@opentui/core` (a native terminal renderer) and `@opentui/keymap`. It is **not** React/Ink/Bubble Tea/Go.

**(b) Entrypoints / root tree:**
- `packages/tui/src/index.tsx` — package export root.
- `packages/tui/src/app.tsx` — the actual app. `export const run = Effect.fn("Tui.run")(...)` is the bootstrap. It calls `createCliRenderer(...)` from `@opentui/core` inside `Effect.scoped` (app.tsx, the `run` body), then mounts a SolidJS tree via `render(...)`.
- Root component tree: `app.tsx` wraps everything in providers in this order (approx.): `TuiPathsProvider → TuiTerminalEnvironmentProvider → TuiStartupProvider → ArgsProvider → ClipboardProvider → EditorContextProvider → ProjectProvider → SDKProvider → DataProvider → LocationProvider → LocalProvider → SyncProvider → PermissionProvider → ThemeProvider → ToastProvider → DialogProvider → KVProvider → PluginRuntimeProvider → ErrorBoundary → <App/>`.
- The `<App/>` body (app.tsx, final `Show` block) is a `<Switch>` over `route.data.type`:
  - `home` → `<Home/>` (`packages/tui/src/routes/home/`)
  - `session` → `<Session/>` (`packages/tui/src/routes/session/index.tsx`, function `Session` at **line 178**)
- Plugin slots `<pluginRuntime.Slot name="app_bottom" />` and `name="app"` are rendered at the bottom.

**(c) Evidence:** `packages/tui/package.json` deps `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `solid-js`. `app.tsx` imports `render, TimeToFirstDraw, useRenderer, useTerminalDimensions` from `@opentui/solid` and `createDefaultOpenTuiKeymap` from `@opentui/keymap/opentui`.

---

## 2. Modal / Overlay System (STRONG precedent — feasible)

**(a)** **Yes — there is a mature, stack-based modal/overlay system**, plus ~25 concrete modal components. A modal chat window is directly feasible atop these primitives.

**(b) Core primitives — `packages/tui/src/ui/dialog.tsx`:**
- `Dialog(props: { size?: "medium"|"large"|"xlarge"; onClose })` — the backdrop/panel. It is `position="absolute"`, `zIndex={3000}`, full-screen, with a translucent overlay `RGBA.fromInts(0,0,0,150)` and a centered panel of width 60/88/116 cols (medium/large/xlarge). Click-outside dismisses.
- `DialogProvider` + `useDialog()` context (createContext). State is a Solid `createStore` with:
  - `stack: { element: JSX.Element; onClose?: () => void }[]`
  - `size: "medium"|"large"|"xlarge"`
- API surface (from `init()` in dialog.tsx):
  - `dialog.replace(<JSX/>, onClose?)` — replaces the entire stack with one entry; captures and blurs current focus.
  - `dialog.clear()` — closes everything, calls each `onClose`, refocuses prior renderable.
  - `dialog.stack` / `dialog.size` / `dialog.setSize(size)`.
- **Focus/mode management:** when the stack is non-empty, `modeStack.push("modal")` is called via `useOpencodeModeStack()` inside a `createEffect(onCleanup(popMode))`. This pushes the keymap into the `"modal"` mode so base-mode bindings don't fire. Escape and Ctrl+C are bound to pop the top dialog (`useBindings(...)` inside `init()`). Refocus restores the previously focused `Renderable` after a `setTimeout(...,1)`.
- **Layering:** single zIndex `3000` for the dialog layer; only `stack.at(-1)!.element` is rendered (LIFO top-of-stack).

**(c) Existing modal/overlay components** (each is `dialog.replace(() => <X/>)`):
- `packages/tui/src/ui/dialog-help.tsx` — `DialogHelp` (help overlay).
- `packages/tui/src/ui/dialog-confirm.tsx` — `DialogConfirm` + `DialogConfirm.show(dialog, title, message, label?)` promise helper.
- `packages/tui/src/ui/dialog-alert.tsx` — `DialogAlert`.
- `packages/tui/src/ui/dialog-select.tsx` — **`DialogSelect<T>` (line 80)**, a generic list-picker with options/onSelect/onMove. This is the workhorse used by most dialogs and is the natural skeleton for a `/btw` panel.
- `packages/tui/src/component/command-palette.tsx` — `CommandPaletteDialog` (the `/`-command palette; uses `DialogSelect`).
- `packages/tui/src/component/dialog-provider.tsx`, `dialog-model.tsx` (line `DialogModel`), `dialog-agent.tsx`, `dialog-mcp.tsx`, `dialog-status.tsx`, `dialog-debug.tsx`, `dialog-theme-list.tsx`, `dialog-session-list.tsx`, `dialog-session-rename.tsx`, `dialog-session-delete-failed.tsx`, `dialog-skill.tsx`, `dialog-stash.tsx`, `dialog-move-session.tsx`, `dialog-retry-action.tsx`, `dialog-tag.tsx`, `dialog-variant.tsx`, `dialog-console-org.tsx`, `dialog-workspace-list.tsx`, `dialog-workspace-create.tsx`, `dialog-workspace-file-changes.tsx`, `dialog-workspace-unavailable.tsx`.
- Session-scoped (route-local) dialogs: `packages/tui/src/routes/session/dialog-timeline.tsx`, `dialog-fork-from-timeline.tsx`, `dialog-message.tsx`, `dialog-subagent.tsx`.

**Implication for `/btw`:** A `DialogBtw` component rendered via `dialog.replace(() => <DialogBtw sessionID={...} />)` would inherit layering, escape-to-close, click-outside, focus-restore, and modal-mode keymap isolation for free. `dialog.setSize("xlarge")` gives you a 116-column panel.

---

## 3. Session Abstraction

There are **two parallel session implementations**. This is the most important architectural fact for this feature.

### 3a. Active V1 (used by the running TUI today) — `packages/opencode/src/session/`

**(a)** A session is represented by the `Session.Info` Schema struct.

**(b) `Session.Info` — `packages/opencode/src/session/session.ts` lines 224–245:**
```ts
export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optional(WorkspaceV2.ID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),     // <-- parent session (forks/subagents)
  summary: optional(Summary),
  cost: optional(Schema.Finite),
  tokens: optional(Tokens),
  share: optional(Share),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(Model),            // { id, providerID, variant? }
  version: Schema.String,
  metadata: optional(Metadata),
  time: Time,                        // { created, updated, compacting?, archived? }
  permission: optional(PermissionV1.Ruleset),
  revert: optional(Revert),
}).annotate({ identifier: "Session" })
```
- `SessionID` is `SessionV2.ID` (re-exported, see `packages/opencode/src/session/schema.ts` line 7). `MessageID`/`PartID` are branded strings (`msg…`/`prt…`) from the same file.
- The service: `Session.Service` at line 476 — `Context.Service<Service, Interface>()("@opencode/Session")`.
- The full method surface: `Session.Interface` at **lines 415–474** — `list`, `listGlobal`, `create`, `fork`, `touch`, `get`, `setTitle`, `setArchived`, `setMetadata`, `setAgentModel`, `setPermission`, `setRevert`, `clearRevert`, `setSummary`, `setShare`, `setWorkspace`, `diff`, `messages`, `children`, `remove`, `updateMessage`, `removeMessage`, `removePart`, `getPart`, `updatePart`, `updatePartDelta`, `findMessage`.

### 3b. In-development V2 Session Core — `packages/core/src/session/`

Per `AGENTS.md` ("V2 Session Core") and the file tree, the future stack lives here:
- `packages/core/src/session/schema.ts` — `export const Info = Session.Info` (re-export from `@opencode-ai/schema/session`); `ID = Session.ID`.
- `packages/core/src/session/sql.ts` — Drizzle tables: `SessionTable` (line 22), `MessageTable`, `PartTable` (V1-shape), and the new V2 tables `SessionMessageTable` (`session_message`), `SessionInputTable` (`session_input`), `SessionContextEpochTable` (`session_context_epoch`).
- `packages/core/src/session/store.ts` — `@opencode/v2/SessionStore` (Service line 26). Interface (lines 14–24): `get(sessionID)`, `context(sessionID)`, `runnerContext(sessionID, baselineSeq)`, `message(messageID)`.
- `packages/core/src/session/execution.ts` — `@opencode/v2/SessionExecution` (Service line 21). Interface (lines 9–19): `active`, `resume(sessionID)`, `wake(sessionID)`, `interrupt(sessionID)`. There is a `noopLayer` for "callers that only need durable Session recording" — a useful seam.
- `packages/core/src/session/runner/index.ts` — `@opencode/v2/SessionRunner` (Service line 28). `run({ sessionID, force })`.
- `packages/core/src/session/run-coordinator.ts` — `SessionRunCoordinator` (`make()`).
- `packages/core/src/session/history.ts` — `SessionHistory.load/loadForRunner/entriesForRunner/latestCompaction`.
- `packages/core/src/session/execution/local.ts` — local execution impl.
- Runner internals: `packages/core/src/session/runner/{llm.ts, model.ts, to-llm-message.ts, max-steps.ts, publish-llm-event.ts}`.

### 3c. Ephemeral / in-memory session?

**(c) Does NOT exist.** Explicit negative evidence:
- `grep -rniE 'ephemeral|in.memory|inMemory|in_memory|temporary|temporarySession' packages/opencode/src/session/ packages/opencode/src/storage/` → only matches inside prompt template `.txt` files (unrelated) and one comment in `llm/ai-sdk.ts`. No code.
- Same grep over `packages/core/src/session/` → zero matches.
- Every session is created via `Session.createNext` (`packages/opencode/src/session/session.ts` line 501) which builds an `Info` with a real `SessionID.descending()` and immediately `events.publish(SessionV1.Event.Created, { sessionID, info })` (line 541) — which an event subscriber persists to the `session` SQLite table.
- The V2 `SessionStore`/`SessionExecution` interfaces have **no "create" or "transient" method** — only `get`/`context`/`runnerContext`/`message` and execution control. The V2 stack assumes a Session row already exists.

**Build gap:** an ephemeral `/btw` session would require either (i) a new in-memory `SessionStore`/`SessionExecution` implementation that never touches `SessionTable`, or (ii) a "create-and-delete-on-close" wrapper that creates a real row then `Session.remove(id)` on dismiss (heavier, leaves journal/events).

---

## 4. Session History / Context Assembly

### V1 active path

**(a/b)** The prompt/context for a provider call is assembled inside `runLoop` in **`packages/opencode/src/session/prompt.ts`** (function defined at **line 1081**, `Effect.fn("SessionPrompt.run")`).

Key sequence inside the loop (line ranges approx.):
1. `msgs = yield* MessageV2.filterCompactedEffect(sessionID, ...)` (~line 1110) — loads this session's messages from the DB and strips compacted ranges. **This is the history selection.**
2. `MessageV2.latest(msgs)` → extracts `lastUser`, `lastAssistant`, `lastFinished`, `tasks`.
3. `SessionReminders.apply({ messages: msgs, agent, session })` (~line 1180) — injects reminder/system injected parts.
4. System prompt assembly (~line 1232, the `Effect.all([...])` block):
   ```ts
   const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
     sys.skills(agent),
     sys.environment(model),
     instruction.system(),
     sys.mcp(agent, session.permission),
     MessageV2.toModelMessagesEffect(msgs, model),
   ])
   const system = [...env, ...instructions,
                   ...(mcpInstructions ? [mcpInstructions] : []),
                   ...(skills ? [skills] : [])]
   ```
5. Tools resolved via `SessionTools.resolve({ agent, session, model, processor: handle, ... })` (~line 1232).
6. `plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })` (~line 1255) — plugin hook.
7. The actual LLM stream happens in the processor (`processor.create(...)` → `Handle.process(streamInput)`).

**(c) Can the context be snapshotted/cloned?** Yes — and there's already a precise precedent: `Session.fork` at **`packages/opencode/src/session/session.ts` line 693**:
```ts
const fork = Effect.fn("Session.fork")(function* ({ sessionID, messageID }) {
  const original = yield* get(sessionID)
  const session = yield* createNext({ ... structuredClone(original.metadata) ... })
  const msgs = yield* messages({ sessionID })
  for (const msg of msgs) {
    if (messageID && msg.info.id >= messageID) break
    const newID = MessageID.ascending()
    yield* updateMessage({ ...msg.info, sessionID: session.id, id: newID })
    for (const part of msg.parts) { ... }
  }
})
```
So the history is already cloneable message-by-message. For an ephemeral side-chat you would call `Session.messages({ sessionID })` (Interface line 450) to get `SessionV1.WithParts[]`, then feed those into a side prompt flow without re-persisting.

**Supporting services:**
- `packages/opencode/src/session/system.ts` — `SystemPrompt.Service` (`@opencode/SystemPrompt`), with `environment(model)`, `skills(agent)`, `mcp(agent, permission)`, and `provider(model)` selecting the base prompt template (`prompt/{anthropic,gpt,gemini,kimi,meta,codex,trinity,beast,default}.txt`).
- `packages/opencode/src/session/instruction.ts` — `Instruction.Service` (`instruction.system()`).

### V2 path

- `packages/core/src/session/history.ts` — `SessionHistory.load(db, sessionID)` returns `SessionMessage.Message[]` (selects from `SessionMessageTable` joined with `SessionContextEpochTable.baseline_seq` and the latest `compaction` row).
- `packages/core/src/session/runner/to-llm-message.ts` — converts selected history → LLM messages.
- `packages/core/src/system-context/index.ts` — `SystemContext` algebra: `Source<A>`, `Snapshot`, `Generation`, `ReconcileResult`, `ReplacementReady/Blocked`. Built-in sources in `builtins.ts`, registry in `registry.ts`. This is the structured replacement for V1's `SystemPrompt`.

---

## 5. Persistence (SQLite via Drizzle — confirmed)

**(a)** **Drizzle ORM over SQLite.** Tables in `packages/core/src/session/sql.ts`; re-exported through `packages/opencode/src/storage/schema.ts`:
```ts
export { SessionTable, MessageTable, PartTable, TodoTable } from "@opencode-ai/core/session/sql"
```
The legacy `packages/opencode/src/storage/storage.ts` is a **JSON-file KV store** (`Interface` lines 53–60: `read/write/update/list/remove` by `string[]` key, file = `dir/...key.json`). It still exists for migrations/legacy blobs (e.g. `storage/session/message/*/*.json`) but **the canonical session/message store is the SQLite DB.**

**(b) Drizzle tables (`packages/core/src/session/sql.ts`):**
- `SessionTable` (line 22, table name `"session"`) — columns: `id`, `project_id`, `workspace_id`, `parent_id`, `slug`, `directory`, `path`, `title`, `version`, `share_url`, `summary_*`, `metadata`, `cost`, `tokens_{input,output,reasoning,cache_read,cache_write}`, `revert`, `permission`, `agent`, `model`, `Timestamps`, `time_compacting`, `time_archived`.
- `MessageTable` (V1-shape, `data` JSON column).
- `PartTable` (V1-shape, `data` JSON column).
- `SessionMessageTable` (V2, table `"session_message"`) — `id`, `session_id`, `type`, `seq`, `Timestamps`, `data` JSON.
- `SessionInputTable` (V2, table `"session_input"`) — durable prompt inbox (`prompt`, `delivery`, `admitted_seq`, `promoted_seq`).
- `SessionContextEpochTable` (V2, table `"session_context_epoch"`) — `baseline`, `snapshot` JSON (`SystemContext.Snapshot`), `baseline_seq`.

**(c) Persistence call sites — what to bypass for ephemerality:**
- **Session creation:** `Session.createNext` (`packages/opencode/src/session/session.ts` line 501) builds `Info` and `events.publish(SessionV1.Event.Created, ...)` (line 541). A DB subscriber persists the row (the project/workspace modules already `db.update(SessionTable)...` directly — see `packages/opencode/src/project/project.ts` lines 178–180, 293–295; `packages/opencode/src/control-plane/workspace.ts` lines 313–315, 562–563).
- **Direct `db.insert(SessionTable)` sites:** the only literal in `packages/opencode/src/` is the **import tooling** `packages/opencode/src/cli/cmd/import.ts` lines 187/200/215. Normal creation flows through the event bridge.
- **Message/part writes:** flow through `Session.updateMessage` / `Session.updatePart` / `Session.updatePartDelta` (Interface lines 453–468) → event subscribers → `MessageTable`/`PartTable` upserts. In V2, the equivalent is `packages/core/src/session/message-updater.ts` (`Adapter` with `updateAssistant`/`updateShell`, and `update(adapter, event)` at line 78 reacting to `session.next.*` events).
- **Title/cost/tokens updates:** `Session.setTitle`, `setAgentModel`, `setSummary`, `touch` (Interface lines 430–447).

**To make `/btw` truly ephemeral you must bypass:**
1. `Session.create`/`createNext` — don't call it; hold the side-chat state in memory.
2. `Session.updateMessage`/`updatePart*` — don't append to `MessageTable`/`PartTable`.
3. The event bus publishes (`events.publish(SessionV1.Event.Created/...)`) — these are what trigger DB writes and would also surface in the main UI's sync layer (`useSync`).
4. V2: don't admit a `session_input` row, don't `SessionExecution.wake`.

The cleanest seam is **don't go through `Session.Service`/`SessionPrompt.Service` at all** for the side-chat; instead snapshot `Session.messages({ sessionID })` once, then run a private prompt loop that calls `LLM.Service` directly (see §9).

---

## 6. Command / Slash-Command System

**(a)** Slash commands are **TUI-side**, built on top of the keymap command registry. There is no separate "slash registry"; a command becomes a slash by adding `slashName` (and optionally `slashAliases`).

**(b) Command definition sites:**
- App-level: the `appCommands` memo inside `packages/tui/src/app.tsx` (the `createMemo(() => [ ... ])` block). Examples: `session.list` has `slashName: "sessions", slashAliases: ["resume","continue"]`; `session.new` has `slashName: "new", slashAliases: ["clear"]`; `model.list` has `slashName: "models", slashAliases: ["mo"]`; `agent.list` has `slashName: "agents"`; `workspace.list` has `slashName: "workspaces"`.
- Prompt-level: `packages/tui/src/component/prompt/index.tsx` defines more: `slashName: "editor"` (line 426), `"skills"` (518), `"warp"` (540), `"move"` (550).
- Core command templates (server-side, separate concept): `packages/opencode/src/command/index.ts` — `Command.Service` (`@opencode/Command`), `Info` struct with `name/description/agent/model/source/template/subtask/hints`. Built-ins: `init`, `review`. These are dispatched through the prompt when input starts with `/` and matches `sync.data.command` (see prompt `index.tsx` submit handler: `inputText.startsWith("/") && sync.data.command.some(x => x.name === ...)`).

**(c) How a `/btw` slash command would be wired:**
1. Add an entry to `appCommands` in `app.tsx`:
   ```ts
   {
     name: "session.btw",
     title: "BTW — ephemeral side chat",
     category: "Session",
     slashName: "btw",
     run: () => dialog.replace(() => <DialogBtw sessionID={route.data.type === "session" ? route.data.sessionID : undefined} />),
   }
   ```
2. Register a keybind name → command mapping (see §7).
3. The autocomplete picks it up automatically via `useCommandSlashes()` (see below) — no extra registration needed.

**(d) Autocomplete / dispatch plumbing (already in place):**
- `packages/tui/src/keymap.tsx` — `useCommandSlashes(): Accessor<CommandSlashEntry[]>` reads every reachable command in the `"palette"` namespace with a non-empty `slashName` and returns `{ display: "/<name>", description, aliases, onSelect }` (function around the `useKeymapSelector` block, lines ~ the `useCommandSlashes` definition).
- `packages/tui/src/component/prompt/autocomplete.tsx` line 23 imports `useCommandSlashes`; line 92 `const slashes = useCommandSlashes()`; line 448 `[...slashes()]` merges slash options into the autocomplete list; lines 285–286 and 695 handle `/` at position 0 to reopen the slash menu.
- Dispatch: `keymap.dispatchCommand(name)` (used in `command-palette.tsx` `onSelect`, and `app.tsx` handles `tui.command.execute` events via `keymap.dispatchCommand`).

---

## 7. Hotkey / Keybinding System

**(a)** Keyboard handling is `@opentui/keymap` wrapped by a thin opencode adapter in `packages/tui/src/keymap.tsx` plus a declarative definitions table in `packages/tui/src/config/keybind.ts`.

**(b) Key files:**
- `packages/tui/src/keymap.tsx`:
  - `OpencodeKeymapProvider` (= `KeymapProvider`), `useOpencodeKeymap` (= `useKeymap`), re-exports `useBindings`, `useKeymapSelector`.
  - `OPENCODE_BASE_MODE = "base"`, `COMMAND_PALETTE_COMMAND = "command.palette.show"`.
  - `createOpencodeModeStack(keymap)` — a mode stack; `push("modal")` is called by `DialogProvider` (so dialogs automatically isolate base bindings). The current mode is stored under data key `"opencode.mode"`.
  - `registerOpencodeKeymap(keymap, renderer, config)` (the `run` body in app.tsx registers it under `Effect.acquireRelease`) — wires leader-key timing, escape/backspace sequence handling, comma bindings, and `registerManagedTextareaLayer(...)` for input-mode bindings.
  - `useCommandShortcut(command)` — formatted key sequence accessor.
- `packages/tui/src/config/keybind.ts`:
  - `Definitions` object: every named binding + description, e.g. `session_list: keybind("<leader>l", "List all sessions")`, `session_fork: keybind("none", ...)`, `session_new: keybind("<leader>n", ...)`, etc.
  - `CommandMap` object: maps each binding name to a command string, e.g. `session_list: "session.list"`, `session_fork: "session.fork"`, `help_show: "help.show"`.
  - `KeybindOverrides` Schema (user overrides via config), `Descriptions`.

**(c) How to add a `/btw` hotkey:**
1. Add a keybind entry in `Definitions` (config/keybind.ts), e.g. `session_btw: keybind("<leader>b", "Open ephemeral side chat")`.
2. Add the mapping in `CommandMap`: `session_btw: "session.btw"`.
3. Add `"session.btw"` to the relevant binding command list in app.tsx (e.g. `appBindingCommands` for app-global, or `sessionBindingCommands` in `routes/session/index.tsx`).
4. The command itself (from §6) is registered through `useBindings(() => ({ commands: appCommands() }))` and `tuiConfig.keybinds.gather("app", appBindingCommands)` (see app.tsx `useBindings` blocks).

Existing session-scoped binding commands are declared in `packages/tui/src/routes/session/index.tsx` as `sessionBindingCommands = ["session.share","session.rename","session.timeline","session.fork", ...]` — a `/btw` binding would naturally join this list so it's only live while a session is open.

---

## 8. Main Input + Chat Component

**(a) Input box:** `packages/tui/src/component/prompt/index.tsx` — `export function Prompt(props: PromptProps)` at **line 143**. `PromptProps` (lines 63–76):
```ts
export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: { normal?: string[]; shell?: string[] }
}
```
- Backed by a `TextareaRenderable` from `@opentui/core`.
- `PromptRef` type (defined above `PromptProps`): `{ focused, current: PromptInfo, set, reset, blur, focus, submit }`.
- The component is heavy: it owns agent/model/variant selection, mode (`"normal" | "shell"`), paste/file parts, editor context, command dispatch, stash, frecency, history. On submit it either calls `sdk.client.session.shell` (shell mode), dispatches a `/command`, or calls `sdk.client.session.prompt` after creating a session via `sdk.client.session.create(...)` if needed (see prompt `index.tsx`, the `submit` body around line ~10 in the indexed chunks: `const res = await sdk.client.session.create({ directory, workspace, agent, model, ... })`).

**(b) Prompt context wiring:**
- `packages/tui/src/context/prompt.tsx` — provides `usePromptRef()` (the shared ref the rest of the route uses to drive submit/blur from outside, e.g. the sidebar/interrupt buttons).

**(c) Message list / chat rendering:**
- `packages/tui/src/routes/session/index.tsx` — the `Session()` function (line 178) is ~1900 lines and renders the entire transcript (user/assistant messages, tool parts, reasoning, todos, subagent rows). Inline helpers: `InlineToolRow` (line 1907), `formatSubagentTitle` (2315), `formatSubagentRetry` (2319), `formatCompletedSubagentDetail` (2323), `toolDisplay` (2647), etc.
- The `<Prompt .../>` is mounted at **line 1308** inside the session route with `sessionID={route.sessionID}`.
- A separate, web-oriented chat component library lives in `packages/session-ui/` (SolidJS components: `message-part.tsx`, `basic-tool.tsx`, `dock-prompt.tsx`, `session-review.tsx`, plus a `v2/prompt-input/` set). These are **not** used by the terminal TUI but show the reusable shapes.

**(d) Reuse for a modal `/btw`:** `<Prompt/>` is self-contained and already accepts an optional `sessionID`. To reuse it inside a `DialogBtw`:
- Pass `sessionID={ephemeralId}` (or `undefined` plus your own submit handler that bypasses `sdk.client.session.*`).
- Provide your own `onSubmit` and a `ref` to drive `submit()`.
- The hard part is that `Prompt`'s default submit calls `sdk.client.session.create/prompt` — for an ephemeral side-chat you would either (i) intercept by giving it a synthetic `sessionID` and overriding submit, or (ii) extract the inner `TextareaRenderable` + autocomplete into a thinner component. Given the `Prompt`'s tight coupling to `useSync`/`useLocal`/`useSDK`, option (ii) (a slimmer `<BtwInput/>`) is likely cleaner.
- The transcript renderer in `routes/session/index.tsx` is **not** exported as a standalone component — reusing it wholesale inside a modal would require extracting a `<MessageList messages={...}/>` component first. That is a refactor, not a blocker.

---

## 9. Agent / Model / Tools

**(a) Agent selection:** The active agent for a session is stored on `Session.Info.agent` (a string agent name) and on each user message (`lastUser.agent`, resolved via `agents.get(lastUser.agent)` in `prompt.ts` runLoop). Agent definitions live in `packages/opencode/src/agent/` (`Agent.Service`/`Agent.Info`). In the TUI, the current agent is held in `useLocal()` (`packages/tui/src/context/local.tsx`) and cycled by the `agent.list`/`agent.cycle` commands.

**(b) Model selection:** `Session.Info.model = { id, providerID, variant? }`. Resolved per turn by `getModel(providerID, modelID, sessionID)` in `prompt.ts` (line 594). In the TUI, model is in `useLocal()` and switched via `DialogModel` / `model.cycle_recent` etc.

**(c) Tool registry:** `packages/opencode/src/tool/registry.ts` — `ToolRegistry.Service` (`@opencode/ToolRegistry`, Service at line 84). Interface (lines 72–83):
```ts
export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (input: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Tool.Def[]>
}
```
- Tool definitions: `packages/opencode/src/tool/tool.ts` — `Tool.Def`, `Tool.Info`, `Tool.define(...)`, `Tool.init(...)` (line 171). The `Context<M>` (line 36) carries `agent`, `model`, `session`, `permission`, etc.
- Concrete tools in `packages/opencode/src/tool/`: `task.ts` (subagent spawner), `read.ts`, `edit.ts`, `apply_patch.ts`, `glob.ts`, `grep.ts`, `bash`/`shell.ts`, `webfetch.ts`, `lsp.ts`, `plan.ts`, `question.ts`, `todo.ts`, `skill.ts`, `code-mode.ts`, `mcp-websearch.ts`, `truncate.ts`.
- Resolution per turn: `SessionTools.resolve({ agent, session, model, processor, messages, promptOps })` — **`packages/opencode/src/session/tools.ts` line 41** — applies agent tool filtering + permission filtering and hands the resulting tool set to the processor for the LLM call.

**(d) Can the side session be no-tools / read-only / chat-only?** **Yes — three independent levers:**
1. **Permission ruleset** — `PermissionV1.Ruleset` is on `Session.Info.permission` and is consulted by `SessionTools.resolve` and `ToolRegistry.tools(...)`. `Permission.disabled([...])` (used in `system.ts` for `["skill"]`) can disable any subset. A side-chat can pass a permission that disables every tool group.
2. **Agent definition** — `Agent.Info` controls which tools are surfaced. Defining a dedicated `btw` agent with an empty (or read-only) tool list makes the registry return nothing for that agent. `agent.steps` also caps the loop turn count.
3. **Bypass `SessionTools.resolve` entirely** — if the side-chat calls `LLM.Service` directly (skipping `SessionPrompt.run`), you can pass `tools: []` to the LLM stream. `LLM.StreamInput` (referenced in `processor.ts` `Handle.process`) is the shape consumed by `processor.create(...).process(streamInput)`.

So a guaranteed **no-side-effects chat-only mode** is achievable by either (i) a dedicated `btw` agent with no tools, or (ii) calling `LLM.Service` directly with an empty tools array and never invoking `SessionTools.resolve`/`processor.create`.

---

## 10. Existing Similar / Adjacent Features

**(a) `Session.fork` — closest precedent (PERSISTED).** `packages/opencode/src/session/session.ts` line 693 (`Session.fork`). Clones a session's messages (optionally up to `messageID`) into a brand-new `Session` row. Title gets ` (fork #N)` suffix (lines 162–168). The TUI exposes it as:
- `DialogForkFromTimeline` — `packages/tui/src/routes/session/dialog-fork-from-timeline.tsx` — lets the user pick "Full session" or any user message to fork up to. Calls `sdk.client.session.fork({ sessionID, messageID? })`, then `route.navigate({ type:"session", sessionID: forked.data!.id, prompt })`.
- CLI `--fork` flag — handled in `app.tsx` (the `createEffect` blocks that call `sdk.client.session.fork`).
- Keybind `session_fork` (default `none`) → command `session.fork`.

This is the **single best model for `/btw`'s "inherit full context" requirement.** The only difference: `/btw` must avoid the persist step (use the clone-in-memory approach instead of `Session.fork`).

**(b) Subagents (the `task` tool).** A `task` tool spawns a child session (`Session.Info.parentID`) to run a sub-task. Relevant TUI surfaces:
- `packages/tui/src/routes/session/dialog-subagent.tsx` — `DialogSubagent({ sessionID })` with an "Open" action that `route.navigate({ type:"session", sessionID })` to the subagent's session.
- `packages/tui/src/routes/session/subagent-footer.tsx` — `SubagentFooter` for inline subagent rendering.
- `routes/session/index.tsx` exports `formatSubagentTitle`, `formatSubagentRetry`, `formatCompletedSubagentDetail`, `formatSubagentToolcalls` (lines 2311–2325), and renders subagent rows inline via `InlineToolRow` (line 1907).
- Keybind `session_background` (`ctrl+b`) — "Background synchronous subagents" — shows that interrupting/backgrounding subagent work already exists.

Subagents demonstrate parent/child session linkage (`parentID`) and that the UI can navigate between them. They are, however, fully persisted — same caveat as fork.

**(c) Session timeline / revert.**
- `DialogTimeline` (`routes/session/dialog-timeline.tsx`) and `DialogForkFromTimeline` together provide a history-navigation UX — another form of "look at the session from a different angle."
- `Session.Info.revert` + `packages/opencode/src/session/revert.ts` — revert-to-message state.

**(d) "Thinking" / reasoning panel.** Reasoning parts are rendered inline (not a separate panel); `useThinkingMode`/`ThinkingMode` from `context/thinking` controls their display. Not a side-chat, but another piece of "auxiliary content alongside the main thread."

**(e) Compaction / summary side-flows.** `packages/opencode/src/session/compaction.ts` and `summary.ts` already spawn auxiliary LLM calls (title generation, summarization, compaction) **without creating a user-visible session** — see `title(...)` and `handleSubtask(...)` in `prompt.ts` (~lines 193, 255), which call `llm.stream({ messages: [...], ... })` directly. **This is the cleanest architectural precedent for "an LLM call that inherits context but is not a persisted session"** — exactly the shape `/btw` wants, just rendered into a modal instead of silently.

**(f) Stash (draft prompts).** `packages/tui/src/prompt/stash.tsx` + `DialogStash` provide an ephemeral-feeling prompt store. Not a chat, but shows the UX of "a side space for things that shouldn't pollute the main thread."

**Summary of adjacency:** There is **no** existing ephemeral/branch/preview chat. The closest models, in decreasing relevance, are: (1) compaction/title LLM side-calls (in-memory, inherits context, not persisted — but invisible), (2) `Session.fork` (inherits context, message-by-message clone — but persisted), (3) subagents (parent/child navigation — but persisted).

---

## Build-Plan Sketch (synthesizing the above)

The lowest-risk path that satisfies all three requirements (inherit context, ephemeral, no side effects):

1. **UI:** Add `DialogBtw` rendered via `dialog.replace(...)` + `dialog.setSize("xlarge")` — reuses the existing modal stack, escape-to-close, and `modeStack.push("modal")` isolation (§2).
2. **Trigger:** Add a `session.btw` command with `slashName: "btw"` in `appCommands` (app.tsx) and a `session_btw` keybind in `config/keybind.ts` (§6, §7).
3. **Context snapshot:** On open, call `sdk.client.session.messages({ sessionID })` (or `Session.messages` server-side) once to snapshot history; also capture the current agent/model from `useLocal()` (§3, §4).
4. **Ephemeral execution:** Do **not** call `Session.create`/`SessionPrompt.prompt`. Instead run a private loop that calls the LLM directly (model the call shape on `title()`/`handleSubtask()` in `prompt.ts`, §10e). Hold messages in a Solid `createSignal`/`createStore` inside `DialogBtw` — nothing reaches `SessionTable`/`MessageTable`/event bus (§5).
5. **No side effects:** Resolve tools with `SessionTools.resolve` but pass an agent/permission that yields `tools: []` (or skip resolution and pass `tools: []` straight to the LLM stream) — guarantees chat-only (§9).
6. **Input:** Either reuse `<Prompt/>` with a synthetic wrapper that intercepts submit, or build a thin `<BtwInput/>` on `TextareaRenderable` + the existing `Autocomplete` (§8).

The largest single chunk of new work is **(4)** — there is no reusable "run one LLM turn in memory" helper exposed to the TUI today; the existing in-memory LLM calls (`title`, `summary`, `compaction`) are server-side and not generalized. Generalizing one of those into a `SideChat` service (or a thin TUI-side `sdk.client.chat.complete({ messages, model })` that does not touch sessions) would unblock this and future features.

---

### Quick "does it exist?" checklist

| Capability | Exists? | Where |
|---|---|---|
| Modal/overlay system | Yes | `packages/tui/src/ui/dialog.tsx` |
| Stack + focus/mode mgmt | Yes | `DialogProvider` + `modeStack.push("modal")` |
| Slash-command registration | Yes | `appCommands` + `slashName` + `useCommandSlashes()` |
| Hotkey registration | Yes | `config/keybind.ts` + `keymap.tsx` |
| Reusable input component | Yes | `packages/tui/src/component/prompt/index.tsx` |
| Standalone transcript renderer | **No** (embedded in `routes/session/index.tsx`) | would need extraction |
| Session fork (inherits context) | Yes (persisted) | `session.ts:693` |
| Ephemeral / in-memory session | **No** | grep zero matches; `Session.createNext` always persists |
| In-memory LLM side-call precedent | Yes (not generalized) | `title()`/`handleSubtask()` in `prompt.ts` |
| No-tools / chat-only mode | Yes (via permission/agent) | `SessionTools.resolve`, `Permission.disabled` |
| Subagent / parent-child sessions | Yes (persisted) | `task` tool, `dialog-subagent.tsx` |
