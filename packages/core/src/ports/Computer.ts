/**
 * `ComputerPort` (architecture §3.5, §4.8): the bot's live browser/computer on its host node.
 * Implemented by brain-nodes (`ComputerService`); a fake lives in `@openbot/core/testing`.
 */
import type { BotId, ComputerStatus, Conflict, NodeUnavailable, NotFound } from "@openbot/contracts"
import { Context, Effect } from "effect"

export class ComputerPort extends Context.Service<ComputerPort, {
  /** `computer.status`. */
  readonly status: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound>
  /** `computer.ensure`: starts the bot's browser window on its host node (`browser.ensure`). */
  readonly ensure: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable>
  /** `computer.lease {take}`: the user takes (`true`) or releases (`false`) control. */
  readonly lease: (botId: BotId, take: boolean) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable | Conflict>
}>()("openbot/core/ComputerPort") {}
