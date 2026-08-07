# BTW — боковая панель (ephemeral side-chat)

**Status:** stable
**Дата:** 2026-08-07
**Branch:** `btw-side-panel`
**Связанные:** —

## TL;DR

`/btw` открывает эфемерный side-chat в **боковой панели справа** (рабочая область делится 50/50 по горизонтали), а не в блокирующей модалке. Основная сессия остаётся полностью интерактивной — можно работать в двух сессиях одновременно: слева основная, справа эфемерная. Side-chat заморожен на контексте текущей сессии и живёт в памяти сервера (in-memory, без персистенции).

## Мотивация

В первой реализации (коммит `9be9fc157`) `/btw` открывался centered-модалкой через стек диалогов: тёмный фон, `zIndex=3000`, блокировка основной сессии. Пока идёт side-вопрос, основную работу поставить на паузу нельзя.

Цель — дать вторую «параллельную» сессию рядом с основной: задать быстрый вопрос в side-chat, не прерывая основной поток. Модалка этому мешает, поэтому UI переделан в сплит-панель, а вся серверная логика (`session/btw`) осталась без изменений.

## Поведение

### Раскладка

- Панель рендерится сиблингом основного контента в `routes/session/index.tsx`: `[основная | btw]`.
- Ширина панели — `floor(terminal_width / 2)`, основная занимает остаток. Раскладка ровно 50/50.
- Правый sidebar (список сессий, ~42 колонки) **скрывается**, пока btw открыта — `sidebarVisible` возвращает `false` при `btwActiveHere`.
- `contentWidth` (контекст переноса сообщений) пересчитывается с учётом ширины панели.

### Клавиши

| Keybind | Команда | Действие |
|---|---|---|
| `<leader>b` (`session_btw`) | `session.btw` | **Cycle фокуса**: закрыто → открыть+фокус на btw; btw в фокусе → фокус на основную; основная в фокусе → фокус на btw |
| `<leader>p` (`session_btw_close`) | `session.btw.close` | Закрыть панель (фокус возвращается в основную) |
| та же клавиша, что `session.interrupt` в `tui.jsonc` | (локальный биндинг панели) | Прервать ход btw (только когда поле btw в фокусе) |
| `/btw` (slash) | `session.btw` | То же, что `<leader>b` |

Обе клиши и slash входят в `sessionBindingCommands` и активны только на роуте сессии.

### Управление фокусом

Главная техническая проблема — `component/prompt/index.tsx` имеет автофокус-эффект, который забирает фокус, когда `visible && dialog.stack.length === 0`. Панель btw — не диалог, поэтому этот эффект непрерывно крал бы фокус у поля btw.

Решение — новый prop `yieldFocus?: boolean` на `<Prompt>`:
- `yieldFocus={btwActiveHere()}` пока панель открыта.
- Эффект автофокуса в этом режиме **не грэббит** фокус сам, но и **не blur'ит** поле, если оно получено явно (цикл фокуса / клик). Так обе панели сосуществуют без гонки.

Команда cycle переключает фокус через ref'ы: `promptRef.current.focus()` ↔ `btw.ref().focus()`, а решение «кого фокусить» принимает по `btw.ref().focused()`.

### Thinking-блоки (сворачиваемые)

- Каждый reasoning-блок по умолчанию **свёрнут** в однострочный маркер: `▸ thinking (1234 chars)`.
- Клик по маркеру разворачивает: `▾ thinking` + полный текст через `<code filetype="markdown" syntaxStyle={subtleSyntax()}>`.
- Состояние хранится в `expandedThinking: Set<messageId>` — независимо для каждого блока.
- Защита от срабатывания при выделении текста: `if (renderer.getSelection()?.getSelectedText()) return`.
- Развёрнутый reasoning рендерится с приглушённой (subtle) подсветкой, как `ReasoningPart` основной сессии.

### Индикатор выполнения запроса

Истинный прогресс LLM-стрима (проценты) недоступен, поэтому индикатор — **таймер идущего тура**:
- В шапке справа при `busy` появляется `⟳ Ns` (цвет `theme.primary`) — секунды с момента старта хода. Видно всегда, даже если прокрутили сообщения вверх.
- Спинсер у хвоста сообщений тоже показывает elapsed: `thinking… 3s`.
- `createEffect` на `busy()` тикает раз в секунду, чистится через `onCleanup`.

### Подсветка синтаксиса (как в основной сессии)

