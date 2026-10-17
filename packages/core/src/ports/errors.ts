/**
 * Port-level error types (architecture §3).
 *
 * - `RepoError`: every repository/store failure. It is "defect-like": services convert it to a
 *   defect (`Effect.orDie`) and the RPC edge maps defects to the contract `Internal` error.
 * - `HarnessError`: driver/session failures raised by harness adapters.
 * - `PlacementError`: placement could not be resolved for a bot (offline node, missing capability).
 *
 * Errors that cross the RPC boundary (`NotFound`, `InvalidInput`, `Conflict`, `HarnessUnavailable`,
 * `RequestNotPending`, `NodeUnavailable`, ...) live in `@openbot/contracts` and are re-used by ports.
 */
import { Schema } from "effect"

export class RepoError extends Schema.TaggedError<RepoError>()("RepoError", {
  /** Repository + operation, e.g. "EntryRepo.upsert". */
  op: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const HarnessErrorCode = Schema.Literals([
  /** The capability is not offered by this driver (e.g. `steer` when `capabilities.steer` is false). */
  "unsupported",
  /** Binary/SDK missing or wrong version. */
  "not-installed",
  /** Not signed in / credentials rejected. */
  "auth",
  /** Opening or resuming the native session failed. */
  "open-failed",
  /** The native session/process is gone. */
  "closed",
  /** Starting/steering a turn was rejected. */
  "turn-rejected",
  /** Unexpected native protocol data. */
  "protocol",
  /** Rate/usage limit. */
  "usage-limit",
  "other",
])
export type HarnessErrorCode = typeof HarnessErrorCode.Type

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  /** Harness kind (open string so unknown/fake kinds are representable). */
  harness: Schema.String,
  code: HarnessErrorCode,
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

export const PlacementErrorReason = Schema.Literals([
  /** The host node is unknown, revoked or offline. */
  "node-unavailable",
  /** The host node lacks a capability the chosen mode needs. */
  "missing-capability",
  /** The driver implements no placement for a remote host. */
  "unsupported-placement",
  /** Setting up relays/tunnels failed. */
  "setup-failed",
])
export type PlacementErrorReason = typeof PlacementErrorReason.Type

export class PlacementError extends Schema.TaggedError<PlacementError>()("PlacementError", {
  botId: Schema.String,
  nodeId: Schema.optional(Schema.String),
  reason: PlacementErrorReason,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
