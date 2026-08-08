# /reload — hot-reload configuration without TUI restart

**Status:** stable
**Дата:** 2026-08-08
**Branch:** `reload`
**Upstream:** adapts PR [anomalyco/opencode#9871](https://github.com/anomalyco/opencode/pull/9871) (issue #6719) to the fork

## TL;DR

Slash-команда `/reload` и тул `reload_config` горячо перезагружают конфигурацию (`opencode.jsonc`, плагины, MCP-серверы, instance-scoped сервисы) без перезапуска TUI. Если в текущем инстансе есть активные сессии — релод ставится в очередь, пока все они не станут idle, затем бэкенд-инстанс перезагружается, а TUI ре-синхронизируется перед закрытием overlay.

## Мотивация

Issue #6719 (январь 2026): после правки `opencode.jsonc` или `.opencode/` нужно перезагружать конфигурацию, не закрывая TUI. До этого единственный способ — закрыть и заново открыть терминал, теряя контекст сессии.

PR #9871 закрывает issue, но построен поверх старой модели слоёв (`Layer.mergeAll(…defaultLayer)`) и определяет события `config.reload.*` inline в `packages/opencode`. Форк мигрировал на node-архитектуру (`LayerNode.group`/`AppNodeBuilder`) и держит event-manifest в `packages/schema`, поэтому PR требовал адаптации, а не простого merge.

## Поведение

### Lifecycle релода

1. Команда `/reload` (или тул `reload_config`) дёргает `POST /config/reload` для текущего workspace.
2. `ConfigReload.request()` фиксирует состояние **per instance/workspace** (не глобально) — релод одного проекта не блокирует другие.
3. Если сессии активны — релод ждёт, пока все сессии инстанса не станут idle.
4. В начале исполнения сервер перезагружает инстанс через `InstanceStore.reload(...)` **после** формирования HTTP-ответа.
5. TUI получает событие `config.reload.executing`, показывает блокирующий overlay `Reloading configuration…` и делает полный bootstrap-refresh.
6. TUI подтверждает конкретный bootstrap-цикл через `POST /config/bootstrap-complete?cycle=…`.
7. Сервер эмитит `config.reload.done`, TUI убирает overlay и показывает success-toast.

### События EventV2

| Тип | Поля | Когда |
|---|---|---|
| `config.reload.pending` | `pending: boolean` | Релод поставлен в очередь (есть активные сессии) |
| `config.reload.executing` | `executing: boolean`, `bootstrapCycle?: number` | Релод начал исполняться |
| `config.reload.done` | — | Релод завершён, overlay можно снимать |

### Защита от гонок

- **Per-instance состояние** — релод одного проекта не блокирует другие.
- **Bootstrap-cycle handshake** — TUI шлёт `POST /config/bootstrap-complete` с конкретным номером цикла; защита от рассинхрона при двойных релодах.
- **Коалесинг повторов** — повторный `/reload` во время in-flight релода не даёт ложного ready-состояния.
- Во время overlay **блокируется клавиатурный ввод**, чтобы случайные нажатия не утекали в промпт.

### Тул `reload_config`

`reload_config` останавливает текущий tool-processing turn (`stopAfterToolResult: true`), но **больше не инжектит синтетический continuation-prompt** «continue where you left off». Это исключает мусор в durable-истории сессии и контексте модели. Сессия просто завершает тур после релода; пользователь продолжает следующим сообщением.

## Расхождение с upstream

Форк принял функционал PR #9871, но адаптировал под собственную архитектуру. Все отклонения зафиксированы здесь.

| Поверхность | Upstream PR | Форк |
|---|---|---|
| Слои | `Layer.mergeAll(…defaultLayer)` | `AppNodeBuilderV1.build(LayerNode.group([…node]))` — `ConfigReload.node` в группе `AppLayer` |
| `node`-экспорт | `LayerNode.make(layer, deps)` (позиционная) | `LayerNode.make({ service, layer, deps })` (объектная) |
| `InstanceLayer` | PR импортирует `@/project/instance-layer` | В форке не существует — убран; `ConfigReload` работает поверх существующего `InstanceStore.node` |
| События `config.reload.*` | определяются inline в `packages/opencode/src/config/reload.ts` через `EventV2.define` | Вынесены в `packages/schema/src/config-reload-event.ts` и зарегистрированы в `event-manifest.ts` (форк держит manifest в schema — источник истины для OpenAPI/SDK); `reload.ts` импортирует их оттуда |
| `reload_config` continuation | PR в одной из ревизий инжектил синтетический prompt | Убран — `stopAfterToolResult: true` без continuation-промпта |

### Конфликтная поверхность при `git merge upstream/dev`

Изменены **upstream-owned** файлы в `packages/opencode`, `packages/schema`, `packages/tui`. Это конфликт-поверхность, если upstream смержит PR #9871 или правит те же файлы. Зоны наибольшего риска:

- `packages/opencode/src/effect/app-runtime.ts` — `ConfigReload.node` в `LayerNode.group`
- `packages/opencode/src/tool/registry.ts`, `session/run-state.ts` — `ConfigReload.node` в deps
- `packages/schema/src/event-manifest.ts` — `…ConfigReloadEvent.Definitions` в `featureDefinitions`
- `packages/tui/src/context/sync.tsx` — reload-overlay координация

Если upstream смержит PR #9871, нужно будет свести: оставить upstream-реализацию, но заново вынести события в `packages/schema` и добавить mock `ConfigReload` в затронутые тесты (см. «Тестовая инфраструктура»).

### Files changed/added

| File | Change |
|---|---|
| `packages/opencode/src/config/reload.ts` | **new** — `ConfigReload` сервис (state machine, lifecycle) |
| `packages/opencode/src/tool/reload.ts` | **new** — `reload_config` тул |
| `packages/opencode/test/config/reload.test.ts` | **new** — регрессионные тесты |
| `packages/schema/src/config-reload-event.ts` | **new** — события `config.reload.*` (форк-адаптация) |
| `packages/schema/src/event-manifest.ts` — регистрация в `featureDefinitions` |
| `packages/opencode/src/effect/app-runtime.ts` — `ConfigReload.node` в `AppLayer` |
| `packages/opencode/src/tool/registry.ts`, `session/run-state.ts` — `ConfigReload.node` в deps; убран `defaultLayer` |
| `packages/opencode/src/server/routes/instance/httpapi/{api,groups/config,handlers/config,middleware/workspace-routing,server}.ts` — `ConfigLifecycleApi` группа (`/config/reload`, `/config/bootstrap-complete`, `/config/reload/status`) |
| `packages/opencode/src/session/processor.ts`, `tool/tool.ts`, `effect/runner.ts` — wiring |
| `packages/tui/src/{app.tsx,context/sync.tsx,routes/session/index.tsx,ui/dialog.tsx}` — reload overlay, bootstrap-refresh, keybind `app_reload` |
| `packages/sdk/js/src/v2/gen/{sdk.gen.ts,types.gen.ts}` | **regenerated** — `reload`, `bootstrapComplete`, `reloadStatus` методы + события в union |

### Тестовая инфраструктура (форк-специфично)

`ToolRegistry.node` и `SessionRunState.node` теперь зависят от `ConfigReload.node`, который тянет `InstanceStore.node` с **unbound**-зависимостью `InstanceBootstrap`. В форке `InstanceStore.node` нельзя скомпилировать без явного предоставления `InstanceBootstrap`. Поэтому в тестах, компилирующих `SessionPrompt.node` / `ToolRegistry.node` / `SessionRunState.node` без полного `InstanceStore`, добавлен mock `ConfigReload`:

```ts
const configReload = Layer.mock(ConfigReload.Service)({
  start: () => Effect.void,
  finish: () => Effect.void,
  check: () => Effect.void,
})
// [ConfigReload.node, configReload] в replacements LayerNode.compile
```

Затронутые тесты: `test/session/prompt.test.ts`, `test/tool/{registry,skill,task}.test.ts`, `test/session/{snapshot-tool-race,structured-output-integration}.test.ts`. `test/fixture/workspace.ts` уже включает `InstanceStore.node` + `InstanceBootstrap` — mock не нужен.

## Граничные случаи

- **Зависшая сессия** — релод ждёт вечно, без таймаута/force (наследие PR). Если сессия зависла в long-running тулу, `/reload` не запустится, пока тур не завершится. В TUI overlay pending показывается, но force-опции нет.
- **Двойной релод** — коалесится: второй запрос во время in-flight не даёт второй bootstrap-цикл.
- **Потерянный `config.reload.done`** — TUI имеет fallback-таймаут (`RELOAD_OVERLAY_FALLBACK_TIMEOUT`), после которого сам дёргает `bootstrap-complete` и снимает overlay.
- **Multi-instance (`opencode serve`)** — состояние per-instance, релод одного workspace не трогает другие.

## Open questions / future work

- **Таймаут/force для pending-релода** — сейчас бесконечная очередь. Добавить опцию `force` или таймаут было бы полезно, но это расширение API за рамки PR.
- **Хот-релод кред провайдеров** — работает в той мере, в какой креды читаются из конфига при загрузке инстанса (подтверждено в обсуждении PR).
- При мердже upstream-версии PR #9871 — свести реализации (см. «Конфликтная поверхность»).
