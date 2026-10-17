/**
 * `NodeFilesLive` (core `NodeFiles`, layer 0): bulk file transfer node → brain for `send_file`.
 *
 * `download` mints a `transfer` stream ticket, asks the node to send the file (`fs.download`, which
 * checks the path with the node's own PathPolicy and `read-file` ceiling and dials
 * `/node/stream/:id`; the local node gets an in-memory pair from `StreamBroker.dialLocal`), and
 * exposes the bytes as a stream: binary frames in order, acknowledged every ≥ 1 MiB (`{"ack":N}`,
 * the node keeps at most an 8 MiB window in flight), ended by the node's `{"done", sha256, size}`
 * frame, which must match the bytes that arrived. Nothing is ever buffered whole.
 *
 * `upload` is the reverse (files sent TO a bot, copied into its workspace inbox): the node answers
 * `fs.upload` once it has received, verified and renamed the file; the brain is the sender here, so
 * it keeps the 8 MiB window and reads the node's acks. A same-size file already at the path is kept.
 */
import type { NodeId } from "@openbot/contracts"
import { type NodeDownload, NodeDirectory, NodeFiles, type NodeUpload } from "@openbot/core"
import {
  base64Decode,
  decodeControlFrame,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_WINDOW_BYTES,
  TransferControl,
  TunnelFailed,
} from "@openbot/node-protocol"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { open } from "./splice.ts"
import { openNodeStream, StreamBroker } from "./StreamBroker.ts"

const failed = (reason: string) => new TunnelFailed({ kind: "transfer", reason })

