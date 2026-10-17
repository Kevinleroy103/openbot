// One control lease per bot, shared by the bot's browser (BrowserManager) and its desktop
// (DesktopManager). The brain owns the lease and mirrors it with `lease.set`; the node only gates:
//   holder "user": the owner is in control. Bot input (browser.action, computer.act) is refused
//                  with LeaseHeld; the owner's input (browser.input, a vnc-control stream) is allowed.
//   holder "bot" (the default): the reverse. Control streams still open are closed.
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { LeaseHolder, LeaseState } from "@openbot/node-protocol"

export interface LeaseBookShape {
  /** The bot's lease; `{holder: "bot", since: 0}` until the brain sets one. */
  readonly get: (botId: string) => LeaseState
  /** Set the holder (keeps `since` when the holder does not change) and tell the listeners. */
  readonly set: (botId: string, holder: LeaseHolder) => LeaseState
  /** Called after every `set`, with the new state. Returns an unsubscribe function. */
  readonly subscribe: (listener: (state: LeaseState) => void) => () => void
}

export class LeaseBook extends Context.Service<LeaseBook, LeaseBookShape>()("openbot/node-daemon/LeaseBook") {}

export const makeLeaseBook = (now: () => number = Date.now): LeaseBookShape => {
  const leases = new Map<string, LeaseState>()
  const listeners = new Set<(state: LeaseState) => void>()
  const get = (botId: string): LeaseState => leases.get(botId) ?? { botId, holder: "bot", since: 0 }
  return {
    get,
    set: (botId, holder) => {
      const prev = get(botId)
      const next: LeaseState = prev.holder === holder && prev.since > 0 ? prev : { botId, holder, since: now() }
      leases.set(botId, next)
      for (const l of [...listeners]) {
        try {
          l(next)
        } catch {
          // a listener's failure never blocks the lease
        }
      }
      return next
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export const LeaseBookLive: Layer.Layer<LeaseBook> = Layer.sync(LeaseBook)(() => makeLeaseBook())
