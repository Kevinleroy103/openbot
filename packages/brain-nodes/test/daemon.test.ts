// End to end with the real `@openbot/node-daemon` as a REMOTE node over a real Bun WebSocket:
// `pairNode` (POST /node/pair, identity in its KeyStore) → `RemoteNodeLive` (DialOut: signed `/node`
// upgrade, `node.hello` gate verifying the brain signature with the pinned key, NodeHandlersLive) →
// NodeDirectory.client RPC round trips (shell.exec, fs) → placement creates the remote workspace →
// node-policy approval over BrainRpcs with the stamped node id → terminal over a node-dialed pty
// stream → revoke closes with 4401 and the daemon stops redialing.
import { afterAll, describe, expect, test } from "bun:test"
import type { BotId, HarnessCapabilities, NodeId } from "@openbot/contracts"
import { type HarnessDriver, NodeAdmin, NodeDirectory, NodeFiles, PlacementService } from "@openbot/core"
import { ApprovalServiceFake, makeBot } from "@openbot/core/testing"
import { DialOut, makeKeyStore, pairNode, RemoteNodeLive } from "@openbot/node-daemon"
import type { ExecEvent } from "@openbot/node-protocol"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeRegistry, open } from "../src/index.ts"
import { brainStack, dialWebSocket, putBot, run, startServer, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

const fakeDriver = {
  kind: "fake",
  displayName: "Fake",
  capabilities: {
    resume: true,
    steer: true,
    interrupt: true,
    approvals: "interactive",
    questions: true,
    compact: true,
    contextUsage: true,
    images: false,
    remotePlacements: ["brain-mcp-hands"],
  } satisfies HarnessCapabilities,
} as unknown as HarnessDriver

const outputOf = (events: ReadonlyArray<ExecEvent>) =>
  events.flatMap((e) => (e._tag === "Output" ? [e.data] : [])).join("")

describe("remote node-daemon over a real WebSocket", () => {
  test(
    "pair → signed connect → hello → RPC round trips → placement → approval → terminal → revoke 4401",
    () =>
      run(
        Effect.gen(function* () {
          const server = yield* startServer
          const admin = yield* NodeAdmin
          const directory = yield* NodeDirectory
          const registry = yield* NodeRegistry
          const approvals = yield* ApprovalServiceFake

          // the node's machine: one root, its own state dir
          const root = join(dir.path, "remote", "openbot")
          const nodeData = join(dir.path, "remote", "node-data")
          mkdirSync(root, { recursive: true })

          // the daemon pairs itself and pins the brain key
          const identity = yield* pairNode({
            brainUrl: server.http,
            code: (yield* admin.createPairingCode).code,
            keyStore: makeKeyStore(nodeData),
            hostname: "build-box",
          })
          const nodeId = identity.nodeId as NodeId
          expect(identity.brainOrigin).toBe("https://brain.test")

          const daemon = yield* Layer.build(
            RemoteNodeLive({
              node: {
                nodeId,
                dataDir: nodeData,
                roots: [root],
                hostname: "build-box",
                detectBinaries: false,
                browser: { enabled: false },
                forwardAudit: false,
                policy: { ceiling: "always", actions: { "run-command": "ask" } },
              },
              dial: { identity, heartbeatMs: 0 },
            }),
          )
          const dialOut = Context.get(daemon, DialOut)
          const conn = yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("10 seconds"))
          expect(conn.hello).toMatchObject({ nodeId, hostname: "build-box", brainVerified: true, protocol: 1 })
          yield* dialOut.changes.pipe(
            Stream.filter((s) => s._tag === "Verified"),
            Stream.runHead,
            Effect.timeout("5 seconds"),
          )

          const summary = yield* directory.get(nodeId)
          expect(summary).toMatchObject({ kind: "remote", status: "online", label: "build-box", roots: [root] })
          // first hello after pairing: declared = approved
          expect(summary.capabilities).toEqual(["fs@1", "shell@1", "pty@1", "tunnel@1"])

          // brain → node through the port, served by node-daemon's handlers
          const client = yield* directory.client(nodeId)
          const botId = "bot_remote" as BotId
          const inv = (n: number) => ({ invocationId: `inv_${n}`, botId, runId: `${botId}:cnv_x` })
          const written = yield* client["fs.write"]({
            inv: inv(1),
            path: join(root, "hello.txt"),
            content: "from the brain",
          })
          expect(written.size).toBe(14)
          const read = yield* client["fs.read"]({ inv: inv(2), path: join(root, "hello.txt") })
          expect(read.content).toBe("from the brain")
          const denied = yield* Effect.flip(client["fs.read"]({ inv: inv(3), path: join(nodeData, "audit.jsonl") }))
          expect(denied._tag).toBe("PathDenied")

          // send_file's transfer: fs.download + a node-dialed `transfer` stream over a real WebSocket
          const video = new Uint8Array(5 * 1024 * 1024 + 777)
          for (let i = 0; i < video.length; i++) video[i] = (i * 7 + (i >> 11)) & 0xff
          writeFileSync(join(root, "render.mp4"), video)
          const received = yield* Effect.scoped(
            Effect.gen(function* () {
              const dl = yield* (yield* NodeFiles).download({
                nodeId,
                inv: inv(10),
                path: "render.mp4",
                cwd: root,
                maxBytes: 100_000_000,
              })
              const hasher = new Bun.CryptoHasher("sha256")
              let size = 0
              yield* Stream.runForEach(dl.chunks, (chunk) =>
                Effect.sync(() => {
                  hasher.update(chunk)
                  size += chunk.byteLength
                }),
              )
              return { name: dl.name, size, sha: hasher.digest("hex") }
            }),
          ).pipe(Effect.timeout("20 seconds"))
          expect(received).toEqual({
            name: "render.mp4",
            size: video.byteLength,
            sha: new Bun.CryptoHasher("sha256").update(video).digest("hex"),
          })
          const outsideRoot = yield* Effect.flip(
            Effect.scoped(
              (yield* NodeFiles).download({
                nodeId,
                inv: inv(11),
                path: join(nodeData, "audit.jsonl"),
                maxBytes: 100_000_000,
              }),
            ),
          )
          expect(outsideRoot._tag).toBe("PathDenied")
          // and the reverse (a file sent to a bot on this node): fs.upload over a real WebSocket
          const inbox = join(root, "inbox", "att_1", "render-copy.mp4")
          const uploaded = yield* (yield* NodeFiles)
            .upload({ nodeId, inv: inv(12), path: inbox, size: video.byteLength, chunks: Stream.make(video) })
            .pipe(Effect.timeout("20 seconds"))
          expect(uploaded).toEqual({ path: inbox, size: video.byteLength, skipped: false })
          expect(new Bun.CryptoHasher("sha256").update(new Uint8Array(readFileSync(inbox))).digest("hex")).toBe(
            received.sha,
          )

          // placement (B1 for a remote host) creates the bot's workspace on the node
          yield* putBot(makeBot({ id: botId, hostNodeId: nodeId }))
          const placement = yield* (yield* PlacementService).resolve({
            bot: makeBot({ id: botId, hostNodeId: nodeId }),
            driver: fakeDriver,
          })
          expect(placement).toMatchObject({
            mode: "brain-mcp-hands",
            disableBuiltinTools: true,
            workspacePath: join(root, "workspaces", botId),
          })
          expect(existsSync(placement.workspacePath)).toBe(true)

          // run-command asks: node → brain node.requestApproval, stamped with the authenticated node id
          const exec = yield* client["shell.exec"]({
            inv: inv(4),
            command: "echo remote-$((6*7)); hostname >/dev/null; pwd",
            cwd: placement.workspacePath,
            timeoutMs: 10_000,
          }).pipe(Stream.runCollect)
          expect(outputOf(exec)).toContain("remote-42")
          expect(outputOf(exec)).toContain(placement.workspacePath)
          expect(exec.at(-1)).toMatchObject({ _tag: "Exit", code: 0 })
          const asked = yield* approvals.nodeRequests
          expect(asked).toHaveLength(1)
          expect(asked[0]).toMatchObject({ nodeId, request: { botId, action: "run-command", runId: `${botId}:cnv_x` } })

          // the terminal: the node dials /node/stream/:id for the pty, spliced to the viewer
          const term = yield* open(yield* dialWebSocket(`${server.ws}/ws/terminal/${botId}?cols=80&rows=24`))
          const decoder = new TextDecoder()
          let screen = ""
          yield* term.writer.write("echo term-$((50+8))\r")
          yield* Effect.gen(function* () {
            while (!screen.includes("term-58")) {
              for (const f of yield* term.pull) screen += typeof f === "string" ? f : decoder.decode(f)
            }
          }).pipe(Effect.timeout("10 seconds"))

          // revoke → 4401: the daemon stops for good; offline for the port
          yield* admin.revoke(nodeId)
          const final = yield* dialOut.done.pipe(Effect.timeout("10 seconds"))
          expect(final._tag).toBe("Revoked")
          expect(Option.isNone(yield* registry.connection(nodeId))).toBe(true)
          const offline = yield* Effect.flip(directory.client(nodeId))
          expect(offline).toMatchObject({ _tag: "NodeUnavailable", nodeId })
        }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: join(dir.path, "brain") })))),
      ),
    30_000,
  )
})