- **Ассистент-текст** — `<markdown syntaxStyle={syntax()} filetype="markdown" streaming internalBlockMode="top-level" tableOptions={{style:"grid"}} fg={theme.markdownText}>`. Код-блоки ```` ```lang ````, списки, заголовки, таблицы — с подсветкой tree-sitter, переносятся по ширине панели.
- **Reasoning (развёрнутый)** — `<code filetype="markdown" syntaxStyle={subtleSyntax()}>` (приглушённо).
- **User-текст** — plain `<text>` (совпадает с основной сессией, там user-сообщения тоже без markdown).
- Роль помечена коротким дим-лейблом `btw` над markdown-блоком.

### Прерывание хода

Биндинг прерывания **зеркалит** клавишу `session.interrupt` из конфига пользователя (уважает ремап из `tui.jsonc`), а не хардкодит escape:
- `tuiConfig.keybinds.get("session.interrupt")` → resolved `Binding[]` → повторно регистрируется с `cmd: abortTurn` и `fallthrough: true`.
- `fallthrough: true` гарантирует, что когда btw не в фокусе, клавиша проходит далее к `session.interrupt` основной сессии — две панели не глушат interrupt друг друга.
- `cmd` проверяет `renderer.currentFocusedEditor === textarea` — срабатывает только когда поле btw в фокусе.
- Двухканальный обрыв: локальный `AbortController` рвёт fetch немедленно, серверный `/btw/abort` надёжен при half-open SSE.
- Таймауты: hard 60s (полностью глухое зависание), inactivity 30s (нет чанков).

### Жизненный цикл

- **In-memory, без персистенции.** При открытии панель вызывает `btw.open({parentID})` → сервер создаёт новый `btwID`. История живёт только в памяти.
- **Сброс при навигации.** Эффект в `app.tsx` (`createEffect(on(() => route.sessionID, () => btw.close()))`) закрывает btw при смене сессии — панель не «всплывает» пустой при возврате на старую сессию. Этот эффект живёт в здоровом owner'е (App), а не в disposal-цикле Session.
- **Закрытие** (`<leader>p` или navigate) → `btw.close()` → `BtwPanel` unmount'ится → `onCleanup` вызывает `btw.close({btwID})` на сервере.

## Расхождение с upstream

btw — **полностью fork-фича**, в `anomalyco/opencode` её нет. Вся серверная часть и TUI добавлены форком.

| Upstream | Fork |
|---|---|
| Нет команды `/btw`, нет side-chat. | Команда `/btw`, серверный ephemeral side-chat (`session/btw/`) + TUI-панель. |
| — | Первая реализация была модалкой (`dialog-btw.tsx`, коммит `9be9fc157`); переделана в боковую панель (коммит `2d95f4c1f`). |
| `<Prompt>` без `yieldFocus`; автофокус безусловный. | Добавлен prop `yieldFocus` — автофокус уступает, пока открыта боковая панель. |
| `ui/dialog.tsx` без btw-специфики. | (Форк ранее добавлял `setOnEscape`/`onEscape` под btw-модалку; после перехода на панель этот btw-only код удалён, `dialog.tsx` возвращён к чистому виду.) |

### Конфликтная поверхность (upstream-owned файлы, которых касается фича)

Это файлы под `packages/` (upstream-owned) — основной конфликт-поверхностью при `git merge upstream/dev`:

| Файл | Изменение |
|---|---|
| `packages/tui/src/app.tsx` | + обёртка `BtwProvider`; переписана команда `session.btw` (cycle); добавлена `session.btw.close`; эффект закрытия btw при смене сессии. |
| `packages/tui/src/routes/session/index.tsx` | + `useBtw()`, memos `btwActiveHere`/`btwWidth`, override `sidebarVisible`, `contentWidth` учитывает панель, рендер `<BtwPanel/>`, `<Prompt yieldFocus={btwActiveHere()}/>`, `"session.btw.close"` в `sessionBindingCommands`. |
| `packages/tui/src/component/prompt/index.tsx` | + prop `yieldFocus` + ветка в автофокус-эффекте. |
| `packages/tui/src/config/keybind.ts` | + `session_btw_close: <leader>p` + `CommandMap.session_btw_close`. |
| `packages/tui/src/ui/dialog.tsx` | удалён btw-only `setOnEscape`/`onEscape` (чистка после ухода от модалки). |

### Fork-owned файлы (новые)

| Файл | Назначение |
|---|---|
| `packages/tui/src/context/btw.tsx` | `BtwProvider`: `state()`/`open`/`close`, `ref()`/`setRef` для цикла фокуса. |
| `packages/tui/src/routes/session/panel-btw.tsx` | `BtwPanel`: стрим/timeout/abort, рендер (markdown + подсветка, сворачиваемый thinking, индикатор хода, спинсер), ref поля ввода. |
| `packages/opencode/src/session/btw/index.ts` | Сервер: HttpApi-группа `/btw` (`open`/`send`/`close`/`abort`), in-memory store keyed by `btwID`, заморозка контекста parent-сессии. |
| `packages/opencode/src/session/btw/schema.ts` | Серверные схемы (`BtwOpenRequest`, chunk'и стрима и т.д.). |

`packages/tui/src/routes/session/dialog-btw.tsx` (бывшая модалка) удалён — логика перенесена в `panel-btw.tsx`.

## Usage / Configuration

### Повседневное использование

1. На роуте сессии нажмите `<leader>b` (или введите `/btw`) — справа откроется панель, фокус перейдёт в поле ввода btw.
2. Введите side-вопрос, `Enter` — отправить. Поток стримится в панель, основной промпт остаётся рабочим.
3. `<leader>b` — переключить фокус между btw и основной.
4. Клик по `▸ thinking (…)` — развернуть/свернуть reasoning.
5. `<leader>p` — закрыть панель (или уйти на другую сессию — закроется автоматически).

### Переназначение клавиш

В `tui.jsonc` (секция `tui.keybinds`):

```jsonc
{
  "tui": {
    "keybinds": {
      "session_btw": "<leader>b",        // открыть / цикл фокуса
      "session_btw_close": "<leader>p",  // закрыть панель
      "session_interrupt": "ctrl+x"      // ваш ремап interrupt автоматически применяется и к btw
    }
  }
}
```

Прерывание хода btw **не нужно настраивать отдельно** — оно зеркалирует `session_interrupt`. Любой ремап `session_interrupt` применяется к обеим панелям.

## Реализация

### Архитектура фокуса и состояния

```
BtwProvider (context/btw.tsx, обёрнут вокруг DialogProvider в app.tsx)
  ├─ state(): { parentID } | undefined   // открыта ли панель и для какой сессии
  ├─ open(parentID) / close()
  └─ ref() / setRef()                    // BtwRef поля ввода панели

