#!/usr/bin/env bun
// DEV MOCK SERVER for the web UI (W2.2): serves index.html through a Bun HTML import (Tailwind via
// bunfig.toml, HMR in development) and implements `OpenBotRpcs` over Effect RPC WebSocket at /rpc
// with an in-memory brain seeded like the Grok Bot reference renders.
//
//   bun apps/web/dev/mock-server.ts [--port 4321] [--host 127.0.0.1] [--empty] [--fast]
//
// --empty starts with no Bots (first-run onboarding); --fast speeds simulated turns up 4x.
// Prints `OPENBOT_MOCK_URL=<url>` once listening (the screenshot test reads it).
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import { OpenBotRpcs } from "@openbot/contracts"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import indexHtml from "../index.html"
import { MockBrain } from "./mock/brain.ts"
import { seed } from "./mock/seed.ts"

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

export interface MockServer {
  readonly url: string
  readonly brain: MockBrain
  readonly stop: () => Promise<void>
}

export const startMockServer = async (options: { port?: number; hostname?: string; empty?: boolean; speed?: number; development?: boolean } = {}): Promise<MockServer> => {
  const brain = new MockBrain()
  if (options.speed !== undefined) brain.speed = options.speed
  if (options.empty) brain.firstRun = true
  else seed(brain)

  const RpcLive = RpcServer.layerHttp({ group: OpenBotRpcs, path: "/rpc", protocol: "websocket", disableFatalDefects: true }).pipe(
    Layer.provide(OpenBotRpcs.toLayer(brain.handlers() as never)),
    Layer.provide(RpcSerialization.layerJson),
  )
  const Attachments = HttpRouter.add(
    "GET",
    "/api/attachments/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.params
      const a = id ? brain.attachments.get(id) : undefined
      return a ? HttpServerResponse.uint8Array(a.bytes, { contentType: a.mime }) : HttpServerResponse.text("not found", { status: 404 })
    }),
  )
  const development = options.development ?? process.env.NODE_ENV !== "production"
  const ServerLive = HttpRouter.serve(Layer.mergeAll(RpcLive, Attachments), { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({
        port: options.port ?? 4321,
        hostname: options.hostname ?? "127.0.0.1",
        idleTimeout: 0,
        routes: { "/": indexHtml },
        development: development ? { hmr: true, console: true } : false,
      }),
    ),
  )
  const runtime = ManagedRuntime.make(ServerLive as Layer.Layer<HttpServer.HttpServer, unknown>)
  const server = await runtime.runPromise(HttpServer.HttpServer)
  const address = server.address as { readonly port: number; readonly hostname?: string }
  const url = `http://${options.hostname ?? "127.0.0.1"}:${address.port}`
  brain.origin = url
  return {
    url,
    brain,
    stop: async () => {
      await Promise.race([runtime.dispose(), Bun.sleep(1500)])
    },
  }
}

const webDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

if (import.meta.main && process.cwd() !== webDir && !process.env.OPENBOT_MOCK_CHILD) {
  // Bun reads bunfig.toml (the Tailwind plugin for HTML imports) from the working directory and
  // resolves the plugin from there; only apps/web declares it. Re-run from apps/web.
  const child = Bun.spawn([process.execPath, "dev/mock-server.ts", ...process.argv.slice(2)], {
    cwd: webDir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, OPENBOT_MOCK_CHILD: "1" },
  })
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig))
  process.exit(await child.exited)
} else if (import.meta.main) {
  const port = Number(arg("port") ?? process.env.PORT ?? 4321)
  const server = await startMockServer({
    port,
    hostname: arg("host") ?? "127.0.0.1",
    empty: flag("empty"),
    ...(flag("fast") ? { speed: 0.25 } : {}),
  })
  console.log(`OpenBot web dev mock: ${server.url}`)
  console.log(`OPENBOT_MOCK_URL=${server.url}`)
  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
