// Attachment upload helper: reads a File/Blob, base64-encodes it and calls `attachments.upload`
// (`{name, mime, bytesBase64}` → `Attachment`). The returned ids go into `messages.send.attachmentIds`.
import { Effect } from "effect"
import { type Attachment, type Internal, InvalidInput } from "@openbot/contracts"
import { Base64 } from "effect/encoding"
import { Atom } from "effect/reactivity"
import type { RpcClientError } from "effect/rpc"
import { once } from "./once.ts"
import { OpenBotClient } from "./rpc.ts"

/**
 * Largest file the client uploads. The bytes travel base64-encoded (×4/3) inside one JSON RPC frame
 * over the `/rpc` WebSocket, and Bun's default `maxPayloadLength` is 16 MiB, so 10 MiB raw stays
 * safely below it.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** What the helper needs from a browser `File` (a `Blob` with a name). */
export interface UploadSource {
  readonly name: string
  readonly type: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface UploadBytes {
  readonly name: string
  readonly mime: string
  readonly bytes: Uint8Array
}

export const encodeBase64 = (bytes: Uint8Array): string => Base64.encode(bytes)

const tooLarge = (name: string, size: number) =>
  new InvalidInput({
    message: `${name} is ${(size / (1024 * 1024)).toFixed(1)} MB; attachments can be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
  })

export type UploadError = InvalidInput | Internal | RpcClientError.RpcClientError

/** Uploads raw bytes. Fails with `InvalidInput` when the payload is too large or rejected by the brain. */
export const uploadBytes = (input: UploadBytes): Effect.Effect<Attachment, UploadError, OpenBotClient> =>
  Effect.gen(function* () {
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      return yield* Effect.fail(tooLarge(input.name, input.bytes.byteLength))
    const client = yield* OpenBotClient
    return yield* client("attachments.upload", {
      name: input.name,
      mime: input.mime.length > 0 ? input.mime : "application/octet-stream",
      bytesBase64: encodeBase64(input.bytes),
    })
  })

/** Uploads a browser `File` (or any `UploadSource`). */
export const uploadFile = (file: UploadSource): Effect.Effect<Attachment, UploadError, OpenBotClient> =>
  Effect.gen(function* () {
    if (file.size > MAX_ATTACHMENT_BYTES) return yield* Effect.fail(tooLarge(file.name, file.size))
    const buffer = yield* Effect.tryPromise({
      try: () => file.arrayBuffer(),
      catch: () => new InvalidInput({ message: `Couldn't read ${file.name}` }),
    })
    return yield* uploadBytes({ name: file.name, mime: file.type, bytes: new Uint8Array(buffer) })
  })

/**
 * Composer helper: uploads the given files one by one and succeeds with their attachments, in order.
 * Keyed per composer (e.g. by conversation id). Within one key it is single flight: picking new
 * files while an upload runs cancels the previous batch.
 */
export const uploadFilesAtom = Atom.family((_composerKey: string) =>
  OpenBotClient.runtime.fn((files: ReadonlyArray<UploadSource>) =>
    once(files, Effect.forEach(files, uploadFile, { concurrency: 1 })),
  ),
)
