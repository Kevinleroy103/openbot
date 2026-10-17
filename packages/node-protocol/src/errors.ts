// Typed errors of the OpenBot node protocol. All of them travel over the wire (JSON-RPC
// `error.data[0].error`), so every field is plain JSON. Ported from the hands-e2e spike
// (vendor/scratch/hands-e2e/contract.ts) and extended per docs/architecture.md §4.2.
import * as Schema from "effect/Schema"

/** A path resolved outside the node's roots, hit the deny-list, or a read-only root was written. */
export class PathDenied extends Schema.TaggedError<PathDenied>()("PathDenied", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** The node's own policy (ceiling never/ask/always) refused the action. `retry: false` = "do not retry". */
export class PolicyRefused extends Schema.TaggedError<PolicyRefused>()("PolicyRefused", {
  action: Schema.String,
  reason: Schema.String,
  retry: Schema.Boolean,
}) {}

/** `fs.edit` found no unique match, or `fs.write`/`fs.edit` saw a different `expectedSha256`. */
export class EditFailed extends Schema.TaggedError<EditFailed>()("EditFailed", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** A filesystem operation failed for a reason other than policy (ENOENT, EISDIR, ENOTEMPTY, ...). */
export class FsError extends Schema.TaggedError<FsError>()("FsError", {
  op: Schema.String,
  path: Schema.String,
  code: Schema.String,
  reason: Schema.String,
}) {}

/** A pty, tunnel, service or forward could not be started or connected. */
export class TunnelFailed extends Schema.TaggedError<TunnelFailed>()("TunnelFailed", {
  kind: Schema.String,
  reason: Schema.String,
}) {}

/** The brain refused a node-initiated stream (`node.openStream`). */
export class StreamRefused extends Schema.TaggedError<StreamRefused>()("StreamRefused", {
  kind: Schema.String,
  reason: Schema.String,
}) {}

/** The connection is not (yet) mutually authenticated: the node gates every RPC until `node.hello` verifies. */
export class NotAuthenticated extends Schema.TaggedError<NotAuthenticated>()("NotAuthenticated", {
  reason: Schema.String,
}) {}

/** Brain-side: the node is offline, unknown or revoked. */
export class NodeUnavailable extends Schema.TaggedError<NodeUnavailable>()("NodeUnavailable", {
  nodeId: Schema.String,
  reason: Schema.String,
}) {}

/** The node has no usable browser (no Chromium found, launch failed, target gone). */
export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()("BrowserUnavailable", {
  reason: Schema.String,
}) {}

/** The control lease for the bot's browser is held by someone else (e.g. the user took control). */
export class LeaseHeld extends Schema.TaggedError<LeaseHeld>()("LeaseHeld", {
  botId: Schema.String,
  holder: Schema.Literals(["user", "bot"]),
  reason: Schema.String,
}) {}

/** A browser action failed (bad ref, navigation error, CDP error). */
export class BrowserActionFailed extends Schema.TaggedError<BrowserActionFailed>()("BrowserActionFailed", {
  action: Schema.String,
  reason: Schema.String,
}) {}

/** Signed-upgrade verification failed (brain side, before the WebSocket upgrade). Not a wire error. */
export class UpgradeAuthError extends Schema.TaggedError<UpgradeAuthError>()("UpgradeAuthError", {
  reason: Schema.Literals(["malformed", "unknown-node", "skew", "replay", "bad-signature"]),
  message: Schema.String,
}) {}

/** WebCrypto failed (bad key encoding, unsupported algorithm). Not a wire error. */
export class CryptoError extends Schema.TaggedError<CryptoError>()("CryptoError", {
  op: Schema.String,
  message: Schema.String,
}) {}

/** Model-readable rendering, used by the gateway to build `ERROR: ...` tool results. */
export const describeNodeError = (
  error:
    | PathDenied
    | PolicyRefused
    | EditFailed
    | FsError
    | TunnelFailed
    | StreamRefused
    | NotAuthenticated
    | NodeUnavailable
    | BrowserUnavailable
    | LeaseHeld
    | BrowserActionFailed,
): string => {
  switch (error._tag) {
    case "PathDenied":
      return `Access to ${error.path} is denied: ${error.reason}`
    case "PolicyRefused":
      return `The node refused ${error.action}: ${error.reason}${error.retry ? "" : " Do not retry."}`
    case "EditFailed":
      return `Edit of ${error.path} failed: ${error.reason}`
    case "FsError":
      return `${error.op} ${error.path} failed (${error.code}): ${error.reason}`
    case "TunnelFailed":
      return `Could not open ${error.kind}: ${error.reason}`
    case "StreamRefused":
      return `Stream ${error.kind} refused: ${error.reason}`
    case "NotAuthenticated":
      return `Node connection is not authenticated: ${error.reason}`
    case "NodeUnavailable":
      return `Node ${error.nodeId} is unavailable: ${error.reason}`
    case "BrowserUnavailable":
      return `The browser is unavailable: ${error.reason}`
    case "LeaseHeld":
      return error.holder === "user" ? "The user is controlling the browser" : `The browser is controlled by the bot: ${error.reason}`
    case "BrowserActionFailed":
      return `Browser ${error.action} failed: ${error.reason}`
  }
}
