// fs.download / fs.upload (capability fs@1): bulk file transfer over a `transfer` data stream.
// fs.download: a bot sends a file to its owner. The node resolves the path under
// the same PathPolicy and `read-file` ceiling as fs.read, refuses directories, special files and files
// over the size limit, dials the `transfer` data stream, answers the RPC, then streams the bytes with
// the `transfer` framing (node-protocol streams.ts): binary chunks ≤ 1 MiB under an 8 MiB ack
// window, then `{"done":true,"sha256","size"}` (or `{"error"}`), then it waits for the brain to close.
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import {
  base64Encode,
  decodeControlFrame,
  FsError,
  type FsDownloadResult,
  type FsUploadResult,
  type Invocation,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_HEAD_BYTES,
  TRANSFER_WINDOW_BYTES,
  TransferControl,
  TunnelFailed,
} from "@openbot/node-protocol"
import { expandHome } from "./config.ts"
import { attempt } from "./fs.ts"
import { dialSession, type SessionDeps, startSession } from "./sessions.ts"
import type { Duplex } from "./sockets.ts"

export interface DownloadPayload {
  readonly inv: Invocation
  readonly path: string
  readonly cwd?: string | undefined
  readonly maxBytes?: number | undefined
  readonly streamId: string
  readonly streamToken: string
}

