# instructionsExclude — исключение файлов инструкций

**Status:** stable
**Дата:** 2026-08-22
**Branch:** `exclude-configs`
**Связанные:** —

## TL;DR

Новое поле `instructionsExclude` в `opencode.json`: список glob-паттернов файлов инструкций (`AGENTS.md`, `CLAUDE.md`, …), которые opencode полностью игнорирует — файл остаётся на диске нетронутым.

## Мотивация

opencode автоматически подхватывает файлы инструкций из трёх источников: глобальные (`~/.config/opencode/AGENTS.md`, `~/.claude/CLAUDE.md`), автопоиск `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` вверх по дереву до корня worktree и явные пути из `instructions`. Если в репозитории лежит «чужой» `AGENTS.md`, отдать его модели нельзя было никак — только удалить файл или править его содержимое, что в чужом репозитории нежелательно.

## Поведение

Поле применяется как единый фильтр ко всем файловым источникам инструкций:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructionsExclude": ["AGENTS.md", "docs/AGENTS.md"]
}
```

Семантика:

- Паттерн сопоставляется с путём **относительно корня проекта** (worktree). `"AGENTS.md"` — только файл в корне; `"docs/AGENTS.md"` — конкретный путь; `"**/AGENTS.md"` — любая глубина.
- В non-git каталогах worktree = `/` (семантика upstream `InstanceContext`), поэтому относительная база — рабочая директория.
- Файлы вне проекта (глобальные) сопоставляются по абсолютному пути; поддерживается префикс `~/`: `"~/.config/opencode/AGENTS.md"`.
- **Exclude побеждает include**: файл из `instructions`, попавший под паттерн, отбрасывается.
- URL-инструкции (`http(s)://`) не фильтруются.
- Исключение действует и на walk-up подключение: при чтении файла агентом инструкции из родительских каталогов не цепляются, если файл под паттерном.
- Отсутствующее/пустое поле — поведение идентично upstream.

## Расхождение с upstream

Поле форк-специфично. Изменены четыре upstream-owned файла — это конфликтная поверхность при `git merge upstream/dev`:

| Файл | Изменение |
|---|---|
| `packages/core/src/v1/config/config.ts` | Новое поле `instructionsExclude` в схеме `Info` (рядом с `instructions`) |
| `packages/opencode/src/config/config.ts` | `mergeConfigConcatArrays`: union-merge паттернов между слоями конфига |
| `packages/opencode/src/session/instruction.ts` | Функция `excluded()` + вызовы в `systemPaths()` и walk-up цикле `resolve()` |
| `packages/opencode/test/session/instruction.test.ts` | Хелпер `withFilesConfig` (git-tmpdir + конфиг-оверрайды), 6 тестов |

Все вставки локальны (одно поле схемы, один блок merge, одна функция + два call-site), вероятность конфликта при синке низкая. Если upstream добавит аналог с другим именем/семантикой — потребуется сведение.

## Usage / Configuration

Типовые сценарии:

```json
{
  "instructionsExclude": [
    "AGENTS.md",
    "**/AGENTS.md",
    "~/.claude/CLAUDE.md"
  ]
}
```

- `"AGENTS.md"` — игнорировать репозиторный AGENTS.md в корне.
- `"**/AGENTS.md"` — игнорировать все AGENTS.md на любой глубине.
- `"~/.claude/CLAUDE.md"` — не подтягивать глобальный CLAUDE.md.

## Migration

Не требуется: поле опционально, при отсутствии поведение совпадает с upstream.

## Реализация

- Схема: `packages/core/src/v1/config/config.ts` (`Info.instructionsExclude`; v2-схемы конфига нет).
- Фильтр: `packages/opencode/src/session/instruction.ts` — `excluded()` через `FSUtil.globMatch` (minimatch, `dot: true`); применяется к итоговому `Set` путей в `systemPaths()` (закрывает глобальные, автопоиск и явные пути одной точкой) и в walk-up цикле `resolve()`.
- Merge слоёв: `packages/opencode/src/config/config.ts` (`mergeConfigConcatArrays`).
- Тесты: `packages/opencode/test/session/instruction.test.ts` — T-1…T-6 (корневой/вложенный/рекурсивный паттерн, приоритет exclude над include, `~/` для глобального файла, walk-up, регресс без поля). Хелпер `withFilesConfig` использует git-инициализацию tmpdir: без неё include-паттерны с `**` уходят в glob по всей корневой ФС.

## Open questions / future work

- Negation-паттерны (`!...`) внутри списка — не реализованы, по потребности.
- Исключение URL-инструкций — вне скоупа текущей версии.
- При появлении аналога в upstream — рассмотреть переход на его имя/семантику.
