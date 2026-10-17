// Wire schemas of the OpenBot node protocol (payloads and results of NodeRpcs / BrainRpcs).
// Rules: plain JSON only, no tuples (other-language nodes, MCP schema hygiene), optional fields use
// `Schema.optional` (absent on the wire when undefined).
import * as Schema from "effect/Schema"

// ---------------------------------------------------------------- shared
/** Who/why on every bot-originated side-effecting call, for node-side policy, idempotency and audit. */
export const Invocation = Schema.Struct({
  invocationId: Schema.String,
  botId: Schema.String,
  runId: Schema.String,
  /** Harness tool-call id when the call comes from a model tool call. */
  toolCallId: Schema.optional(Schema.String),
})
export type Invocation = typeof Invocation.Type

export const RootMode = Schema.Literals(["rw", "ro"])
export type RootMode = typeof RootMode.Type

export const NodeRoot = Schema.Struct({ id: Schema.String, path: Schema.String, mode: RootMode })
export type NodeRoot = typeof NodeRoot.Type

export const PolicyCeiling = Schema.Literals(["never", "ask", "always"])
export type PolicyCeiling = typeof PolicyCeiling.Type

export const ProtocolRange = Schema.Struct({ min: Schema.Number, max: Schema.Number })
export type ProtocolRange = typeof ProtocolRange.Type

// ---------------------------------------------------------------- node.hello
export const NodeHelloRequest = Schema.Struct({
  protocol: ProtocolRange,
  brainVersion: Schema.String,
  /** base64url Ed25519 signature by the brain over `helloMessage(nodeId, upgradeNonce, brainOrigin)`. */
  brainSig: Schema.String,
})
export type NodeHelloRequest = typeof NodeHelloRequest.Type

export const NodeHello = Schema.Struct({
  nodeId: Schema.String,
  /** node software version */
  version: Schema.String,
  hostname: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  /** chosen protocol version */
  protocol: Schema.Number,
  roots: Schema.Array(NodeRoot),
  /** versioned capability names, e.g. `fs@1`, `browser@1` */
  capabilities: Schema.Array(Schema.String),
  /** tunnel kinds this node can open */
  tunnels: Schema.Array(Schema.String),
  policy: Schema.Struct({ ceiling: PolicyCeiling, remoteManaged: Schema.Boolean }),
  /** the node verified the brain signature with its pinned brain key */
  brainVerified: Schema.Boolean,
})
export type NodeHello = typeof NodeHello.Type

// ---------------------------------------------------------------- fs
export const FileType = Schema.Literals(["file", "dir", "symlink", "other"])
export type FileType = typeof FileType.Type

export const TextEncoding = Schema.Literals(["utf8", "base64"])
export type TextEncoding = typeof TextEncoding.Type

export const FileStat = Schema.Struct({
  path: Schema.String,
  type: FileType,
  size: Schema.Number,
  mtimeMs: Schema.Number,
  mode: Schema.Number,
})
export type FileStat = typeof FileStat.Type

export const FsReadResult = Schema.Struct({
  content: Schema.String,
  encoding: TextEncoding,
  /** sha256 (hex) of the whole file, for `expectedSha256` on a later write/edit */
  sha256: Schema.String,
  /** size of the whole file in bytes */
  size: Schema.Number,
  /** true when offset/limit (or the node's cap) cut the content */
  truncated: Schema.Boolean,
})
export type FsReadResult = typeof FsReadResult.Type

export const FsWriteResult = Schema.Struct({ sha256: Schema.String, size: Schema.Number })
export type FsWriteResult = typeof FsWriteResult.Type

export const FsEditResult = Schema.Struct({ sha256: Schema.String, replacements: Schema.Number })
export type FsEditResult = typeof FsEditResult.Type

/**
 * `fs.download`: answered once the node checked the file and dialed the `transfer` data stream; the
 * bytes follow on that stream (streams.ts, `transfer` framing). `size` is the size when opened; the
 * stream's final `done` frame carries the size and sha256 of what was actually sent.
 */
export const FsDownloadResult = Schema.Struct({
  /** canonical (realpath'd) absolute path on the node */
  path: Schema.String,
  /** file name (last path segment) */
  name: Schema.String,
  size: Schema.Number,
  mtimeMs: Schema.Number,
  /** the first bytes of the file (≤ 4 KiB, base64), for type sniffing before the transfer */
  head: Schema.String,
})
export type FsDownloadResult = typeof FsDownloadResult.Type

