/**
 * Errors of the Codex app-server JSON-RPC peer. They never leave this package: the driver and the
 * session map them to core's `HarnessError` (`toHarnessError`).
 */
import { HarnessError, type HarnessErrorCode } from "@openbot/core"
import { Schema } from "effect"

/** A JSON-RPC error response from the app-server (`{id, error: {code, message, data?}}`). */
export class CodexRpcError extends Schema.TaggedError<CodexRpcError>()("CodexRpcError", {
  method: Schema.String,
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {}

/** The connection is gone: the process exited, stdout ended or stdin broke. */
export class CodexTransportClosed extends Schema.TaggedError<CodexTransportClosed>()("CodexTransportClosed", {
  reason: Schema.String,
}) {}

/** A request did not get a response in time. */
export class CodexRequestTimeout extends Schema.TaggedError<CodexRequestTimeout>()("CodexRequestTimeout", {
  method: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export type CodexPeerError = CodexRpcError | CodexTransportClosed | CodexRequestTimeout

/** JSON-RPC error codes used by OpenBot when answering server requests. */
export const RpcErrorCodes = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Too many concurrent server requests (t3code's `overloaded`). */
  overloaded: -32001,
  /** The OpenBot session that owned the request closed before answering. */
  sessionClosed: -32002,
} as const

const describe = (error: CodexPeerError): string => {
  switch (error._tag) {
    case "CodexRpcError":
      return `${error.method}: ${error.message} (code ${error.code})`
    case "CodexTransportClosed":
      return `Codex app-server connection closed: ${error.reason}`
    case "CodexRequestTimeout":
      return `${error.method} timed out after ${Math.round(error.timeoutMs / 1000)} s`
  }
}

/** Maps a peer error to the port error. Transport loss is always `closed` (retryable). */
export const toHarnessError = (code: HarnessErrorCode, error: CodexPeerError, prefix?: string): HarnessError =>
  new HarnessError({
    harness: "codex",
    code: error._tag === "CodexTransportClosed" ? "closed" : code,
    message: prefix ? `${prefix}: ${describe(error)}` : describe(error),
    retryable: error._tag !== "CodexRpcError",
    cause: error,
  })

export const harnessError = (code: HarnessErrorCode, message: string, cause?: unknown): HarnessError =>
  new HarnessError({ harness: "codex", code, message, ...(cause === undefined ? {} : { cause }) })
