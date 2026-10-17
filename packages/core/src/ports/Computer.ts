/**
 * `ComputerPort` (architecture §3.5, §4.8; D1.7): the bot's screen on its host node, either a whole
 * desktop (`desktop@1`: a display per bot, noVNC view) or, on nodes without desktops, its browser
 * window (`browser@1`: CDP screencast). Implemented by brain-nodes (`ComputerService`); a fake lives
 * in `@openbot/core/testing`.
 */
import type { BotId, ComputerStatus, Conflict, NodeUnavailable, NotFound } from "@openbot/contracts"
import { Context, Effect, Stream } from "effect"

/** Who controls a bot's screen changed (`computer.lease`, `computer.reset`). */
export interface ComputerLeaseChange {
  readonly botId: BotId
  readonly holder: "bot" | "user"
  /**
   * `lease`: the owner took control or handed it back (`computer.lease`, "I'm done");
   * `reset`: the bot's desktop was stopped, and the owner's control ended with it.
   */
  readonly cause: "lease" | "reset"
}

export class ComputerPort extends Context.Service<ComputerPort, {
  /** `computer.status`. */
  readonly status: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound>
  /**
   * `computer.ensure`: starts the bot's screen on its host node (`desktop.ensure` on a `desktop@1`
   * node, else `browser.ensure`).
   */
  readonly ensure: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable>
  /** `computer.lease {take}`: the user takes (`true`) or releases (`false`) control. */
  readonly lease: (botId: BotId, take: boolean) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable | Conflict>
  /**
   * `computer.reset`: stops the bot's desktop and everything on it (`desktop.stop`) and ends the
   * owner's control; the next use starts a fresh one. Nothing to reset on a browser-only node.
   */
  readonly reset: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable>
  /** Every change of who holds a bot's control lease (hot, no replay). */
  readonly leaseChanges: Stream.Stream<ComputerLeaseChange>
}>()("openbot/core/ComputerPort") {}
