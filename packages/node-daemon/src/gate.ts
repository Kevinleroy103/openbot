// The `node.hello` gate (D1.3; docs/node-protocol.md §3.2). On a REMOTE control connection the node
// answers every RPC except `node.hello` with `NotAuthenticated` until the brain's signature over THIS
// connection's upgrade nonce verifies against the brain key the node PINNED at pairing. A DNS or proxy
// hijack therefore cannot drive the node. A failed hello fails with `NotAuthenticated` and the
// connection is closed (4403; 4426 when no protocol version is shared).
//
// The gate wraps the raw handler record per connection (DialOut builds a fresh one per dial), so the
// in-process local node (brain-nodes, links.ts) keeps using the ungated `NodeHandlersLive`.
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { RpcSchema } from "effect/rpc"
import {
  CloseCodes,
  NodeRpcs,
  NotAuthenticated,
  verifyHello,
  type NodeHello,
  type NodeHelloRequest,
} from "@openbot/node-protocol"
import type { NodeHandlerRecord } from "./handlers.ts"

/** Tags of `NodeRpcs` whose success is a stream (`shell.exec`). */
export const STREAMING_NODE_RPCS: ReadonlySet<string> = new Set(
  [...NodeRpcs.requests.values()].filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema)).map((rpc) => rpc._tag),
)

export interface HelloGateOptions {
  readonly nodeId: string
  /** base64url raw Ed25519 key pinned at pairing */
  readonly brainPublicKey: string
  /** the origin both sides sign (from pairing) */
  readonly brainOrigin: string
  /** nonce of this connection's signed upgrade */
  readonly nonce: string
  /** hello failed: close the connection with `code` (after the error response went out) */
  readonly onRejected?: ((code: number, reason: string) => Effect.Effect<void>) | undefined
  readonly onVerified?: ((hello: NodeHello) => Effect.Effect<void>) | undefined
}

export interface HelloGate {
  /** gated handlers for this connection */
  readonly handlers: NodeHandlerRecord
  readonly isVerified: () => boolean
}

const notAuthenticated = () =>
  new NotAuthenticated({ reason: "node.hello with a valid brain signature is required first" })

type AnyHandler = (payload: unknown, options: unknown) => unknown

export const makeHelloGate = (handlers: NodeHandlerRecord, options: HelloGateOptions): HelloGate => {
  let verified = false
  const reject = (code: number, reason: string) =>
    Effect.gen(function* () {
      verified = false
      if (options.onRejected) yield* options.onRejected(code, reason)
      return yield* new NotAuthenticated({ reason })
    })

  const out: Record<string, AnyHandler> = {}
  for (const [tag, handler] of Object.entries(handlers) as Array<[string, AnyHandler]>) {
    if (tag === "node.hello") {
      out[tag] = (request, rpcOptions) =>
        Effect.gen(function* () {
          const req = request as NodeHelloRequest
          const ok = yield* verifyHello({
            brainPublicKey: options.brainPublicKey,
            nodeId: options.nodeId,
            nonce: options.nonce,
            brainOrigin: options.brainOrigin,
            brainSig: req.brainSig,
          })
          if (!ok)
            return yield* reject(
              CloseCodes.helloFailed,
              "the brain signature does not verify against the pinned brain key",
            )
          // the ungated handler negotiates the protocol (NotAuthenticated when no version is shared)
          const inner = yield* Effect.result(handler(request, rpcOptions) as Effect.Effect<NodeHello, NotAuthenticated>)
          if (inner._tag === "Failure") return yield* reject(CloseCodes.protocolMismatch, inner.failure.reason)
          const hello: NodeHello = { ...inner.success, nodeId: options.nodeId, brainVerified: true }
          verified = true
          if (options.onVerified) yield* options.onVerified(hello)
          return hello
        })
      continue
    }
    out[tag] = STREAMING_NODE_RPCS.has(tag)
      ? (payload, rpcOptions) =>
          Stream.unwrap(
            Effect.suspend(() =>
              verified
                ? Effect.succeed(handler(payload, rpcOptions) as Stream.Stream<unknown, unknown>)
                : Effect.fail(notAuthenticated()),
            ),
          )
      : (payload, rpcOptions) =>
          Effect.suspend(() =>
            verified
              ? (handler(payload, rpcOptions) as Effect.Effect<unknown, unknown>)
              : Effect.fail(notAuthenticated()),
          )
  }
  return { handlers: out as unknown as NodeHandlerRecord, isVerified: () => verified }
}
