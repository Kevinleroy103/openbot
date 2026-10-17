/**
 * The brain's two listeners (D1.8, architecture §4.9, hands-architecture-synthesis.md §S.8).
 *
 * - **Public** (`--host`:`--port`, default `127.0.0.1:7420`): web app, `/rpc`, `/api/*`, `/ws/*`,
 *   `/node*`. Exposed remotely only through Tailscale serve or a TLS proxy (`--public-origin`).
 * - **Internal** (`127.0.0.1:<ephemeral>`, never exposed): `/mcp/:botId` (gateway) and
 *   `/relay/:nodeId/:kind` (brain-nodes). Its URL is the `InternalAddress`.
 *
 * Both sockets are bound at the bottom of the layer graph so their addresses (origins for node
 * signatures, the gateway URL) are known to every layer; until the routes are attached at the end
 * of boot (`HttpRouter.serve`) they answer 404. HTTP `idleTimeout: 0` (long MCP calls, streams) and
 * WebSocket `idleTimeout: 0` (quiet data streams). Preemptive shutdown is off: on shutdown the route
 * fibers are interrupted first (closing every WebSocket), so Bun's `server.stop()` never waits on
 * an open socket.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { InternalAddress } from "@openbot/core"
import { Context, Effect, Layer } from "effect"
import { HttpServer, HttpServerError } from "effect/http"
import { ServerConfig } from "./config.ts"
import { planWeb, type WebPlan } from "./web.ts"

/** Max WebSocket frame: `attachments.upload` sends up to 25 MiB as base64 in one RPC frame. */
export const PUBLIC_MAX_PAYLOAD_BYTES = 48 * 1024 * 1024
export const INTERNAL_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

export interface PublicListenerShape {
  readonly server: HttpServer.HttpServer["Service"]
  readonly port: number
  /** A loopback URL of this listener, e.g. `http://127.0.0.1:7420`. */
  readonly selfBase: string
  /** The URL printed for the owner (`<loginBase>/?token=…`). */
  readonly loginBase: string
  /** Canonical origin nodes sign their upgrade for (the first `--public-origin`, else `selfBase`). */
  readonly brainOrigin: string
  /** Browser origins accepted for cookie-authenticated requests (lower-case). */
  readonly allowedOrigins: ReadonlyArray<string>
  /** Configured `--public-origin` values. */
  readonly publicOrigins: ReadonlyArray<string>
  readonly web: WebPlan
}

export class PublicListener extends Context.Service<PublicListener, PublicListenerShape>()(
  "openbot/server/PublicListener",
) {}

export interface InternalListenerShape {
  readonly server: HttpServer.HttpServer["Service"]
  /** e.g. `http://127.0.0.1:43123` */
  readonly baseUrl: string
}

export class InternalListener extends Context.Service<InternalListener, InternalListenerShape>()(
  "openbot/server/InternalListener",
) {}

const isWildcard = (host: string): boolean => host === "0.0.0.0" || host === "::" || host === "" || host === "[::]"
const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.")

const hostForUrl = (host: string): string => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host)

const portOf = (server: HttpServer.HttpServer["Service"]): number => {
  const address = server.address
  if (address._tag === "UnixPathAddress") throw new Error("expected a TCP listener")
  return address.port
}

/** Origins for a listener bound at `host:port` plus the configured public origins. */
export const originsFor = (input: {
  readonly host: string
  readonly port: number
  readonly publicOrigins: ReadonlyArray<string>
}): Pick<PublicListenerShape, "selfBase" | "loginBase" | "brainOrigin" | "allowedOrigins"> => {
  const host = input.host.trim().toLowerCase()
  const local = [`http://127.0.0.1:${input.port}`, `http://localhost:${input.port}`]
  const bound = isWildcard(host) || isLoopback(host) ? undefined : `http://${hostForUrl(host)}:${input.port}`
  const selfBase = bound ?? `http://127.0.0.1:${input.port}`
  const allowed = [...new Set([...input.publicOrigins.map((o) => o.toLowerCase()), ...local, ...(bound ? [bound] : [])])]
  return {
    selfBase,
    loginBase: selfBase,
    brainOrigin: input.publicOrigins[0] ?? selfBase,
    allowedOrigins: allowed,
  }
}

export const PublicListenerLive: Layer.Layer<PublicListener, HttpServerError.ServeError, ServerConfig> = Layer.effect(
  PublicListener,
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const web = planWeb({ dev: config.dev, cwd: process.cwd() })
    const server = yield* BunHttpServer.make({
      hostname: config.host,
      port: config.port,
      // explicit: with `development: false` Bun 1.4.2 otherwise lets a second process bind the same
      // port (SO_REUSEPORT), silently splitting traffic between two brains
      reusePort: false,
      idleTimeout: 0,
      development: web.development,
      ...(web.bunRoutes === undefined ? {} : { routes: web.bunRoutes }),
      disablePreemptiveShutdown: true,
      websocket: { idleTimeout: 0, maxPayloadLength: PUBLIC_MAX_PAYLOAD_BYTES },
    })
    const port = portOf(server)
    if (web.note !== undefined) yield* Effect.logWarning(`Web app: ${web.note}`)
    return PublicListener.of({
      server,
      port,
      publicOrigins: config.publicOrigins,
      web,
      ...originsFor({ host: config.host, port, publicOrigins: config.publicOrigins }),
    })
  }),
)

export const InternalListenerLive: Layer.Layer<InternalListener, HttpServerError.ServeError> = Layer.effect(
  InternalListener,
  Effect.gen(function*() {
    const server = yield* BunHttpServer.make({
      hostname: "127.0.0.1",
      port: 0,
      reusePort: false,
      idleTimeout: 0,
      disablePreemptiveShutdown: true,
      websocket: { idleTimeout: 0, maxPayloadLength: INTERNAL_MAX_PAYLOAD_BYTES },
    })
    return InternalListener.of({ server, baseUrl: `http://127.0.0.1:${portOf(server)}` })
  }),
)

/** `InternalAddress` (gateway bindings, Codex relays) = the internal listener's URL. */
export const InternalAddressLive: Layer.Layer<InternalAddress, never, InternalListener> = Layer.effect(
  InternalAddress,
  Effect.map(InternalListener, (listener) => InternalAddress.of({ baseUrl: Effect.succeed(listener.baseUrl) })),
)

/** Provides `HttpServer` = the public listener (for `HttpRouter.serve`). */
export const PublicHttpServer: Layer.Layer<HttpServer.HttpServer, never, PublicListener> = Layer.effect(
  HttpServer.HttpServer,
  Effect.map(PublicListener, (listener) => listener.server),
)

/** Provides `HttpServer` = the internal listener (for `HttpRouter.serve`). */
export const InternalHttpServer: Layer.Layer<HttpServer.HttpServer, never, InternalListener> = Layer.effect(
  HttpServer.HttpServer,
  Effect.map(InternalListener, (listener) => listener.server),
)
