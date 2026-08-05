export * as ConfigMergeV1 from "./merge"

import { Schema } from "effect"

// Директива композиции слоёв (global + project) при совпадении имён команд/агентов/скиллов.
// Потребляется загрузчиком на этапе склейки; в итоговом определение не влияет на рантайм.
// append  — тело локали после тела глобали (по умолчанию)
// prepend — тело локали до тела глобали
// replace — только тело локали (старое поведение, opt-out)
export const Strategy = Schema.Literals(["append", "prepend", "replace"])
export type Strategy = Schema.Schema.Type<typeof Strategy>

export const DEFAULT: Strategy = "append"
