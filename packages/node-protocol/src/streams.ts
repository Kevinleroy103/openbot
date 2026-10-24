// Data streams (`/node/stream/:id`): tickets and per-kind framing helpers.
// The brain splices stream frames verbatim (binary stays binary, text stays text), so each kind keeps
// its own framing end to end. See docs/node-protocol.md §Streams.
import * as Schema from "effect/Schema"
import { randomToken, utf8Decode, utf8Encode } from "./encoding.ts"
import type { StreamTicket } from "./schemas.ts"

/** Mint a one-time stream ticket: 96-bit id, 128-bit token (base64url). */
export const mintStreamTicket = (): StreamTicket => ({ streamId: randomToken(12), streamToken: randomToken(16) })

// ---------------------------------------------------------------- pty
// binary frames: terminal bytes (both directions)
// text frames:   brain -> node {"resize":{"cols":120,"rows":40}}
//                node -> brain {"exit":0,"signal":null}
export const PtyResize = Schema.Struct({ resize: Schema.Struct({ cols: Schema.Number, rows: Schema.Number }) })
export type PtyResize = typeof PtyResize.Type
export const PtyExit = Schema.Struct({
  exit: Schema.NullOr(Schema.Number),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
})
export type PtyExit = typeof PtyExit.Type
export const PtyControl = Schema.Union([PtyResize, PtyExit])
export type PtyControl = typeof PtyControl.Type

// ---------------------------------------------------------------- claude.cli
// binary frames: stdin (brain -> node) / stdout (node -> brain)
// text frames:   brain -> node {"eof":true} | {"kill":"SIGTERM"}
//                node -> brain {"exit":0,"signal":null}
export const CliEof = Schema.Struct({ eof: Schema.Literal(true) })
export const CliKill = Schema.Struct({ kill: Schema.String })
export const CliExit = Schema.Struct({ exit: Schema.NullOr(Schema.Number), signal: Schema.NullOr(Schema.String) })
export const CliControl = Schema.Union([CliEof, CliKill, CliExit])
export type CliControl = typeof CliControl.Type

/** Decode a JSON control text frame for a kind (pty / claude.cli). Returns undefined when it is not valid. */
export const decodeControlFrame = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  frame: string,
): S["Type"] | undefined => {
  try {
    const result = Schema.decodeUnknownOption(schema)(JSON.parse(frame))
    return result._tag === "Some" ? result.value : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- cdp-screencast (and screen)
// node -> brain -> viewer; a `screen` stream (screen@1, the computer's own screen) is framed the
// same way. Each frame is ONE binary WebSocket frame:
//   [u32 big-endian N][N bytes UTF-8 JSON ScreencastFrameMeta][image bytes]
// Text frames carry ScreencastNotice JSON (e.g. {"_tag":"Ended","reason":"target closed"}).
export const ScreencastFrameMeta = Schema.Struct({
  seq: Schema.Number,
  /** image/jpeg or image/png */
  mime: Schema.String,
  /** frame size in device pixels */
  width: Schema.Number,
  height: Schema.Number,
  /** CSS-pixel viewport the input coordinates refer to */
  viewportWidth: Schema.Number,
  viewportHeight: Schema.Number,
  /** ms since epoch (CDP metadata.timestamp × 1000) */
  timestamp: Schema.Number,
})
export type ScreencastFrameMeta = typeof ScreencastFrameMeta.Type

export const ScreencastNotice = Schema.Union([
  Schema.TaggedStruct("Ended", { reason: Schema.String }),
  Schema.TaggedStruct("Lease", { holder: Schema.Literals(["user", "bot"]) }),
  Schema.TaggedStruct("Url", { url: Schema.String, title: Schema.String }),
])
export type ScreencastNotice = typeof ScreencastNotice.Type

const MAX_META_BYTES = 64 * 1024

export const encodeScreencastFrame = (meta: ScreencastFrameMeta, image: Uint8Array): Uint8Array<ArrayBuffer> => {
  const header = utf8Encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + header.length + image.length)
  new DataView(out.buffer).setUint32(0, header.length, false)
  out.set(header, 4)
  out.set(image, 4 + header.length)
  return out
}

const decodeMeta = Schema.decodeUnknownOption(ScreencastFrameMeta)

/** Inverse of `encodeScreencastFrame`; `undefined` for malformed frames. `image` is a view into `frame`. */
export const decodeScreencastFrame = (
  frame: Uint8Array,
): { readonly meta: ScreencastFrameMeta; readonly image: Uint8Array } | undefined => {
  if (frame.length < 4) return undefined
  const n = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
  if (n > MAX_META_BYTES || 4 + n > frame.length) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(utf8Decode(frame.subarray(4, 4 + n)))
  } catch {
    return undefined
  }
  const meta = decodeMeta(raw)
  if (meta._tag === "None") return undefined
  return { meta: meta.value, image: frame.subarray(4 + n) }
}

// ---------------------------------------------------------------- transfer (fs.download, fs.upload)
// The SENDER (the node for fs.download, the brain for fs.upload):
//   BINARY frames = the file's bytes in order, each ≤ TRANSFER_CHUNK_BYTES; then ONE text frame
//   {"done":true,"sha256":"<hex of every byte sent>","size":N} — or, when reading fails midway,
//   {"error":"…"}.
// The RECEIVER: text {"ack":N} = N bytes received in total so far, at least every
//   TRANSFER_CHUNK_BYTES. Flow control: the sender keeps at most TRANSFER_WINDOW_BYTES sent but not
//   acknowledged, so neither side buffers a whole file. Closing the stream aborts.
// fs.download: after its final frame the node waits for the brain to close. fs.upload: the node
//   answers the RPC once the file is verified and in place.
export const TRANSFER_CHUNK_BYTES = 1024 * 1024
export const TRANSFER_WINDOW_BYTES = 8 * 1024 * 1024
/** Max bytes of `FsDownloadResult.head`. */
export const TRANSFER_HEAD_BYTES = 4096

export const TransferDone = Schema.Struct({ done: Schema.Literal(true), sha256: Schema.String, size: Schema.Number })
export type TransferDone = typeof TransferDone.Type
export const TransferFailure = Schema.Struct({ error: Schema.String })
export type TransferFailure = typeof TransferFailure.Type
export const TransferAck = Schema.Struct({ ack: Schema.Number })
export type TransferAck = typeof TransferAck.Type
/** Text frames of a `transfer` stream (both directions). */
export const TransferControl = Schema.Union([TransferDone, TransferFailure, TransferAck])
export type TransferControl = typeof TransferControl.Type

// ---------------------------------------------------------------- other kinds
// codex.exec-server / codex.app-server: one JSON-RPC message per TEXT frame (the node converts NDJSON stdio)
// tcp, mcp-http, anthropic-api, model-api, vnc-view, vnc-control: raw BINARY frames