/** `fs.upload`: answered once the whole file arrived, matched the sender's sha256 and was renamed into place. */
export const FsUploadResult = Schema.Struct({
  /** canonical (realpath'd) absolute path on the node */
  path: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
})
export type FsUploadResult = typeof FsUploadResult.Type

export const DirEntry = Schema.Struct({
  /** path relative to the listed directory, `/`-separated */
  path: Schema.String,
  type: FileType,
  size: Schema.Number,
  mtimeMs: Schema.Number,
})
export type DirEntry = typeof DirEntry.Type

export const FsListResult = Schema.Struct({ entries: Schema.Array(DirEntry), truncated: Schema.Boolean })
export type FsListResult = typeof FsListResult.Type

export const FsGlobResult = Schema.Struct({ paths: Schema.Array(Schema.String), truncated: Schema.Boolean })
export type FsGlobResult = typeof FsGlobResult.Type

export const GrepMatch = Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String })
export type GrepMatch = typeof GrepMatch.Type

export const GrepOutputMode = Schema.Literals(["content", "files_with_matches", "count"])
export type GrepOutputMode = typeof GrepOutputMode.Type

export const FsGrepResult = Schema.Struct({
  /** `content` mode: matching lines (with context lines when requested) */
  matches: Schema.Array(GrepMatch),
  /** every file with at least one match */
  files: Schema.Array(Schema.String),
  /** `count` mode: per-file match counts */
  counts: Schema.Array(Schema.Struct({ path: Schema.String, count: Schema.Number })),
  truncated: Schema.Boolean,
})
export type FsGrepResult = typeof FsGrepResult.Type

// ---------------------------------------------------------------- shell
export const OutputStream = Schema.Literals(["stdout", "stderr"])
export type OutputStream = typeof OutputStream.Type

export const ExecStarted = Schema.TaggedStruct("Started", { pid: Schema.Number, pgid: Schema.Number })
export const ExecOutput = Schema.TaggedStruct("Output", { stream: OutputStream, data: Schema.String, seq: Schema.Number })
export const ExecExit = Schema.TaggedStruct("Exit", {
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Number,
  /** streamed output was capped; the full output is in `spillPath` on the node (when set) */
  outputTruncated: Schema.optional(Schema.Boolean),
  spillPath: Schema.optional(Schema.String),
})
export const ExecEvent = Schema.Union([ExecStarted, ExecOutput, ExecExit])
export type ExecEvent = typeof ExecEvent.Type

// ---------------------------------------------------------------- stream kinds
/** Byte streams the BRAIN asks the node to open via `tunnel.open` (the node dials `/node/stream/:id`). */
export const TunnelKind = Schema.Literals([
  "claude.cli", // the node's pinned Claude Code CLI with the SDK's argv. binary stdio + JSON control frames
  "codex.exec-server", // `codex exec-server --listen stdio`. one JSON-RPC message per text frame
  "codex.app-server", // `codex app-server`. one JSON-RPC message per text frame
  "tcp", // raw TCP to 127.0.0.1:<port> on the node. binary
])
export type TunnelKind = typeof TunnelKind.Type

/** Byte streams the NODE asks the brain to open (`node.openStream`). Each kind maps to a FIXED brain target. */
export const BrainStreamKind = Schema.Literals(["mcp-http", "anthropic-api", "model-api"])
export type BrainStreamKind = typeof BrainStreamKind.Type

/** Every data-stream kind carried on `/node/stream/:id` (see streams.ts for framing). */
export const StreamKind = Schema.Literals([
  "pty",
  "claude.cli",
  "codex.exec-server",
  "codex.app-server",
  "tcp",
  "mcp-http",
  "anthropic-api",
  "model-api",
  "cdp-screencast",
  "vnc-view",
  "vnc-control",
  "transfer",
])
export type StreamKind = typeof StreamKind.Type

/** One-time credential for a node-dialed data stream. */
export const StreamTicket = Schema.Struct({ streamId: Schema.String, streamToken: Schema.String })
export type StreamTicket = typeof StreamTicket.Type

