// Codex environment relay (D1.5 "E", remote-codex.md §3.2): placement grants a loopback relay URL;
// every WebSocket the app-server opens on it becomes a `tunnel.open{codex.exec-server}` on the node,
// whose data stream the node dials back on `/node/stream/:id`. Frames pass verbatim.
import { afterAll, describe, expect, test } from "bun:test"
import type { BotId, HarnessCapabilities, NodeId } from "@openbot/contracts"
import { type HarnessDriver, NodeAdmin, PlacementService } from "@openbot/core"
import { makeBot } from "@openbot/core/testing"
import { Effect, Exit, Layer, Scope } from "effect"
import { NodeRegistry, open, RelayService } from "../src/index.ts"
import {
  brainStack,
  connectTestNode,
  dialWebSocket,
  nodeKeys,
  pairOverHttp,
  putBot,
  run,
  startServer,
  tempDir,
} from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

const codexDriver = {
  kind: "codex",
  displayName: "Codex",
  capabilities: {
    resume: true,
    steer: true,
    interrupt: true,
    approvals: "interactive",
    questions: true,
    compact: true,
    contextUsage: true,
    images: true,
    remotePlacements: ["brain-mcp-hands", "codex-environment"],
  } satisfies HarnessCapabilities,
} as unknown as HarnessDriver

const upgradeStatus = (url: string, authorization?: string) =>
  Effect.promise(async () => {
    const headers: Record<string, string> = {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    }
    if (authorization !== undefined) headers["authorization"] = authorization
    return (await fetch(url.replace(/^ws/, "http"), { headers })).status
  })

describe("codex exec-server relay", () => {
  test(
    "relay URL + bearer → tunnel.open on the node → frames spliced verbatim; refusals; release",
    () =>
      run(
        Effect.gen(function* () {
          const server = yield* startServer
          const admin = yield* NodeAdmin
          const registry = yield* NodeRegistry
          const relays = yield* RelayService
          const keys = yield* nodeKeys
          const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
          const nodeId = paired.body.nodeId as NodeId
          const nodeScope = yield* Scope.fork(yield* Effect.scope)
          const node = yield* connectTestNode({
            wsBase: server.ws,
            nodeId,
            keys,
            brainPublicKey: paired.body.brainPublicKey,
            capabilities: ["fs@1", "shell@1", "codex.exec-server@1"],
          }).pipe(Scope.provide(nodeScope))
          yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))

          const botId = "bot_codex" as BotId
          const bot = makeBot({ id: botId, hostNodeId: nodeId, harness: { kind: "codex" } })
          yield* putBot(bot)
          const placementScope = yield* Scope.fork(yield* Effect.scope)
          const placement = yield* (yield* PlacementService)
            .resolve({ bot, driver: codexDriver })
            .pipe(Scope.provide(placementScope))
          expect(placement.mode).toBe("codex-environment")
          const env = placement.codexEnvironment!
          expect(env.execServerUrl).toBe(`${server.ws}/relay/${nodeId}/codex.exec-server`)
          expect(env.cwd).toBe(`/home/u/openbot/workspaces/${botId}`)

          // what codex app-server does after environment/add: dial with the bearer
          const relay = yield* open(
            yield* dialWebSocket(env.execServerUrl, { authorization: `Bearer ${env.authBearerToken}` }),
          )
          const first = yield* relay.pull.pipe(Effect.timeout("5 seconds"))
          expect(first[0]).toBe("codex.exec-server:ready")
          const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
          yield* relay.writer.write(initialize)
          const echoed = yield* relay.pull.pipe(Effect.timeout("5 seconds"))
          expect(echoed[0]).toBe(`codex.exec-server:${initialize}`)
          expect(node.state.tunnels).toEqual([{ kind: "codex.exec-server", cwd: env.cwd, botId }])

          // a reconnect opens a fresh tunnel
          const second = yield* open(
            yield* dialWebSocket(env.execServerUrl, { authorization: `Bearer ${env.authBearerToken}` }),
          )
          expect((yield* second.pull.pipe(Effect.timeout("5 seconds")))[0]).toBe("codex.exec-server:ready")
          expect(node.state.tunnels).toHaveLength(2)

          // refusals: no / wrong bearer, wrong node, unknown kind
          expect(yield* upgradeStatus(env.execServerUrl)).toBe(401)
          expect(yield* upgradeStatus(env.execServerUrl, "Bearer AAAAAAAAAAAAAAAAAAAAAA")).toBe(401)
          expect(
            yield* upgradeStatus(`${server.ws}/relay/nod_other/codex.exec-server`, `Bearer ${env.authBearerToken}`),
          ).toBe(401)
          expect(yield* upgradeStatus(`${server.ws}/relay/${nodeId}/tcp`, `Bearer ${env.authBearerToken}`)).toBe(401)

          // node offline → 503
          yield* Scope.close(nodeScope, Exit.void)
          yield* Effect.sleep("100 millis")
          expect(yield* upgradeStatus(env.execServerUrl, `Bearer ${env.authBearerToken}`)).toBe(503)

          // released placement → the grant is gone
          yield* Scope.close(placementScope, Exit.void)
          expect(yield* relays.activeGrants).toBe(0)
          expect(yield* upgradeStatus(env.execServerUrl, `Bearer ${env.authBearerToken}`)).toBe(401)
        }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
      ),
    20_000,
  )
})
