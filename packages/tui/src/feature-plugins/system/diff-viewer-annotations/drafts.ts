import { createRoot } from "solid-js"
import { createAnnotationStore, type AnnotationStore } from "./store"

// Владелец безсессионного viewer (FR-C1/C4).
export const SESSIONLESS_OWNER = "__sessionless"

// Запись реестра черновиков: стор + состояние выстрела отправки (FR-5, план §9).
// sendInitiated/sentMessage переживают закрытие viewer: догоняющая классификация
// при переоткрытии читает их из реестра.
export type DraftRecord = {
  readonly store: AnnotationStore
  sendInitiated: boolean
  sentMessage: string | undefined
  lastError: string | undefined
}

// Module-scope реестр черновиков по владельцу (§3.4 плана): стор создаётся под
// независимым createRoot, поэтому сигналы не диспозятся при размонтировании viewer.
// Переживает закрытие/переоткрытие viewer и /reload (модульный кэш процесса жив);
// умирает только со смертью процесса, «Отбросить» и подтверждением принятия (FR-C3).
const drafts = new Map<string, DraftRecord>()

export function getOrCreateDraft(ownerKey: string): AnnotationStore {
  return getOrCreateDraftRecord(ownerKey).store
}

export function getOrCreateDraftRecord(ownerKey: string): DraftRecord {
  const existing = drafts.get(ownerKey)
  if (existing) return existing
  const record: DraftRecord = {
    store: createRoot(() => createAnnotationStore()),
    sendInitiated: false,
    sentMessage: undefined,
    lastError: undefined,
  }
  drafts.set(ownerKey, record)
  return record
}

// Фиксация выстрела отправки в момент fire-and-forget вызова session.prompt.
export function markDraftSendInitiated(ownerKey: string, message: string, error: string | undefined) {
  const record = getOrCreateDraftRecord(ownerKey)
  record.sendInitiated = true
  record.sentMessage = message
  record.lastError = error
}

// Догоняющая классификация при переоткрытии выполняется однократно.
export function clearDraftSendInitiated(ownerKey: string) {
  const record = drafts.get(ownerKey)
  if (!record) return
  record.sendInitiated = false
}

// Терминальная очистка: «Отбросить» или подтверждение принятия отправки (FR-C3).
export function disposeDraft(ownerKey: string) {
  drafts.delete(ownerKey)
}

export function draftExists(ownerKey: string): boolean {
  return drafts.has(ownerKey)
}

// Только для тестов: изоляция между сценариями.
export function resetDrafts() {
  drafts.clear()
}