/** "24.1 MB", "512 KB", "37 bytes" (decimal units, as file managers show them). */
export const formatBytes = (n: number): string => {
  if (n < 1000) return `${n} byte${n === 1 ? "" : "s"}`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n / 1000
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i++
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`
}

/** How long the node waits for the brain to close after the final frame. */
const CLOSE_WAIT = "30 seconds"

/** Reads `real` and writes it to the stream (flow-controlled); returns when the brain closed or after `CLOSE_WAIT`. */
const sendFile = (io: Duplex, real: string, limit: number) =>
  Effect.gen(function* () {
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => fsp.open(real, "r"), catch: (e) => (e instanceof Error ? e.message : String(e)) }),
      (fh) => Effect.promise(() => fh.close().catch(() => undefined)),
    )
    const hasher = new Bun.CryptoHasher("sha256")
    let sent = 0
    let acked = 0
    const takeAcks = (frames: ReadonlyArray<string | Uint8Array>) => {
      for (const f of frames) {
        if (typeof f !== "string") continue
        const control = decodeControlFrame(TransferControl, f)
        if (control !== undefined && "ack" in control) acked = Math.max(acked, control.ack)
      }
    }
    const failure = yield* Effect.gen(function* () {
      while (true) {
        // flow control: wait for acks while the window is full (a closed stream fails here: abort);
        // `takeAcks` advances `acked`
        // oxlint-disable-next-line no-unmodified-loop-condition
        while (sent - acked >= TRANSFER_WINDOW_BYTES) takeAcks(yield* io.pull)
        const buffer = new Uint8Array(TRANSFER_CHUNK_BYTES)
        const read = yield* Effect.tryPromise({
          try: () => handle.read(buffer, 0, TRANSFER_CHUNK_BYTES, null),
          catch: (e) => (e instanceof Error ? e.message : String(e)),
        })
        if (read.bytesRead === 0) return undefined
        sent += read.bytesRead
        if (sent > limit) return `the file grew beyond the ${formatBytes(limit)} limit while it was being sent`
        const chunk = buffer.subarray(0, read.bytesRead)
        hasher.update(chunk)
        yield* io.writer.write(chunk)
      }
    }).pipe(
      Effect.catch((e) => (typeof e === "string" ? Effect.succeed(`reading the file failed: ${e}`) : Effect.fail(e))),
    )
    yield* io.writer.write(
      JSON.stringify(
        failure === undefined ? { done: true, sha256: hasher.digest("hex"), size: sent } : { error: failure },
      ),
    )
    // the brain closes once it has the final frame (acks may still arrive meanwhile)
    yield* Effect.forever(Effect.map(io.pull, takeAcks)).pipe(
      Effect.ignore,
      Effect.timeoutOrElse({ duration: CLOSE_WAIT, orElse: () => Effect.void }),
    )
  })

export const makeFsDownload = (deps: SessionDeps) => (p: DownloadPayload) =>
  Effect.gen(function* () {
    const requested = expandHome(p.path.trim())
    const cwd = p.cwd === undefined || p.cwd.trim() === "" ? undefined : expandHome(p.cwd.trim())
    const resolved = yield* deps.paths.resolve({ path: requested, botId: p.inv.botId, access: "read", cwd })
    yield* deps.guard.check({ inv: p.inv, action: "read-file", target: resolved.real })
    const st = yield* attempt("download", p.path, () => fsp.stat(resolved.real))
    if (st.isDirectory()) {
      return yield* new FsError({
        op: "download",
        path: p.path,
        code: "EISDIR",
        reason:
          "is a directory; send its files one by one, or archive it first (e.g. `tar czf dir.tgz dir` or `zip -r dir.zip dir`)",
      })
    }
    if (!st.isFile())
      return yield* new FsError({ op: "download", path: p.path, code: "EINVAL", reason: "not a regular file" })
    const limit = Math.max(0, Math.min(p.maxBytes ?? Number.POSITIVE_INFINITY, deps.config.limits.transferBytes))
    if (st.size > limit) {
      return yield* new FsError({
        op: "download",
        path: p.path,
        code: "EFBIG",
        reason: `the file is ${formatBytes(st.size)}; files up to ${formatBytes(limit)} can be sent`,
      })
    }
    const head = yield* attempt("download", p.path, () => Bun.file(resolved.real).slice(0, TRANSFER_HEAD_BYTES).bytes())
    const result: FsDownloadResult = {
      path: resolved.real,
      name: path.basename(resolved.real),
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      head: base64Encode(head),
    }
    return yield* startSession<FsDownloadResult>(deps, "transfer", (ready) =>
      Effect.gen(function* () {
        const io = yield* dialSession(deps, { streamId: p.streamId, streamToken: p.streamToken }, "transfer")
        yield* Deferred.succeed(ready, result)
        yield* sendFile(io, resolved.real, limit).pipe(Effect.ignore)
      }),
    )
  })

// ---------------------------------------------------------------- fs.upload (brain → node)

export interface UploadPayload {
  readonly inv: Invocation
  readonly path: string
  readonly size: number
  readonly streamId: string
  readonly streamToken: string
}

/**
 * fs.upload: receive a file the brain sends (a file another bot or the owner sent to this bot) into
 * a sibling temp file, ack every ≥ 1 MiB, verify the sender's final sha256/size, then rename it into
 * place. Answers when the file is complete; nothing appears at `path` otherwise.
 */
export const makeFsUpload = (deps: SessionDeps) => (p: UploadPayload) =>
  Effect.gen(function* () {
    const requested = expandHome(p.path.trim())
    const resolved = yield* deps.paths.resolve({ path: requested, botId: p.inv.botId, access: "write" })
    yield* deps.guard.check({ inv: p.inv, action: "write-file", target: resolved.real })
    const limit = deps.config.limits.transferBytes
    if (!Number.isSafeInteger(p.size) || p.size < 0 || p.size > limit) {
      return yield* new FsError({
        op: "upload",
        path: p.path,
        code: "EFBIG",
        reason: `the file is ${formatBytes(p.size)}; this node accepts files up to ${formatBytes(limit)}`,
      })
    }
    const target = resolved.real
    const existing = yield* attempt("upload", p.path, () =>
      fsp.lstat(target).then(
        (st) => st,
        () => undefined,
      ),
    )
    if (existing?.isDirectory())
      return yield* new FsError({ op: "upload", path: p.path, code: "EISDIR", reason: "is a directory" })
    yield* attempt("upload", p.path, () => fsp.mkdir(path.dirname(target), { recursive: true }))
    // the parent may only now exist: re-check containment (a symlinked parent could escape the root)
    yield* deps.paths.resolve({ path: target, botId: p.inv.botId, access: "write" })
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const io = yield* dialSession(deps, { streamId: p.streamId, streamToken: p.streamToken }, "transfer")
        const temp = path.join(
          path.dirname(target),
          `.${path.basename(target)}.openbot-upload-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        )
        const handle = yield* Effect.acquireRelease(
          attempt("upload", p.path, () => fsp.open(temp, "wx", 0o644)),
          (fh) =>
            Effect.promise(() =>
              fh
                .close()
                .catch(() => undefined)
                .then(() => fsp.rm(temp, { force: true }).catch(() => undefined)),
            ),
        )
        const failed = (reason: string) => new TunnelFailed({ kind: "transfer", reason })
        const hasher = new Bun.CryptoHasher("sha256")
        let received = 0
        let acked = 0
        let done: { readonly sha256: string; readonly size: number } | undefined
        while (done === undefined) {
          const frames = yield* io.pull.pipe(
            Effect.mapError(() => failed("the brain closed the transfer before it finished")),
          )
          for (const frame of frames) {
            if (typeof frame === "string") {
              const control = decodeControlFrame(TransferControl, frame)
              if (control === undefined || "ack" in control) continue
              if ("error" in control) return yield* failed(control.error)
              done = control
              break
            }
            received += frame.byteLength
            if (received > p.size) return yield* failed(`more than the announced ${p.size} bytes arrived`)
            hasher.update(frame)
            yield* attempt("upload", p.path, () => handle.write(frame))
            if (received - acked >= TRANSFER_CHUNK_BYTES) {
              acked = received
              yield* Effect.ignore(io.writer.write(JSON.stringify({ ack: received })))
            }
          }
        }
        const sha256 = hasher.digest("hex")
        if (done.size !== received || done.sha256 !== sha256) {
          return yield* failed(
            `the file arrived damaged (${received} bytes, sha256 ${sha256.slice(0, 12)}…; the brain sent ${done.size} bytes)`,
          )
        }
        yield* attempt("upload", p.path, () => handle.sync().then(() => fsp.rename(temp, target)))
        return { path: target, size: received, sha256 } satisfies FsUploadResult
      }),
    )
  })
