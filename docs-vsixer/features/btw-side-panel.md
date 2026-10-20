# BTW — боковая панель (ephemeral side-chat)

**Status:** stable
**Дата:** 2026-10-20
**Branch:** `dev` (панель сохранена и портирована в V2-мёрerdже `070e437102`; историческая ветка `btw-side-panel`)
**Связанные:** —
**Upstream:** у upstream есть собственный one-shot `/btw` (`session.aside`) — форкская панель его не заменяет, а сосуществует (см. «Расхождение с upstream»)

## TL;DR

`/btw` открывает эфемерный side-chat в **боковой панели справа** (рабочая область делится 50/50 по горизонтали), а не в блокирующей модалке. Основная сессия остаётся полностью интерактивной — можно работать в двух сессиях одновременно: слева основная, справа эфемерная. Side-chat заморожен на контексте текущей сессии и живёт в памяти сервера (in-memory, без персистенции). После V2-мёрerdжа SSE-транспорт идёт через новый V2-клиент (`client.api.btw.*`, пути `/api/btw/*`).

## Мотивация

В первой реализации (коммит `9be9fc157`) `/btw` открывался centered-модалкой через стек диалогов: тёмный фон, `zIndex=3000`, блокировка основной сессии. Пока идёт side-вопрос, основную работу поставить на паузу нельзя.

Цель — дать вторую «параллельную» сессию рядом с основной: задать быстрый вопрос в side-chat, не прерывая основной поток. Модалка этому мешает, поэтому UI переделан в сплит-панель, а вся серверная логика (`session/btw`) осталась без изменений.

## Поведение

### Раскладка