// ---------------------------------------------------------------- browser (capability browser@1)
export const LeaseHolder = Schema.Literals(["user", "bot"])
export type LeaseHolder = typeof LeaseHolder.Type

export const ScrollDirection = Schema.Literals(["up", "down", "left", "right"])
export const MouseButton = Schema.Literals(["left", "middle", "right"])

/**
 * The browser toolkit's verbs. Targets are either a `ref` from the last `snapshot`
 * or viewport CSS-pixel coordinates `x`/`y` (no tuples).
 */
export const BrowserAction = Schema.Union([
  Schema.TaggedStruct("navigate", { url: Schema.String, tabId: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("snapshot", { tabId: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("click", {
    ref: Schema.optional(Schema.String),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    button: Schema.optional(MouseButton),
    clickCount: Schema.optional(Schema.Number),
    tabId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("type", {
    text: Schema.String,
    ref: Schema.optional(Schema.String),
    /** press Enter after typing */
    submit: Schema.optional(Schema.Boolean),
    /** clear the field first */
    clear: Schema.optional(Schema.Boolean),
    tabId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("key", {
    /** Playwright-style combo, e.g. `Enter`, `Control+a`, `Shift+Tab` */
    key: Schema.String,
    tabId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("scroll", {
    direction: ScrollDirection,
    /** in wheel notches (100 CSS px each), default 3 */
    amount: Schema.optional(Schema.Number),
    ref: Schema.optional(Schema.String),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    tabId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("screenshot", {
    fullPage: Schema.optional(Schema.Boolean),
    format: Schema.optional(Schema.Literals(["jpeg", "png", "webp"])),
    quality: Schema.optional(Schema.Number),
    tabId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("tabs", {
    op: Schema.Literals(["list", "new", "select", "close"]),
    tabId: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
  }),
])
export type BrowserAction = typeof BrowserAction.Type

export const BrowserTab = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
})
export type BrowserTab = typeof BrowserTab.Type

export const BrowserImage = Schema.Struct({
  mimeType: Schema.String,
  /** base64 (standard alphabet, as MCP image content expects) */
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
})
export type BrowserImage = typeof BrowserImage.Type

export const BrowserActionResult = Schema.Struct({
  /** model-facing text (snapshot text with refs, "Navigated to …", tab list, …) */
  text: Schema.String,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  image: Schema.optional(BrowserImage),
  tabs: Schema.optional(Schema.Array(BrowserTab)),
})
export type BrowserActionResult = typeof BrowserActionResult.Type

export const BrowserEnsureResult = Schema.Struct({
  /** CDP target id of the bot's window (its active tab) */
  windowTargetId: Schema.String,
  /** node-loopback DevTools port, when the node exposes it (never reachable remotely) */
  cdpPort: Schema.optional(Schema.Number),
  /** viewport size in CSS px */
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
})
export type BrowserEnsureResult = typeof BrowserEnsureResult.Type

export const ScreencastOptions = Schema.Struct({
  format: Schema.optional(Schema.Literals(["jpeg", "png"])),
  quality: Schema.optional(Schema.Number),
  maxWidth: Schema.optional(Schema.Number),
  maxHeight: Schema.optional(Schema.Number),
  everyNthFrame: Schema.optional(Schema.Number),
})
export type ScreencastOptions = typeof ScreencastOptions.Type

export const InputModifiers = Schema.Struct({
  alt: Schema.optional(Schema.Boolean),
  ctrl: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
})
export type InputModifiers = typeof InputModifiers.Type

/**
 * User takeover input. Coordinates are in the CSS-pixel space of the screencast frame metadata
 * (`ScreencastFrameMeta.width/height`); the node maps them to `Input.dispatch*` events.
 */
export const BrowserInputEvent = Schema.Union([
  Schema.TaggedStruct("mouse", {
    type: Schema.Literals(["move", "down", "up", "wheel"]),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optional(Schema.Literals(["none", "left", "middle", "right"])),
    clickCount: Schema.optional(Schema.Number),
    deltaX: Schema.optional(Schema.Number),
    deltaY: Schema.optional(Schema.Number),
    modifiers: Schema.optional(InputModifiers),
  }),
  Schema.TaggedStruct("key", {
    type: Schema.Literals(["down", "up"]),
    /** DOM `KeyboardEvent.key` */
    key: Schema.String,
    /** DOM `KeyboardEvent.code` */
    code: Schema.optional(Schema.String),
    /** text produced by the key (for printable keys) */
    text: Schema.optional(Schema.String),
    modifiers: Schema.optional(InputModifiers),
  }),
  Schema.TaggedStruct("text", { text: Schema.String }),
])
export type BrowserInputEvent = typeof BrowserInputEvent.Type

export const LeaseState = Schema.Struct({ botId: Schema.String, holder: LeaseHolder, since: Schema.Number })
export type LeaseState = typeof LeaseState.Type

// ---------------------------------------------------------------- computer (capability desktop@1, design only)
/** Anthropic computer-use action names; fixed 1280-wide API coordinate space. */
export const ComputerActionName = Schema.Literals([
  "screenshot",
  "zoom",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "cursor_position",
])
export type ComputerActionName = typeof ComputerActionName.Type

export const ComputerAction = Schema.Struct({
  action: ComputerActionName,
  /** `[x, y]` in screenshot pixels, sent as an array of 2 numbers (not a tuple schema) */
  coordinate: Schema.optional(Schema.Array(Schema.Number)),
  start_coordinate: Schema.optional(Schema.Array(Schema.Number)),
  region: Schema.optional(Schema.Array(Schema.Number)),
  text: Schema.optional(Schema.String),
  scroll_direction: Schema.optional(ScrollDirection),
  scroll_amount: Schema.optional(Schema.Number),
  duration: Schema.optional(Schema.Number),
})
export type ComputerAction = typeof ComputerAction.Type

// ---------------------------------------------------------------- BrainRpcs shapes
export const ApprovalDecision = Schema.Literals(["allow-once", "allow-always", "deny"])
export type ApprovalDecision = typeof ApprovalDecision.Type

export const NodeApprovalRequest = Schema.Struct({
  invocationId: Schema.String,
  botId: Schema.String,
  /** `inv.runId` of the gated call (the brain's session key: it routes the approval card). */
  runId: Schema.optional(Schema.String),
  /** `inv.toolCallId` of the gated call, when known. */
  toolCallId: Schema.optional(Schema.String),
  /** Grok-style action vocabulary: run-command, write-file, read-file, browser, tunnel, … */
  action: Schema.String,
  /** what the action targets (command line, path, url) */
  target: Schema.String,
  reason: Schema.String,
})
export type NodeApprovalRequest = typeof NodeApprovalRequest.Type

export const NodeApprovalResponse = Schema.Struct({ decision: ApprovalDecision, by: Schema.String })
export type NodeApprovalResponse = typeof NodeApprovalResponse.Type

export const NodeHeartbeat = Schema.Struct({
  /** node wall clock, ms since epoch */
  at: Schema.Number,
  activeInvocations: Schema.Number,
  load: Schema.optional(Schema.Array(Schema.Number)),
  freeMemBytes: Schema.optional(Schema.Number),
})
export type NodeHeartbeat = typeof NodeHeartbeat.Type

/** Well-known `node.event` types (open set; unknown types must be ignored). */
export const NodeEventTypes = {
  audit: "audit",
  leaseChanged: "browser.lease-changed",
  browserClosed: "browser.closed",
  /** A bot's browser window was created on the node (by a bot action or `browser.ensure`): `{botId, windowTargetId}`. */
  browserOpened: "browser.opened",
  rootsChanged: "node.roots-changed",
} as const

// ---------------------------------------------------------------- pairing (POST /node/pair)
export const PairRequest = Schema.Struct({
  code: Schema.String,
  /** base64url raw Ed25519 public key (32 bytes) */
  publicKey: Schema.String,
  hostname: Schema.String,
  platform: Schema.String,
  arch: Schema.optional(Schema.String),
  nodeVersion: Schema.optional(Schema.String),
  protocol: Schema.optional(ProtocolRange),
})
export type PairRequest = typeof PairRequest.Type

export const PairResponse = Schema.Struct({
  nodeId: Schema.String,
  /** base64url raw Ed25519 public key of the brain; the node pins it */
  brainPublicKey: Schema.String,
  /** the origin the node must sign into its upgrade (`scheme://host[:port]`) */
  brainOrigin: Schema.String,
})
export type PairResponse = typeof PairResponse.Type
