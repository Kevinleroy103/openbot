// Connection supervisor surface for the UI (architecture §4.10): `connectionAtom` plus a manual retry.
// Reading `connectionAtom` keeps the RPC runtime (and its socket) alive. In a browser it also retries
// right away when the OS reports the network is back or the tab becomes visible again while offline.
import { Atom } from "effect/reactivity"
import { type ConnectionState, connectionStateAtom, reconnectSignalAtom } from "./connection.ts"
import { OpenBotClient } from "./rpc.ts"

/** Rebuilds the socket now (new protocol, attempt counter reset). Write `undefined` to trigger. */
export const reconnectAtom: Atom.Writable<void, void> = Atom.writable(
  () => undefined,
  (ctx) => {
    const state = ctx.get(connectionStateAtom)
    if (state.status !== "online") ctx.set(connectionStateAtom, { ...state, status: "connecting", attempt: 0, nextRetryAt: undefined })
    ctx.set(reconnectSignalAtom, ctx.get(reconnectSignalAtom) + 1)
  },
)

interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** Browser wake-ups (online / visible) → immediate reconnect while offline. No-op outside a browser. */
const browserWakeAtom = Atom.make((get) => {
  const win = globalThis as unknown as Partial<EventTargetLike> & { document?: Partial<EventTargetLike> & { visibilityState?: string } }
  if (typeof win.addEventListener !== "function" || typeof win.removeEventListener !== "function") return
  const registry = get.registry
  const wake = () => {
    if (win.document?.visibilityState === "hidden") return
    if (registry.get(connectionStateAtom).status === "offline") registry.set(reconnectAtom, undefined)
  }
  win.addEventListener("online", wake)
  win.document?.addEventListener?.("visibilitychange", wake)
  get.addFinalizer(() => {
    win.removeEventListener?.("online", wake)
    win.document?.removeEventListener?.("visibilitychange", wake)
  })
})

/** `connecting | online | offline` with attempt count, next retry time and a generation counter. */
export const connectionAtom: Atom.Atom<ConnectionState> = Atom.make((get) => {
  get.mount(OpenBotClient.runtime)
  get.mount(browserWakeAtom)
  return get(connectionStateAtom)
}).pipe(Atom.withLabel("openbot/connection"))