export const makeNodeFiles = Effect.gen(function*() {
  const directory = yield* NodeDirectory
  const broker = yield* StreamBroker

  return NodeFiles.of({
    upload: (input) =>
      Effect.scoped(Effect.gen(function*() {
        const client = yield* directory.client(input.nodeId as NodeId)
        const existing = yield* client["fs.stat"]({ inv: input.inv, path: input.path }).pipe(Effect.orElseSucceed(() => null))
        if (existing !== null && existing.type === "file" && existing.size === input.size) {
          return { path: existing.path, size: existing.size, skipped: true } satisfies NodeUpload
        }
        const { socket, opened } = yield* openNodeStream(broker, {
          nodeId: input.nodeId,
          kind: "transfer",
          open: (ticket) =>
            client["fs.upload"]({
              inv: input.inv,
              path: input.path,
              size: input.size,
              streamId: ticket.streamId,
              streamToken: ticket.streamToken,
            }).pipe(
              Effect.catchDefect((defect) =>
                Effect.fail(failed(`this node cannot receive files (${defect instanceof Error ? defect.message : String(defect)}); update the node`))
              ),
            ),
        })
        const io = yield* open(socket).pipe(Effect.mapError((e) => failed(`the transfer stream failed: ${e.message}`)))
        const hasher = new Bun.CryptoHasher("sha256")
        let sent = 0
        let acked = 0
        const closed = (e: unknown) => failed(`the node closed the transfer (${e instanceof Error ? e.message : String(e)})`)
        const takeAcks = (frames: ReadonlyArray<string | Uint8Array>) => {
          for (const frame of frames) {
            if (typeof frame !== "string") continue
            const control = decodeControlFrame(TransferControl, frame)
            if (control !== undefined && "ack" in control) acked = Math.max(acked, control.ack)
          }
        }
        const send = (part: Uint8Array) =>
          Effect.gen(function*() {
            // flow control: at most the window in flight (takeAcks advances `acked`)
            // oxlint-disable-next-line no-unmodified-loop-condition
            while (sent - acked >= TRANSFER_WINDOW_BYTES) takeAcks(yield* io.pull.pipe(Effect.mapError(closed)))
            hasher.update(part)
            sent += part.byteLength
            yield* io.writer.write(part).pipe(Effect.mapError(closed))
          })
        const sending = yield* Effect.exit(Effect.gen(function*() {
          yield* Stream.runForEach(input.chunks, (chunk) =>
            Effect.gen(function*() {
              for (let at = 0; at < chunk.byteLength; at += TRANSFER_CHUNK_BYTES) yield* send(chunk.subarray(at, at + TRANSFER_CHUNK_BYTES))
            }))
          yield* io.writer.write(JSON.stringify({ done: true, sha256: hasher.digest("hex"), size: sent })).pipe(Effect.mapError(closed))
        }))
        if (Exit.isFailure(sending)) {
          // the node's own error (path, policy, size) explains a broken stream better than the socket
          const answered = yield* Effect.exit(
            opened.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.failCause(sending.cause) })),
          )
          return yield* Effect.failCause(Exit.isFailure(answered) ? answered.cause : sending.cause)
        }
        const result = yield* opened
        return { path: result.path, size: result.size, skipped: false } satisfies NodeUpload
      })),
    download: (input) =>
      Effect.gen(function*() {
        const client = yield* directory.client(input.nodeId as NodeId)
        const { socket, opened } = yield* openNodeStream(broker, {
          nodeId: input.nodeId,
          kind: "transfer",
          open: (ticket) =>
            client["fs.download"]({
              inv: input.inv,
              path: input.path,
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              maxBytes: input.maxBytes,
              streamId: ticket.streamId,
              streamToken: ticket.streamToken,
            }).pipe(
              // a node from before fs.download answers an unknown request with a defect
              Effect.catchDefect((defect) =>
                Effect.fail(failed(`this node cannot send files (${defect instanceof Error ? defect.message : String(defect)}); update the node`))
              ),
            ),
        })
        const meta = yield* opened
        const io = yield* open(socket).pipe(Effect.mapError((e) => failed(`the transfer stream failed: ${e.message}`)))

        const hasher = new Bun.CryptoHasher("sha256")
        const pending: Array<string | Uint8Array> = []
        let received = 0
        let acked = 0
        let finished = false
        /** The next chunk; `Cause.done()` after the verified final frame. */
        const next: Effect.Effect<Uint8Array, TunnelFailed | Cause.Done> = Effect.gen(function*() {
          while (true) {
            const frame = pending.shift()
            if (frame === undefined) {
              if (finished) return yield* Cause.done()
              const frames = yield* io.pull.pipe(
                Effect.mapError(() => failed("the node closed the transfer before it finished")),
              )
              pending.push(...frames)
              continue
            }
            if (typeof frame === "string") {
              const control = decodeControlFrame(TransferControl, frame)
              if (control === undefined || "ack" in control) continue
              if ("error" in control) return yield* failed(control.error)
              const sha256 = hasher.digest("hex")
              if (control.size !== received || control.sha256 !== sha256) {
                return yield* failed(
                  `the file arrived damaged (${received} bytes, sha256 ${sha256.slice(0, 12)}…; the node sent ${control.size} bytes, sha256 ${control.sha256.slice(0, 12)}…)`,
                )
              }
              finished = true
              return yield* Cause.done()
            }
            if (finished) continue
            received += frame.byteLength
            if (received > input.maxBytes) return yield* failed(`the file is larger than ${input.maxBytes} bytes`)
            hasher.update(frame)
            if (received - acked >= TRANSFER_CHUNK_BYTES) {
              acked = received
              yield* Effect.ignore(io.writer.write(JSON.stringify({ ack: received })))
            }
            return frame
          }
        })

        return {
          path: meta.path,
          name: meta.name,
          size: meta.size,
          mtimeMs: meta.mtimeMs,
          head: base64Decode(meta.head),
          chunks: Stream.fromEffectRepeat(next),
        } satisfies NodeDownload
      }),
  })
})

export const NodeFilesLive: Layer.Layer<NodeFiles, never, NodeDirectory | StreamBroker> = Layer.effect(NodeFiles, makeNodeFiles)
