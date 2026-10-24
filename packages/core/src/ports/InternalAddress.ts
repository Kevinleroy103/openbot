/**
 * `InternalAddress` port (architecture §4.6, D1.8): the base URL of the brain's INTERNAL listener
 * (loopback, ephemeral port) that serves `/mcp/:botId` (gateway) and `/relay/:nodeId/:kind`
 * (brain-nodes relays).
 *
 * Provided by apps/server. Consumers:
 * - gateway `McpBindingIssuerLive` builds `<baseUrl>/mcp/<botId>`;
 * - brain-nodes `PlacementServiceLive` builds `ws://…/relay/<nodeId>/codex.exec-server`.
 *
 * `baseUrl` is an Effect because the listener binds port 0: the server may build layers first and
 * complete the address once `Bun.serve` has bound (e.g. from a `Deferred`).
 */
import { Context, Effect, Layer } from "effect"

export class InternalAddress extends Context.Service<
  InternalAddress,
  {
    /** e.g. `http://127.0.0.1:43123` (no trailing slash). Waits until the listener is bound. */
    readonly baseUrl: Effect.Effect<string>
  }
>()("openbot/core/InternalAddress") {
  /** A fixed address (tests, or a server that binds before building layers). */
  static readonly layer = (baseUrl: string): Layer.Layer<InternalAddress> =>
    Layer.succeed(InternalAddress, InternalAddress.of({ baseUrl: Effect.succeed(baseUrl.replace(/\/+$/, "")) }))
}
