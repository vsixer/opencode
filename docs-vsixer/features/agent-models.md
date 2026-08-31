# agent-models: нативный реестр моделей агентов и команд

Status: implemented, 2026-08-29 (branch `question-form`).

Нативная поддержка реестра `agent-models.jsonc`: централизованное назначение
моделей и reasoning-уровней агентам и командам через роли, с availability-гейтами
и оверлеем. Заменяет внешний скрипт синка (`/misc/sync-agent-models` в MacroCRM)
для read-пути: ядро само читает реестр при загрузке конфигурации и при `/reload`.

## Цепочка поиска реестра

1. `OPENCODE_AGENT_MODELS` (env; отсутствующий путь/пустая строка/директория = «не найден»);
2. ключ `agent_models` в `opencode.json` (глобальном или проектном; абсолютный путь или от `~`; относительный путь и несуществующий файл — warning и пропуск);
3. `<worktree>/.opencode/config/agent-models.jsonc`;
4. `<directory>/.opencode/config/agent-models.jsonc` (рабочая директория вне git);
5. `~/.config/opencode/config/agent-models.jsonc`.

Первый найденный файл выигрывает, кросс-файлового слияния нет. Битый базовый
JSONC выключает слой реестра на этой загрузке (без отката по цепочке). Пустой
файл/только комментарии — тихий no-op. Ядро ничего не пишет.

Диагностика в логе при каждой загрузке конфига: `agent-models registry: loaded`
(путь + число ролей) — слой включён; `none found, layer off` (debug) — файл не
найден; заданный, но несуществующий `OPENCODE_AGENT_MODELS` — warning. Отсутствие
`loaded` в логе означает, что команды исполняются без реестра, а модель берётся
из currentModel.

Оверлей `agent-models.disabled.jsonc` рядом с найденным файлом: учитываются только
списки отключения, значения конкатенируются. Принимаются обе формы: списки на
верхнем уровне файла (пишет внешний тулинг `/misc/sync-agent-models`
disable/enable) и под `availability`, как в базовом реестре. Оверлей должен лежать
рядом с файлом, который ядро реально находит; оверлей общий на каталог —
действует на каждый реестр из этого каталога.

Deprecated: старое имя оверлея `agent-models.local.jsonc` (слишком похоже на
`agent-models-local.jsonc` — реестр режима oc-local) продолжает читаться с
warning-ом до переименования файла; при наличии обоих имён выигрывает новое.
Миграция: переименовать файл рядом с каждым реестром и обновить write-путь
disable/enable в `/misc/sync-agent-models`.

## Формат и разрешение ролей

```jsonc
{
  "prefixes":  { "project": "<abs path или ~…>", "global": "…" },
  "models":    { "m1": { "model": "prov/id", "reasoning": { "0": "none", "2": "high" } } },
  "capabilities": { "cap": ["m1", "m2"] },
  "roles":     { "project:agent/x.md": "cap:2", "project:review/primary": "cap" },
  "providerGroups": { "cloud": ["prov"] },
  "availability": { "disabledProviders": [], "disabledModels": [] },
  "force": false
}
```

- `force: true` — режим принуждения (например, реестр oc-local): назначение
  перекрывает явную `model` во frontmatter `.md` (включая запечённую старым
  sync-скриптом) и явную модель в секции `agent` конфига. По умолчанию
  выключен — явно заданная модель побеждает реестр.

- Ключ роли — `prefix:путь/к/файлу.md`; матчатся и сокращённые формы (без
  сегмента `agent/agents/command/commands` и/или без `.md`) — детерминированный
  порядок попыток: `key`, `key.md`, затем `{agent,agents,command,commands}/key`
  и `…/key.md`.
- Значение `cap` — модель без reasoning; `cap:N` — reasoning-уровень из
  маппинга выбранного кандидата. Квирки: `"cap:"` ≡ `"cap:0"`, `"cap:01"` → 1;
  нечисловой/отрицательный уровень — роль целиком неразрешима.
- Приоритет: frontmatter `.md` → реестр → json-секции `opencode.json` →
  `currentModel`. Непустая `model` во frontmatter подавляет назначение целиком.
- Availability: `disabledProviders` с раскрытием `providerGroups` на один
  уровень; STRICT-ABORT — заявленный, но битый кандидат запрещает переход к
  следующему.
- Глобальный аналог: локальный файл с глобальным двойником (`agents/x.md` при
  `prefixes.global`) не получает назначение — модель наследуется через fold.

## Встроенные агенты (`builtin:` roles)

Встроенные агенты без `.md`-файла — `plan`, `build`, `general`, `explore`,
`title`, `summary`, `compaction` — назначаются ролью `"builtin:<name>": "capability[:N]"`.
Префикс `builtin` зарезервирован: в `prefixes` его задавать не нужно, файловых
целей у таких ролей нет (в файловом проходе они молча пропускаются).

Механика: значение применяется к секции `agent` конфига до её декода — модель
попадает в `agent.<name>.model`, reasoning (`:N`) — в `agent.<name>.options.reasoningEffort`
(тот же канал, что у `.md`-агентов). Явная непустая `model` в секции `agent`
из `opencode.json` (глобального или проектного) побеждает роль — гейт,
эквивалентный frontmatter для файловых определений. Неизвестное имя встроенного
агента — warning и пропуск. Разрешение capability/кандидатов/availability —
общее с файловыми ролями.

## Reasoning команд (переходное окно)

- `reasoningEffort` во frontmatter команды игнорируется (вычищается до decode) —
  единственный источник reasoning команды — реестр. Поле в схеме команды —
  приватный канал реестра.
- Роль `":N"` побеждает reasoning агента и variant-наборы модели (мержится в
  опции провайдера последним, переживает continuation-ходы tool-loop через
  модель-информацию user-сообщения).
- Роль без `:N` — команда наследует reasoning агента.

## Subtask-команды

Reasoning роли subtask-команды (`subtask: true`) доезжает до дочерней сессии:
уровень зеркалируется на assistant-сообщении родительского хода и передаётся в
`prompt()` дочерней сессии в TaskTool тем же каналом, что и `variant`. Семантика
приоритетов та же, что и на обычном командном пути: `":N"` побеждает reasoning
агента и variant-наборы, `cap` без `:N` — дочерняя сессия наследует reasoning
своего агента.

## Внешние migration-notes (`/misc/sync-agent-models`, MacroCRM-репозиторий)

- write-режим и drift-check пометить устаревшими: read-путь теперь нативный.
- disable/enable переориентировать на оверлей рядом с файлом, найденным ядром
  по цепочке (env → worktree → directory → global).
- Утверждение «reasoningEffort left untouched (loose mode)» исправить: ядро
  вычищает рукописный `reasoningEffort` команд; reasoning команды — только из
  реестра.

## Расхождение с upstream

Изменения в upstream-файлах (аддитивные): `packages/core/src/flag/flag.ts`
(геттер `OPENCODE_AGENT_MODELS`), `packages/core/src/v1/config/command.ts`,
`packages/schema/src/{command.ts,v1/session.ts}` (опциональные поля
`reasoningEffort`), `packages/opencode/src/config/config.ts` (хук post-scan),
`packages/opencode/src/{command/index.ts,session/prompt.ts,session/llm/request.ts}`
(конвейер reasoning команд), регенерированный `packages/client/src/generated`.
Новые файлы форка: `packages/opencode/src/config/agent-models.ts`,
`packages/opencode/test/config/agent-models.test.ts`.
