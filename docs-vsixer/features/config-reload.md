# /reload — hot-reload configuration without TUI restart

**Status:** stable
**Дата:** 2026-10-20
**Branch:** `dev` (портировано в V2-мёрerdже `070e437102`; историческая ветка `reload`)
**Связанные:** —
**История:** адаптация PR [anomalyco/opencode#9871](https://github.com/anomalyco/opencode/pull/9871) (issue #6719); после V2-мёрerdжа форк перешёл на собственный upstream-механизм релода

## TL;DR

Slash-команда `/reload` (upstream-команда `location.reload`) и тул `reload_config` перезагружают конфигурацию без перезапуска TUI — оба поверх **upstream-механизма**: `LocationServiceMap.reload()` + реактивные config-плагины с watch. Собственный форковый lifecycle (отложенный релод, TUI bootstrap-протокол, `ConfigLifecycleApi`, события `config.reload.*`) выпущен в ходе V2-мёрerdжа как избыточный.

## Мотивация

Issue #6719 (январь 2026): после правки `opencode.jsonc` или `.opencode/` нужно перезагружать конфигурацию, не закрывая TUI. Форк носил собственную реализацию (`ConfigReload`-сервис с отложенным релодом и TUI-bootstrap-протоколом), пока upstream не вмёрerdжил собственную: `LocationServiceMap.reload()`, HTTP-эндпоинт `location.reload`, CLI-команду `reload` и реактивные config-плагины, пересобирающиеся по watch-событиям.

После V2-мёрerdжа (2026-10-20) дублирующий lifecycle форка выпущен: upstream-механизм покрывает пользовательскую возможность (включая автоматический релод по изменению файлов), а форк сохраняет только то, чего у upstream нет — slash-команду в TUI-стиле уже даёт сам upstream, поэтому единственное настоящее расхождение теперь — тул `reload_config` для агентов.

## Поведение

### Slash-команда `/reload`

Upstream-команда `location.reload` в `packages/tui/src/app.tsx` (slash-имя `reload`, группа System):

1. `dialog.clear()`, info-toast «Reloading configuration…».
2. `client.api.location.reload()` — инвалидация и пересборка графов Location на сервере.
3. Success/error toast по результату.

Дефолтный keybind — `none` (только slash и палитра), ремапится в `tui.jsonc` по id `location.reload`.

### Реактивные config-плагины (upstream)

Изменение конфиг-файлов подхватывается автоматически: `packages/core/src/config/watch.ts` планирует watch-множество по источникам конфига, а доменные плагины (`config/plugin/{agent,command,skill,…}.ts`) реактивно пересобираются при изменении своих входов. Ручной `/reload` нужен, когда хочется перечитать всё сразу и явно.

### Тул `reload_config` (форк)

Агентский тул поверх того же upstream-механизма:

1. Permission-гейт: `Permission.Service.assert({ action: "reload_config", resources: ["*"], save: ["*"], … })` — отказ превращается в `ToolFailure`.
2. `ReloadService.reload()` → `LocationServiceMap.reload()`: инвалидация открепляет кэшированные графы Location; in-flight заёмщики (включая сам тул) продолжают работать на старом графе, поэтому результат тула доставляется гарантированно.
3. Результат содержит `stopAfterToolResult: true` — текущий шаг завершается **после записи результата тула** (`needsContinuation: false`), без синтетического continuation-промпта: сессия просто идёт idle, пользователь продолжает следующим сообщением. Это исключает мусор в durable-истории и контексте модели.

## Расхождение с upstream

После V2-мёрerdжа расхождение минимально: upstream-механизм релода принят целиком, форк добавляет только тул.

| Поверхность | Upstream | Форк |
|---|---|---|
| Механизм релода | `LocationServiceMap.reload()` + эндпоинт `location.reload` + CLI `reload` | принят как есть |
| Реактивные config-плагины | `config/watch.ts` + plugin-схема | приняты как есть |
| Slash `/reload` в TUI | команда `location.reload` (`slash: { name: "reload" }`) | принята как есть |
| Тул `reload_config` | нет | **форк**: `tool/plugin/reload.ts` + Location-node мост `tool/reload-service.ts`, регистрация в `plugin/internal.ts` |
| `stopAfterToolResult` | нет | **форк**: поле `Tool.Result` в `packages/schema/src/tool.ts`, проводится через `tool/runtime.ts`, `tool.ts` и шаг-цикл раннера |

### Выпущенные форковые поверхности (до V2-мёрerdжа)

Решение зафиксировано при синке 2026-10-20 (выбор: «upstream reload»):

| Было (форк) | Стало |
|---|---|
| `ConfigReload`-сервис (`packages/opencode/src/config/reload.ts`) с немедленным/отложенным режимом | удалён вместе с пакетом `packages/opencode`; отложенность не нужна — upstream-инвалидация безопасна для in-flight сессий по дизайну |
| `ConfigLifecycleApi` (`/config/reload`, `/config/reload/status`, `/config/bootstrap-complete`) | удалена; есть upstream `location.reload` |
| События `config.reload.{pending,executing,done}` (`packages/schema/src/config-reload-event.ts` + event-manifest) | удалены |
| TUI bootstrap-протокол (overlay, cycle-handshake, `context/sync.tsx`, reload-overlay в `ui/dialog.tsx`, команда `app.reload`) | удалён; feedback — тосты upstream-команды `location.reload` |
| Deferred-reload хуки в раннере (`effect/runner.ts`, `session/run-state.ts`) | удалены |

### Конфликтная поверхность при `git merge upstream/dev`

Форк-owned файлы фичи (upstream их не трогает, конфликт возможен только при рефакторинге соседей):

- `packages/core/src/tool/plugin/reload.ts` — тул
- `packages/core/src/tool/reload-service.ts` — Location-node мост к `LocationServiceMap`
- `packages/core/src/plugin/internal.ts` — регистрация `ReloadTool.Plugin` (список `pre`), `ReloadService.Service` (список services), `ReloadService.node` (группа `requirements`)

Upstream-owned точки интеграции (правились минимально, риск конфликтов низкий): `packages/schema/src/tool.ts` (поле `stopAfterToolResult`), `packages/core/src/tool/runtime.ts` + `tool.ts` (проведение флага), `packages/core/src/session/runner/publish-llm-event.ts` (fold флага в шаг).

## Usage / Configuration

- **TUI:** введите `/reload` (или палитра → «Reload configuration»).
- **Конфиг:** правки `opencode.jsonc` / `.opencode/**` подхватываются реактивными плагинами автоматически; `/reload` — явная перечитка всего.
- **Агентам:** тул `reload_config` (без входных параметров). Права настраиваются в конфиге:

```jsonc
{
  "permission": [
    { "action": "reload_config", "resource": "*", "effect": "allow" }
  ]
}
```

## Migration

Для пользователей форка, обновившихся через V2-мёрerdж:

- Событий `config.reload.*` больше нет — код, подписанный на них (плагины, скрипты), нужно перевести на тосты upstream-команды или просто убрать.
- Клавиша `app_reload` не существует; ремап вешайте на `location.reload`.
- Pending-очередь исчезла: релод больше не ждёт idle сессий. Это безопасно — upstream-инвалидация лишь открепляет кэшированные графы, активные executions доигрывают на старом графе.
- Для агентов ничего не меняется: тул `reload_config` доступен как прежде, семантика «остановиться после результата» сохранена.

## Реализация

| Файл | Роль |
|---|---|
| `packages/core/src/tool/plugin/reload.ts` | тул `reload_config`: permission-гейт + `ReloadService.reload()` + `stopAfterToolResult: true` |
| `packages/core/src/tool/reload-service.ts` | Location-node мост: сервис в графе Location, внутри вызывает глобальный `LocationServiceMap.reload()` (типовая развязка цикла через `LayerNode.Provider`) |
| `packages/core/src/plugin/internal.ts` | регистрация тула и сервиса в composition builtin-плагинов |
| `packages/schema/src/tool.ts` | `Tool.Result.stopAfterToolResult` |
| `packages/core/src/tool/runtime.ts`, `packages/core/src/tool.ts` | проведение флага через нормализацию результата |
| `packages/core/src/session/runner/publish-llm-event.ts` | fold флага в шаг (`needsContinuation: false`) |
| `packages/tui/src/app.tsx` | upstream-команда `location.reload` (slash `/reload`) |
| `packages/core/src/location-service-map.ts`, `packages/server/src/handlers/location.ts`, `packages/core/src/config/watch.ts` | upstream-механизм (не форк) |

## Open questions / future work

- **Возврат deferred-релода.** Если когда-нибудь понадобится «перезагрузить, но не раньше, чем сессия станет idle» — поверх upstream-инвалидации можно добавить очередь на `SessionExecution`; сейчас потребности нет.
- **Событие для TUI.** У upstream-релода нет durable-события — при желании можно вернуть лёгкое событие-уведомление в `packages/schema` (без lifecycle-протокола).
