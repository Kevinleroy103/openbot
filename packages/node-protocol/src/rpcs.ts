// The two RPC groups that ride ONE node-dialed WebSocket (see mux.ts):
//   NodeRpcs  : brain = client, node = server   (hands operations)
//   BrainRpcs : node = client,  brain = server  (approvals, node-initiated streams, events, heartbeats)
// Wire: RpcSerialization.layerJsonRpc() (JSON-RPC 2.0, one message per text frame); docs/node-protocol.md.
// Ported from vendor/scratch/hands-e2e/contract.ts and extended per docs/architecture.md §4.2.
import * as Schema from "effect/Schema"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  BrowserActionFailed,
  BrowserUnavailable,
  DesktopUnavailable,
  EditFailed,
  FsError,
  LeaseHeld,
  NotAuthenticated,
  PathDenied,
  PolicyRefused,
  StreamRefused,
  TunnelFailed,
} from "./errors.ts"
import {
  BrainStreamKind,
  BrowserAction,
  BrowserActionResult,
  BrowserEnsureResult,
  BrowserInputEvent,
  ComputerAction,
  ComputerResult,
  DesktopInfo,
  ExecEvent,
  FileStat,
  FsDownloadResult,
  FsEditResult,
  FsUploadResult,
  FsGlobResult,
  FsGrepResult,
  FsListResult,
  FsReadResult,
  FsWriteResult,
  GrepOutputMode,
  Invocation,
  LeaseHolder,
  LeaseState,
  NodeApprovalRequest,
  NodeApprovalResponse,
  NodeHeartbeat,
  NodeHello,
  NodeHelloRequest,
  ScreencastOptions,
  StreamTicket,
  TextEncoding,
  TunnelKind,
} from "./schemas.ts"

const FsErrors = Schema.Union([PathDenied, PolicyRefused, FsError, NotAuthenticated])
const FsEditErrors = Schema.Union([PathDenied, PolicyRefused, EditFailed, FsError, NotAuthenticated])
const BrowserErrors = Schema.Union([BrowserUnavailable, PolicyRefused, NotAuthenticated])

