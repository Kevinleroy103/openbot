// Phone sheets and the browser history: while a full-screen sheet (details, settings, search, the
// computer view, forms, action sheets) is open on a phone, it owns a history entry, so the browser
// Back button and the iOS edge swipe close the sheet instead of leaving the chat. Closing the sheet
// in the UI pops that entry again. Sheets nest (Settings › a page › an editor): each entry knows its
// depth, and a sheet closes only when Back goes below its own entry. Tablet and desktop are unaffected.
import { useEffect, useRef } from "react"
import { useIsPhone } from "./layout.ts"
import { historyMark } from "./uiState.ts"

/** How many sheet entries the current history entry sits on (0: none). */
const sheetDepth = (): number => {
  const mark = historyMark()
  return mark?.ob === "sheet" ? (mark.depth ?? 1) : 0
}

export function useBackDismiss(open: boolean, onClose: () => void, key: string): void {
  const phone = useIsPhone()
  const close = useRef(onClose)
  close.current = onClose
  // A pending "pop our entry" from the previous cleanup. React StrictMode re-runs effects at once in
  // development: the re-run cancels it and keeps the entry instead of pushing a second one.
  const pendingPop = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const depth = useRef(0)
  useEffect(() => {
    if (!open || !phone || typeof history === "undefined") return
    if (pendingPop.current !== undefined) {
      clearTimeout(pendingPop.current)
      pendingPop.current = undefined
    } else {
      depth.current = sheetDepth() + 1
      history.pushState({ ob: "sheet", sheet: key, depth: depth.current }, "", location.href)
    }
    let popped = false
    const onPop = () => {
      // still on our entry or a nested sheet's (one closed above us): stay open
      if (sheetDepth() >= depth.current) return
      popped = true
      close.current()
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      if (popped) return
      pendingPop.current = setTimeout(() => {
        pendingPop.current = undefined
        // Still on our entry (closed from the UI): pop it. A nested sheet's entry on top (both closed at
        // once, e.g. Settings › page): pop ours once that one is gone. A navigation replaced it: leave it.
        const tryPop = (attempt: number) => {
          const mark = historyMark()
          if (mark?.ob !== "sheet") return
          if (mark.sheet === key) history.back()
          else if (attempt < 3) window.addEventListener("popstate", () => tryPop(attempt + 1), { once: true })
        }
        tryPop(0)
      }, 0)
    }
  }, [open, phone, key])
}