app.tsx
  ├─ session.btw (cycle):  open | ref.focus() | promptRef.focus()
  ├─ session.btw.close:    btw.close()
  └─ createEffect(on(route.sessionID, () => btw.close()))   // сброс при навигации

routes/session/index.tsx
  ├─ btwActiveHere = btw.state()?.parentID === route.sessionID
  ├─ btwWidth = floor(width / 2)
  ├─ sidebarVisible → false при btwActiveHere
  ├─ <BtwPanel parentID width={btwWidth}/>  (Show)
  └─ <Prompt yieldFocus={btwActiveHere()}/>

component/prompt/index.tsx
  └─ createEffect: if (yieldFocus) return  // не грэббим фокус, пока панель открыта
```

### Поток данных (стрим ответа)

```
sdk.client.btw.send({btwID, text}, {signal: turnAbort})
  → SSE: for await (chunk of resp.stream)
      → handlePart(chunk, assistantId)
          reason-delta → patchAssistant(reasoning += delta)
          text-delta   → patchAssistant(text += delta)
          tool         → patchAssistant(tools[…])
          turn-end|error|closed → break
  finally → setBusy(false), cleanup timers
```

### Подводный камень: TDZ eager-memo

`createMemo` в Solid выполняется **eagerly** (сразу при создании). В `routes/session/index.tsx` `btwActiveHere` ссылается на `btw` — поэтому `const btw = useBtw()` обязан быть объявлен **выше** этого мемо. Иначе eager-выполнение обращается к `btw` в TDZ → краш `Cannot access X before initialization` при перемонтировании Session (навигация). TypeScript это не ловит (ссылка внутри вложенной arrow-функции). Порядок: `wide → btw → btwActiveHere → btwWidth`.

Ещё один анти-паттерн, которого сознательно избегаем: **запись ancestor-сигнала в `onCleanup` дочернего owner'а** (рвёт реактивную очередь Solid). Поэтому закрытие btw при навигации сделано эффектом в `App` (здоровый owner), а не `onCleanup` в `Session`.

## Open questions / future work

- **Ширина как опция.** Сейчас жёстко 50/50. Можно вынести в настройку (фиксированная ширина / пропорция).
- **Персистенция side-chat.** In-memory — история теряется при перезапуске сервера и при закрытии панели. Если понадобится сохранять, потребуется отдельный storage-дизайн.
- **Независимый interrupt для btw.** Сейчас abort btw доступен только из поля btw (фокус-гейт). Добавить «прервать btw откуда угодно» — отдельный keybind или индикатор-кнопка в шапке.
- **Code-блоки в узкой панели.** Подсветка переносится по ширине контейнера; очень широкие блоки могут быть тесны. Горизонтальный скролл внутри code-блока не реализован.
- **Многоуровневый thinking.** Сейчас один уровень свёрнутости. Если появятся вложенные reasoning-секции — рассмотреть дерево.