// ---------------------------------------------------------------- brain -> node
export class NodeRpcs extends RpcGroup.make(
  // Mutual auth: the first call on every connection. The node refuses every other RPC
  // (NotAuthenticated) until the brain signature verifies against the pinned brain key.
  Rpc.make("node.hello", {
    payload: NodeHelloRequest,
    success: NodeHello,
    error: NotAuthenticated,
  }),

  // ---- fs (capability fs@1); all paths are resolved by the node against its roots
  Rpc.make("fs.read", {
    payload: {
      inv: Invocation,
      path: Schema.String,
      /** byte offset (default 0) */
      offset: Schema.optional(Schema.Number),
      /** max bytes (default: node cap) */
      limit: Schema.optional(Schema.Number),
      /** default utf8; base64 for binary */
      encoding: Schema.optional(TextEncoding),
    },
    success: FsReadResult,
    error: FsErrors,
  }),
  Rpc.make("fs.write", {
    payload: {
      inv: Invocation,
      path: Schema.String,
      content: Schema.String,
      encoding: Schema.optional(TextEncoding),
      /** optimistic concurrency: fail with EditFailed when the current sha256 differs ("" = must not exist) */
      expectedSha256: Schema.optional(Schema.String),
      /** create missing parent directories (default true) */
      createParents: Schema.optional(Schema.Boolean),
    },
    success: FsWriteResult,
    error: FsEditErrors,
  }),
  Rpc.make("fs.edit", {
    payload: {
      inv: Invocation,
      path: Schema.String,
      oldString: Schema.String,
      newString: Schema.String,
      /** replace every occurrence; otherwise the match must be unique */
      replaceAll: Schema.optional(Schema.Boolean),
      expectedSha256: Schema.optional(Schema.String),
    },
    success: FsEditResult,
    error: FsEditErrors,
  }),
  Rpc.make("fs.stat", {
    payload: { inv: Invocation, path: Schema.String },
    /** null when the path does not exist */
    success: Schema.NullOr(FileStat),
    error: FsErrors,
  }),
  Rpc.make("fs.list", {
    payload: {
      inv: Invocation,
      path: Schema.String,
      /** recursion depth, default 1 (direct children only) */
      depth: Schema.optional(Schema.Number),
      includeHidden: Schema.optional(Schema.Boolean),
      limit: Schema.optional(Schema.Number),
    },
    success: FsListResult,
    error: FsErrors,
  }),
  Rpc.make("fs.glob", {
    payload: {
      inv: Invocation,
      pattern: Schema.String,
      cwd: Schema.String,
      limit: Schema.optional(Schema.Number),
    },
    success: FsGlobResult,
    error: FsErrors,
  }),
  Rpc.make("fs.grep", {
    payload: {
      inv: Invocation,
      /** regular expression (ripgrep syntax) unless `literal` */
      pattern: Schema.String,
      path: Schema.String,
      glob: Schema.optional(Schema.String),
      ignoreCase: Schema.optional(Schema.Boolean),
      literal: Schema.optional(Schema.Boolean),
      contextLines: Schema.optional(Schema.Number),
      outputMode: Schema.optional(GrepOutputMode),
      limit: Schema.optional(Schema.Number),
    },
    success: FsGrepResult,
    error: FsErrors,
  }),
  // Bulk read (send a file to the owner): the node resolves `path` (a leading `~/` is the node's
  // home; relative paths use `cwd`) under the same PathPolicy and `read-file` ceiling as `fs.read`,
  // refuses non-regular files and files over `maxBytes` (and the node's own transfer cap), dials the
  // `transfer` data stream with the ticket, answers, then streams the bytes (streams.ts framing).
  Rpc.make("fs.download", {
    payload: {
      inv: Invocation,
      path: Schema.String,
      cwd: Schema.optional(Schema.String),
      /** refuse larger files (the node also applies its own cap) */
      maxBytes: Schema.optional(Schema.Number),
      streamId: Schema.String,
      streamToken: Schema.String,
    },
    success: FsDownloadResult,
    error: Schema.Union([PathDenied, PolicyRefused, FsError, TunnelFailed, NotAuthenticated]),
  }),
  // Bulk write (files sent to a bot land in its workspace inbox): the node resolves `path` for writing
  // (same PathPolicy and `write-file` ceiling as fs.write), refuses files over its transfer cap, creates
  // the parent directories, dials the `transfer` stream and RECEIVES the bytes (the brain sends, the
  // node acks), verifies the final sha256/size, renames the file into place atomically and answers.
  Rpc.make("fs.upload", {
    payload: {
      inv: Invocation,
      path: Schema.String,
      /** announced size in bytes (more is refused) */
      size: Schema.Number,
      streamId: Schema.String,
      streamToken: Schema.String,
    },
    success: FsUploadResult,
    error: Schema.Union([PathDenied, PolicyRefused, FsError, TunnelFailed, NotAuthenticated]),
  }),
  Rpc.make("fs.mkdir", {
    payload: { inv: Invocation, path: Schema.String, recursive: Schema.optional(Schema.Boolean) },
    error: FsErrors,
  }),
  Rpc.make("fs.move", {
    payload: { inv: Invocation, from: Schema.String, to: Schema.String, overwrite: Schema.optional(Schema.Boolean) },
    error: FsErrors,
  }),
  Rpc.make("fs.remove", {
    payload: { inv: Invocation, path: Schema.String, recursive: Schema.optional(Schema.Boolean) },
    error: FsErrors,
  }),

  // ---- shell (capability shell@1). Interrupt (@effect/rpc/Interrupt) or timeout kills the process group.
  Rpc.make("shell.exec", {
    payload: {
      inv: Invocation,
      command: Schema.String,
      cwd: Schema.String,
      timeoutMs: Schema.Number,
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      /** cap on streamed output bytes; the rest is spilled to a file on the node */
      outputLimitBytes: Schema.optional(Schema.Number),
    },
    success: ExecEvent,
    error: Schema.Union([PathDenied, PolicyRefused, NotAuthenticated]),
    stream: true,
  }),

  // ---- data-plane openers: the node dials /node/stream/:id with the one-time token
  Rpc.make("pty.open", {
    payload: {
      inv: Invocation,
      cols: Schema.Number,
      rows: Schema.Number,
      cwd: Schema.String,
      shell: Schema.optional(Schema.String),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      streamId: Schema.String,
      streamToken: Schema.String,
    },
    success: Schema.Struct({ pid: Schema.Number }),
    error: Schema.Union([PathDenied, PolicyRefused, TunnelFailed, NotAuthenticated]),
  }),
  Rpc.make("tunnel.open", {
    payload: {
      inv: Invocation,
      kind: TunnelKind,
      args: Schema.Array(Schema.String),
      env: Schema.Record(Schema.String, Schema.String),
      cwd: Schema.String,
      /** `tcp` only: node-loopback port */
      port: Schema.optional(Schema.Number),
      streamId: Schema.String,
      streamToken: Schema.String,
    },
    success: Schema.Struct({ pid: Schema.NullOr(Schema.Number) }),
    error: Schema.Union([TunnelFailed, PathDenied, PolicyRefused, NotAuthenticated]),
  }),
  // node-local services a harness-on-node needs (OpenCode server); returns the node-loopback port
  Rpc.make("service.start", {
    payload: {
      inv: Invocation,
      kind: Schema.Literals(["opencode.serve"]),
      env: Schema.Record(Schema.String, Schema.String),
      cwd: Schema.String,
    },
    success: Schema.Struct({ serviceId: Schema.String, port: Schema.Number, pid: Schema.Number }),
    error: Schema.Union([TunnelFailed, PathDenied, PolicyRefused, NotAuthenticated]),
  }),
  Rpc.make("service.stop", {
    payload: { inv: Invocation, serviceId: Schema.String },
    error: NotAuthenticated,
  }),
  // node-local listener (loopback TCP or 0600 unix socket); every accepted connection becomes a
  // node-initiated stream (BrainRpcs node.openStream) to a fixed brain-internal target
  Rpc.make("forward.listen", {
    payload: { inv: Invocation, kind: BrainStreamKind, transport: Schema.Literals(["tcp", "unix"]) },
    success: Schema.Struct({ port: Schema.NullOr(Schema.Number), path: Schema.NullOr(Schema.String) }),
    error: Schema.Union([TunnelFailed, NotAuthenticated]),
  }),

  // ---- browser (capability browser@1): one Chromium per node, one window per bot, driven by CDP
  Rpc.make("browser.ensure", {
    payload: { botId: Schema.String },
    success: BrowserEnsureResult,
    error: BrowserErrors,
  }),
  Rpc.make("browser.action", {
    payload: { inv: Invocation, action: BrowserAction },
    success: BrowserActionResult,
    error: Schema.Union([BrowserUnavailable, BrowserActionFailed, LeaseHeld, PolicyRefused, NotAuthenticated]),
  }),
  // opens a `cdp-screencast` data stream (the node dials /node/stream/:id); frames per streams.ts
  Rpc.make("browser.screencast", {
    payload: {
      botId: Schema.String,
      streamId: Schema.String,
      streamToken: Schema.String,
      options: Schema.optional(ScreencastOptions),
    },
    success: Schema.Struct({ windowTargetId: Schema.String }),
    error: Schema.Union([BrowserUnavailable, TunnelFailed, NotAuthenticated]),
  }),
  // user takeover input; refused with LeaseHeld unless the lease holder is the user
  Rpc.make("browser.input", {
    payload: { botId: Schema.String, event: BrowserInputEvent },
    error: Schema.Union([BrowserUnavailable, LeaseHeld, NotAuthenticated]),
  }),
  // the brain (ComputerService) owns the lease and mirrors it to the node, which gates input
  Rpc.make("lease.set", {
    payload: { botId: Schema.String, holder: LeaseHolder },
    success: LeaseState,
    error: NotAuthenticated,
  }),
  // ------------------------------------------------------------ desktop@1 (D1.7): a screen per bot
  // starts (or returns) the bot's desktop: its X display with a window manager, dock and VNC servers
  Rpc.make("desktop.ensure", {
    payload: { botId: Schema.String },
    success: DesktopInfo,
    error: Schema.Union([DesktopUnavailable, NotAuthenticated]),
  }),
  // stops the bot's desktop and everything on it ("Reset"); the next ensure starts a fresh one
  Rpc.make("desktop.stop", {
    payload: { botId: Schema.String },
    error: NotAuthenticated,
  }),
  // one computer-use action on the bot's desktop (starting it when needed); refused while the
  // owner holds the lease (LeaseHeld)
  Rpc.make("computer.act", {
    payload: { inv: Invocation, action: ComputerAction },
    success: ComputerResult,
    error: Schema.Union([LeaseHeld, PolicyRefused, DesktopUnavailable, NotAuthenticated]),
  }),
  // opens a `vnc-view` (read-only) / `vnc-control` data stream to the bot's VNC server;
  // `control` needs the owner to hold the lease
  Rpc.make("computer.stream", {
    payload: {
      botId: Schema.String,
      mode: Schema.Literals(["view", "control"]),
      streamId: Schema.String,
      streamToken: Schema.String,
    },
    error: Schema.Union([TunnelFailed, LeaseHeld, DesktopUnavailable, NotAuthenticated]),
  }),
) {}

// ---------------------------------------------------------------- node -> brain (same socket)
// The brain mux stamps `x-openbot-node-id` onto every request; handlers read it from headers and
// never trust a node id in the payload.
export class BrainRpcs extends RpcGroup.make(
  Rpc.make("node.requestApproval", {
    payload: NodeApprovalRequest,
    success: NodeApprovalResponse,
  }),
  Rpc.make("node.openStream", {
    payload: { kind: BrainStreamKind, botId: Schema.String },
    success: StreamTicket,
    error: StreamRefused,
  }),
  Rpc.make("node.event", {
    payload: { type: Schema.String, data: Schema.Unknown },
  }),
  Rpc.make("node.heartbeat", {
    payload: NodeHeartbeat,
  }),
) {}

export type NodeRpcsGroup = typeof NodeRpcs
export type BrainRpcsGroup = typeof BrainRpcs
