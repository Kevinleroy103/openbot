/**
 * `NodeFiles` port (layer 0, implemented by `@openbot/brain-nodes`): bulk file transfer between the
 * brain and a node: `download` for `send_file` (a bot shares a file it produced), `upload` for files
 * sent TO a bot (copied into its workspace inbox on its host node).
 *
 * The bytes never ride one JSON-RPC frame: brain-nodes asks the node (`fs.download`) to dial a
 * `transfer` data stream (`/node/stream/:id`, or an in-memory pair for the local node) and reads the
 * file from it in ≤ 1 MiB chunks under an ack window. The node resolves the path with its own
 * PathPolicy (roots, deny-list, realpath containment) and `read-file` ceiling, exactly as `fs.read`.
 *
 * `chunks` is single use and only valid inside the scope `download` ran in (the stream's socket is
 * scoped). It fails with `TunnelFailed{kind:"transfer"}` when the stream breaks, the file grows past
 * `maxBytes`, or the node's final sha256/size does not match what arrived.
 */
import type { NodeId, NodeUnavailable } from "@openbot/contracts"
import type {
  FsError,
  Invocation,
  NotAuthenticated,
  PathDenied,
  PolicyRefused,
  StreamRefused,
  TunnelFailed,
} from "@openbot/node-protocol"
import { Context, type Effect, type Scope, type Stream } from "effect"
import type { RpcClientError } from "effect/rpc"

export interface NodeDownloadInput {
  readonly nodeId: NodeId
  readonly inv: Invocation
  /** As the bot wrote it: absolute, `~/…` (the node's home) or relative to `cwd`. */
  readonly path: string
  /** Base of relative paths (the bot's workspace on that node). */
  readonly cwd?: string | undefined
  /** Refuse files larger than this (the node applies its own cap as well). */
  readonly maxBytes: number
}

export interface NodeDownload {
  /** Canonical path on the node. */
  readonly path: string
  /** File name (last path segment). */
  readonly name: string
  /** Size when the node opened it. */
  readonly size: number
  readonly mtimeMs: number
  /** The first bytes (≤ 4 KiB), for type sniffing before the transfer. */
  readonly head: Uint8Array
  /** The file's bytes in order (single use, inside the download's scope). */
  readonly chunks: Stream.Stream<Uint8Array, TunnelFailed>
}

export type NodeDownloadError =
  | NodeUnavailable
  | PathDenied
  | PolicyRefused
  | FsError
  | TunnelFailed
  | StreamRefused
  | NotAuthenticated
  | RpcClientError.RpcClientError

export interface NodeUploadInput<E> {
  readonly nodeId: NodeId
  readonly inv: Invocation
  /** Absolute target path on the node (parent directories are created). */
  readonly path: string
  readonly size: number
  /** The bytes, in order (any chunk size; re-chunked to ≤ 1 MiB frames). */
  readonly chunks: Stream.Stream<Uint8Array, E>
}

export interface NodeUpload {
  /** Canonical path on the node. */
  readonly path: string
  readonly size: number
  /** A regular file of the same size was already there: nothing was sent. */
  readonly skipped: boolean
}

export class NodeFiles extends Context.Service<
  NodeFiles,
  {
    readonly download: (input: NodeDownloadInput) => Effect.Effect<NodeDownload, NodeDownloadError, Scope.Scope>
    /**
     * Brain → node (`fs.upload` + a `transfer` stream the brain writes): files sent to a bot land in
     * its workspace on its host node. The node checks the path with its PathPolicy (`write-file`
     * ceiling), verifies sha256/size and renames the file into place; a same-size file already at
     * `path` is kept (`skipped`).
     */
    readonly upload: <E>(input: NodeUploadInput<E>) => Effect.Effect<NodeUpload, NodeDownloadError | E>
  }
>()("openbot/core/NodeFiles") {}
