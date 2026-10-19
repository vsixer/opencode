import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client"
import type { ResolvedTheme } from "@opencode/theme/tui"

// Узкий срез Plugin.Context, необходимый движку аннотаций и его оверлеям.
// Структурный тип: diff-viewer передаёт контекст плагина напрямую.
export type DiffAnnotationsApi = {
  readonly theme: ResolvedTheme
  readonly data: {
    readonly session: {
      get(sessionID: string): { readonly id: string } | undefined
      readonly message: { readonly list: (sessionID: string) => readonly SessionMessageInfo[] | undefined }
    }
  }
  readonly ui: {
    readonly toast: {
      readonly show: (options: {
        variant?: "info" | "success" | "warning" | "error"
        title?: string
        message: string
      }) => void
    }
  }
  readonly client: OpenCodeClient
}
