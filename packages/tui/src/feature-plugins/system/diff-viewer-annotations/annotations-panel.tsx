/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useBindings } from "../../../keymap"
import type { Annotation, AnnotationStore } from "./store"
import { displayPathLabels, numberColumnWidth, pathBasename } from "./display-paths"

// Панель аннотаций — оверлей viewer, мета-уровень над черновиком (FR-N6): правка текста
// записи, удаление записи, переход к строке. Создания аннотаций из панели нет. Unbound —
// заполнитель «—» в колонке номера, входят в счётчики. Начальный фокус детерминирован:
// первая запись. active=false гасит keymap-слой: пока панель не верхний оверлей (открыт
// редактор/подтверждение), клавиши не перехватываются и не мешают нижележащей поверхности.
export function AnnotationsPanel(props: {
  api: TuiPluginApi
  store: AnnotationStore
  // Все файлы текущего диффа — коллизионный набор basename считается по ним,
  // не только по аннотированным.
  files: () => readonly { readonly file: string }[]
  active: () => boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onJump: (annotation: Annotation) => void
  onClose: () => void
}) {
  const theme = () => props.api.theme.current

  // Плоский список записей в «географическом» порядке (файл → строка).
  const flat = createMemo(() =>
    props.store
      .visibleAnnotations()
      .slice()
      .sort(
        (a, b) =>
          a.anchor.filePath.localeCompare(b.anchor.filePath) ||
          a.anchor.line - b.anchor.line ||
          a.anchor.side.localeCompare(b.anchor.side),
      ),
  )
  const [selected, setSelected] = createSignal(0)

  // Кламп выбора при изменении набора записей.
  createEffect(() => {
    const length = flat().length
    setSelected((current) => Math.min(current, Math.max(0, length - 1)))
  })

  function move(offset: number) {
    const max = flat().length
    if (max === 0) return
    setSelected((current) => (current + offset + max) % max)
  }

  function current(): Annotation | undefined {
    return flat()[selected()]
  }

  useBindings(() => ({
    enabled: props.active(),
    commands: [
      { name: "diff.annotate.panel.next", run: () => move(1) },
      { name: "diff.annotate.panel.previous", run: () => move(-1) },
      {
        name: "diff.annotate.panel.edit",
        run: () => {
          const ann = current()
          if (ann) props.onEdit(ann.id)
        },
      },
      {
        name: "diff.annotate.panel.delete",
        run() {
          const ann = current()
          if (ann) props.onDelete(ann.id)
        },
      },
      {
        // Панель — модальный оверлей: ctrl+d не должен проваливаться в app_exit.
        name: "diff.annotate.panel.noop",
        run() {},
      },
      {
        name: "diff.annotate.panel.jump",
        run: () => {
          const ann = current()
          if (ann) props.onJump(ann)
        },
      },
      { name: "diff.annotate.panel.close", run: () => props.onClose() },
    ],
    bindings: [
      { key: "j,down", cmd: "diff.annotate.panel.next", desc: "Следующее замечание" },
      { key: "k,up", cmd: "diff.annotate.panel.previous", desc: "Предыдущее замечание" },
      { key: "return", cmd: "diff.annotate.panel.jump", desc: "Перейти к строке" },
      { key: "e", cmd: "diff.annotate.panel.edit", desc: "Править" },
      { key: "d", cmd: "diff.annotate.panel.delete", desc: "Удалить" },
      { key: "ctrl+d", cmd: "diff.annotate.panel.noop" },
      { key: "a,escape", cmd: "diff.annotate.panel.close", desc: "Закрыть панель" },
    ],
  }))

  // Label-map по составу файлов диффа: единый проход, пересчёт только при
  // изменении набора — «мигания» префиксов коллизий нет. Файл вне диффа
  // (unbound) получает basename без участия в коллизионном наборе.
  const displayLabels = createMemo(() => displayPathLabels(props.files().map((file) => file.file)))
  const labelFor = (filePath: string) => displayLabels().get(filePath) ?? pathBasename(filePath)

  // Ширина колонки номеров — одна на все строки: по максимальному номеру,
  // clamp на узких терминалах; правое выравнивание стабильно.
  const numberWidth = createMemo(() =>
    numberColumnWidth(flat().map((ann) => (ann.state === "unbound" ? undefined : ann.anchor.line))),
  )

  const groups = createMemo(() => {
    const map = new Map<string, Annotation[]>()
    for (const ann of flat()) {
      const list = map.get(ann.anchor.filePath) ?? []
      list.push(ann)
      map.set(ann.anchor.filePath, list)
    }
    return [...map.entries()]
  })

  return (
    <box
      position="absolute"
      zIndex={2550}
      right={0}
      top={1}
      bottom={1}
      width="40%"
      border
      backgroundColor={theme().backgroundPanel}
      borderColor={theme().borderActive}
      flexDirection="column"
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme().text} attributes={TextAttributes.BOLD} wrapMode="none">
          Замечания ({flat().length})
        </text>
      </box>
      <Show when={flat().length === 0}>
        {/* Голый text после вложенного row-box в column-flex рендерится с y=0 и
            перекрывает заголовок (интерлив символов); строку обязательно держим
            в собственном row-box. wrapMode="none" — усечение вместо переноса. */}
        <box flexDirection="row">
          <text fg={theme().textMuted} wrapMode="none">
            Пусто — нажмите Enter на строке патча.
          </text>
        </box>
      </Show>
      <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: true }}>
        <For each={groups()}>
          {(group) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme().secondary} attributes={TextAttributes.BOLD} wrapMode="none">
                {labelFor(group[0])}
              </text>
              <For each={group[1]}>
                {(ann) => {
                  const index = () => flat().findIndex((a) => a.id === ann.id)
                  const isSelected = () => index() === selected() && index() !== -1
                  return (
                    <box flexDirection="row" gap={1} backgroundColor={isSelected() ? theme().backgroundMenu : undefined}>
                      <text fg={ann.state === "unbound" ? theme().warning : theme().accent} width={1}>
                        {ann.state === "unbound" ? "?" : "●"}
                      </text>
                      <text
                        fg={theme().textMuted}
                        width={numberWidth()}
                        justifyContent="flex-end"
                        wrapMode="none"
                        flexShrink={0}
                      >
                        {ann.state === "unbound" ? "—" : ann.anchor.line}
                      </text>
                      <text fg={theme().text} wrapMode="none" flexGrow={1}>
                        {ann.text.split("\n")[0]}
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().textMuted} wrapMode="none">
          j/k · enter — к строке · e — правка · d — удалить · a — закрыть
        </text>
      </box>
    </box>
  )
}
