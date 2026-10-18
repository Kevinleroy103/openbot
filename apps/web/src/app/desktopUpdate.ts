// The desktop app's own updates (apps/desktop/src/update.ts), as the web app sees them through the
// preload bridge: the state now and every change, a check on demand, and "Restart to update".
// Copies of the app from before updates existed have none of this (`supported` is false).
import { useEffect, useState } from "react"
import { desktopApp } from "./notifications.ts"

export type DesktopUpdateState =
  | { readonly status: "idle" | "checking" | "up-to-date" }
  | { readonly status: "downloading" | "ready" | "manual"; readonly build: string }
  | { readonly status: "error"; readonly message: string }

export interface DesktopUpdates {
  readonly supported: boolean
  readonly state: DesktopUpdateState | undefined
  readonly check: () => Promise<DesktopUpdateState | undefined>
  readonly install: () => void
}

export function useDesktopUpdate(): DesktopUpdates {
  const bridge = desktopApp()
  const [state, setState] = useState<DesktopUpdateState | undefined>()
  useEffect(() => {
    if (bridge?.onUpdate === undefined || bridge.updateState === undefined) return
    let alive = true
    void bridge.updateState().then((s) => {
      if (alive) setState(s as DesktopUpdateState)
    })
    const off = bridge.onUpdate((s) => setState(s as DesktopUpdateState))
    return () => {
      alive = false
      off()
    }
  }, [bridge])
  return {
    supported: bridge?.onUpdate !== undefined,
    state,
    check: async () => (bridge?.checkForUpdates === undefined ? undefined : ((await bridge.checkForUpdates()) as DesktopUpdateState)),
    install: () => bridge?.installUpdate?.(),
  }
}

/** A new version is downloaded (or, where the app cannot replace itself, ready to download). */
export const updateReady = (state: DesktopUpdateState | undefined): boolean => state?.status === "ready" || state?.status === "manual"