- Панель рендерится сиблингом основного контента в `routes/session/index.tsx`: `[основная | btw]`.
- Ширина панели — половина рабочей области (50/50), `contentWidth` (контекст переноса сообщений) пересчитывается с учётом ширины панели.
- Панель монтируется внутри layout-примитивов upstream (правая половина split'а).

### Клавиши

| Keybind | Команда | Действие |
|---|---|---|
| `<leader>b` (`session.btw`) | `session.btw` | **Cycle фокуса**: закрыто → открыть+фокус на btw; btw в фокусе → фокус на основную; основная в фокусе → фокус на btw |
| `<leader>p` (`session.btw.close`) | `session.btw.close` | Закрыть панель (фокус возвращается в основную) |
| та же клавиша, что `session.interrupt` в `tui.jsonc` | (локальный биндинг панели) | Прервать ход btw (только когда поле btw в фокусе) |
| `/btw` (slash) | `session.btw` | То же, что `<leader>b`. Slash владеет **форкская панель**; upstream-команда `session.aside` осталась palette-only |

После V2-мёрerdжа id команд и биндингов — dot-неймспейс upstream (`session.btw`, `session.btw.close`); `session.sidebar.toggle` перенесён на `<leader>v`, чтобы освободить `<leader>b` под btw.

### Управление фокусом

Главная техническая проблема — `component/prompt/index.tsx` имеет автофокус-эффект, который забирает фокус, когда `visible && dialog.stack.length === 0`. Панель btw — не диалог, поэтому этот эффект непрерывно крал бы фокус у поля btw.

Решение — prop `yieldFocus?: boolean` на `<Prompt>`:
- `yieldFocus` выставлен, пока панель открыта.
- Эффект автофокуса в этом режиме **не грэббит** фокус сам (`input.focusable = true` выполняется до early-return), но и **не blur'ит** поле, если оно получено явно (цикл фокуса / клик). Так обе панели сосуществуют без гонки.

Команда cycle переключает фокус через ref'ы: `promptRef.current.focus()` ↔ `btw.ref().focus()`, а решение «кого фокусить» принимает по `btw.ref().focused()`.

### Thinking-блоки (сворачиваемые)

- Каждый reasoning-блок по умолчанию **свёрнут** в однострочный маркер: `▸ thinking (1234 chars)`.
- Клик по маркеру разворачивает: `▾ thinking` + полный текст через `<code filetype="markdown" syntaxStyle={…subtle…}>`.
- Состояние хранится в `expandedThinking: Set<messageId>` — независимо для каждого блока.
- Защита от срабатывания при выделении текста: проверка `renderer.getSelection()`.
- Развёрнутый reasoning рендерится с приглушённой (subtle) подсветкой, как reasoning основной сессии.

### Индикатор выполнения запроса

Истинный прогресс LLM-стрима (проценты) недоступен, поэтому индикатор — **таймер идущего тура**: `⟳ Ns` в шапке при `busy` и elapsed у спинсера хвоста сообщений. Живой секундный тикер есть и в **основной сессии** (футер assistant-сообщения, `· Ns` рядом с моделью): на время ожидающего вопроса агента таймер замораживается — пауза общая для всего хода, накапливается и вычитается из elapsed, поэтому ожидание ответа не учитывается ни в живом значении, ни в финальном.

### Подсветка синтаксиса (как в основной сессии)

- **Ассистент-текст** — `<markdown>` со stream-рендерингом и tree-sitter подсветкой код-блоков, переносится по ширине панели.
- **Reasoning (развёрнутый)** — приглушённый `<code filetype="markdown">`.
- **User-текст** — plain `<text>` (совпадает с основной сессией).
- Роль помечена коротким дим-лейблом `btw` над markdown-блоком.

### Прерывание хода

Биндинг прерывания **зеркалит** клавишу `session.interrupt` из конфига пользователя (`config.data.keybinds.get("session.interrupt")`), а не хардкодит escape:
- повторно регистрируется с `cmd: abortTurn` и `fallthrough: true`;
- `fallthrough: true` гарантирует, что когда btw не в фокусе, клавиша проходит далее к `session.interrupt` основной сессии — две панели не глушат interrupt друг друга;
- `cmd` срабатывает только когда поле btw в фокусе;
- двухканальный обрыв: локальный `AbortSignal` рвёт SSE-стрим клиента немедленно, серверный `btw.abort` надёжен при half-open SSE.

### Изоляция панелей

Основная панель и btw **независимы в обоих направлениях**: открытие btw не влияет на маршрут, отображение и сохранение ответов основной сессии, и наоборот.

- **Заморозка снимка.** `SessionBtw.open` срезает контекст родителя по последний **завершённый** ход (`freezeSnapshot` в `packages/core/src/session/btw/snapshot.ts`): незавершённый ход — висящий вопрос без ответа или частичный ответ — в снимок не попадает. Иначе модель btw продолжает родительскую задачу, и её «ответ» печатается в btw-панели, теряясь для основной.
- **Инструкция side-chat.** В системный промпт btw добавлен явный запрет продолжать/возобновлять родительскую задачу (`SIDE_CHAT_INSTRUCTION`, теперь также запрещает tool-calls — btw не исполняет тулы, как и upstream-`session.generate`).
- **Владение кадрами.** Каждый кадр SSE-стрима btw несёт `btwID` (сервер проставляет во все `BtwPart`); панель отбрасывает кадры с чужим `btwID` — смешение разговоров невозможно даже при ошибке доставки. Требование поля схемой — компиляционная гарантия.
- **Стриминговый транспорт (V2).** После V2-мёрerdжа SSE идёт через transport нового клиента: `client.api.btw.send(...)` возвращает `AsyncIterable<Btw.Part>` — кадры обрабатываются по мере генерации, `AbortSignal` передаётся в запрос. Старый worker-rpc (`fetch.start/chunk/end`) не существует — его заменил нативный стриминг клиентского транспорта.
- **Гонка закрытия.** Если панель размонтировалась до ответа `btw.open`, полученный «поздний» `btwID` закрывается на сервере — беседа не остаётся висеть в памяти.

### Жизненный цикл

- **In-memory, без персистенции.** При открытии панель вызывает `client.api.btw.open({ parentID })` → сервер создаёт новый `btwID`. История живёт только в памяти.
- **Сброс при навигации.** Эффект в `app.tsx` (`createEffect(on(() => route.data.sessionID, () => btw.close()))`) закрывает btw при смене сессии. Эффект живёт в здоровом owner'е (App), а не в disposal-цикле Session — запись ancestor-сигнала в `onCleanup` дочернего owner'а рвёт реактивную очередь Solid.
- **Закрытие** (`<leader>p` или navigate) → `btw.close()` → `BtwPanel` unmount'ится → `onCleanup` вызывает `client.api.btw.close({ btwID })`.
- **Ошибка выбора модели.** Если родительская сессия не дала модель/агента — доменная ошибка `Btw.SelectionError` превращается хендлером в HTTP 400 (`InvalidRequestError`), панель показывает её как обычную ошибку хода.

## Расхождение с upstream

До V2-мёрerdжа btw была **полностью fork-фичей**. К синку 2026-10-20 upstream независимо добавил собственный btw: плагин `packages/tui/src/feature-plugins/prompt/btw.tsx` — **one-shot диалог** `session.aside` (slash `/btw`) поверх `session.generate`: вопрос уходит одним запросом, ответ показывается в модалке, без стриминга в постоянную панель.

Решение по синку: **форкская панель сохранена и портирована**, upstream-плагин оставлен palette-only.

| | Upstream `session.aside` | Форкская панель `session.btw` |
|---|---|---|
| UI | центрированный one-shot диалог | постоянная боковая панель 50/50 |
| Ответ | single-shot, `session.generate` без tool-цикла | стриминг хода (текст + reasoning), multi-turn в рамках открытой беседы |
| Основная сессия | заблокирована модалкой | полностью интерактивна |
| История | теряется при закрытии диалога | живёт, пока открыта панель (in-memory на сервере) |
| Slash `/btw` | убран (palette-only) | принадлежит панели |
| Транспорт | `session.generate` | `btw.open/send/close/abort` (SSE `Btw.Part`) |

Ограничение, общее с upstream: **btw не исполняет тулы** — инструкция side-chat запрещает tool-calls, кадр `tool` в схеме сохранён для совместимости с панелью.

### Конфликтная поверхность (upstream-owned файлы, которых касается фича)

| Файл | Изменение |
|---|---|
| `packages/tui/src/app.tsx` | + команды `session.btw` (cycle, slash `/btw`) и `session.btw.close`; `BtwProvider`; эффект закрытия btw при смене сессии. |
| `packages/tui/src/config/keybind.ts` | + `session.btw` (`<leader>b`), `session.btw.close` (`<leader>p`); `session.sidebar.toggle` → `<leader>v`. |
| `packages/tui/src/component/prompt/index.tsx` | + prop `yieldFocus` + ветка в автофокус-эффекте (после `input.focusable = true`). |
| `packages/tui/src/feature-plugins/prompt/btw.tsx` | убран `slash` у upstream-команды `session.aside` (анти-дубль `/btw`). |
| `packages/tui/src/routes/session/index.tsx` | + монтаж `<BtwPanel/>` (правая половина split), фокус-цикл. |
| `packages/protocol/src/api.ts`, `packages/protocol/src/client.ts` | + группа `server.btw` в composition API и codegen-имена. |
| `packages/server/src/handlers.ts` | + `BtwHandler` в `Layer.mergeAll`. |
| `packages/client/src/promise/generated/*`, `packages/client/src/effect/generated/*` | **regenerated** (`bun run generate` из `packages/client`) — группа `btw` c методами `open/send/close/abort`. |

### Fork-owned файлы

| Файл | Назначение |
|---|---|
| `packages/schema/src/btw.ts` | Схемы SSE-кадров `Btw.Part` (11 фреймов: `ready`, `user`, `text-delta`, `reasoning-delta`, `text-end`, `tool`, `assistant-end`, `turn-end`, `error`, `warning`, `closed`) + `Btw.End`; каждый кадр несёт `btwID`. |
| `packages/core/src/session/btw.ts` | `SessionBtw`: `open` (замороженный LLM-запрос: система + снимок истории родителя), `runSend` (многоходовый process-local транскрипт, гонка прерываний, дренаж очереди), `close`/`abort`/`dispose`, доменная ошибка `SelectionError`. |
| `packages/core/src/session/btw/snapshot.ts` | `freezeSnapshot` (срез по последний завершённый ход родителя) + `SIDE_CHAT_INSTRUCTION`. |
| `packages/protocol/src/groups/btw.ts` | HttpApi-группа `server.btw`: `POST /api/btw/open`, `GET /api/btw/send` (SSE `Btw.Part`), `POST /api/btw/close`, `POST /api/btw/abort`. |
| `packages/server/src/handlers/btw.ts` | `BtwHandler`: open резолвит родителя через location-миддлвари; send — неограниченная очередь + `HttpServerResponse.stream`; `SelectionError` → 400. |
| `packages/core/test/session-btw.test.ts`, `session-btw-snapshot.test.ts` | Инварианты дренажа/прерывания и тесты заморозки снимка. |
| `packages/tui/src/context/btw.tsx` | `BtwProvider`: `state()`/`open`/`close`, `ref()`/`setRef` для цикла фокуса. |
| `packages/tui/src/routes/session/panel-btw.tsx` | `BtwPanel`: стрим через `client.api.btw.*`, изоляция по `btwID`, рендер (markdown + подсветка, сворачиваемый thinking, индикатор хода), ref поля ввода. |

## Usage / Configuration

### Повседневное использование

1. На роуте сессии нажмите `<leader>b` (или введите `/btw`) — справа откроется панель, фокус перейдёт в поле ввода btw.
2. Введите side-вопрос, `Enter` — отправить. Поток стримится в панель, основной промпт остаётся рабочим.
3. `<leader>b` — переключить фокус между btw и основной.
4. Клик по `▸ thinking (…)` — развернуть/свернуть reasoning.
5. `<leader>p` — закрыть панель (или уйти на другую сессию — закроется автоматически).

### Переназначение клавиш

В `tui.jsonc` (секция `tui.keybinds`, dot-неймспейс после V2-мёрerdжа):

```jsonc
{
  "tui": {
    "keybinds": {
      "session.btw": "<leader>b",       // открыть / цикл фокуса
      "session.btw.close": "<leader>p", // закрыть панель
      "session.interrupt": "ctrl+x"     // ваш ремап interrupt автоматически применяется и к btw
    }
  }
}
```

Прерывание хода btw **не нужно настраивать отдельно** — оно зеркалирует `session.interrupt`. Любой ремап `session.interrupt` применяется к обеим панелям.

## Реализация

### Архитектура фокуса и состояния

```
BtwProvider (packages/tui/src/context/btw.tsx, обёрнут вокруг DialogProvider в app.tsx)
  ├─ state(): { parentID } | undefined   // открыта ли панель и для какой сессии
  ├─ open(parentID) / close()
  └─ ref() / setRef()                    // BtwRef поля ввода панели

app.tsx
  ├─ session.btw (cycle):  open | ref.focus() | promptRef.focus()   (slash /btw)
  ├─ session.btw.close:    btw.close()
  └─ createEffect(on(sessionID, () => btw.close()))   // сброс при навигации

routes/session/index.tsx
  └─ <BtwPanel parentID …/> в правой половине split'а

component/prompt/index.tsx
  └─ createEffect: input.focusable = true; if (yieldFocus) return
```

### Поток данных (стрим ответа)

```
client.api.btw.open({ parentID }) → { btwID }
client.api.btw.send({ btwID, text }, { signal })   // GET /api/btw/send, SSE
  → for await (part of stream)                     // AsyncIterable<Btw.Part>
      → if (part.btwID !== id) continue            // изоляция: чужие кадры отбрасываются
      → handlePart(part)
          reasoning-delta → reasoning += delta
          text-delta      → text += delta
          tool            → индикатор tool-события
          turn-end|error|closed → break
finally → setBusy(false), cleanup timers
client.api.btw.close({ btwID }) / client.api.btw.abort({ btwID })
```

Подводный камень TDZ eager-memo из прежней реализации (порядок `btw` выше memos, ссылающихся на него) остаётся актуальным: `createMemo` в Solid выполняется eagerly, и обращение к `useBtw()` до объявления крашит перемонтирование Session.

## Open questions / future work

- **Ширина как опция.** Сейчас жёстко 50/50. Можно вынести в настройку (фиксированная ширина / пропорция).
- **Персистенция side-chat.** In-memory — история теряется при перезапуске сервера и при закрытии панели.
- **Независимый interrupt для btw.** Сейчас abort btw доступен только из поля btw (фокус-гейт).
- **Tool-кадры.** Схема сохраняет фрейм `tool`, но btw не исполняет тулы; если появится потребность — это отдельный дизайн (upstream `session.generate` имеет то же ограничение).
- **Сведение с upstream-плагином.** Следить за эволюцией upstream-`session.aside`: если upstream доведёт one-shot до полноценного чата, переоценить дублирование поверхностей.
