import { describe, expect, test } from "bun:test"
import type { HarnessCapabilities, NodeSummary } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { Effect, Exit, Fiber, Result, Scope, Stream } from "effect"
import {
  ComputerPort,
  type HarnessDriver,
  McpBindingIssuer,
  NodeDirectory,
  type NodeClient,
  Notifier,
  PlacementService,
} from "../../src/ports/index.ts"
import {
  advance,
  botId,
  ComputerPortFake,
  conversationId,
  localNodeSummary,
  makeBot,
  McpBindingIssuerFake,
  nodeId,
  NodeDirectoryFake,
  NotifierFake,
  PlacementServiceFake,
  planPlacement,
  remoteNodeSummary,
  runTest,
  TestPorts,
} from "../../src/testing/index.ts"

const caps = (remotePlacements: HarnessCapabilities["remotePlacements"]): HarnessCapabilities => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: "interactive",
  questions: true,
  compact: true,
  contextUsage: true,
  images: true,
  remotePlacements,
})

const driverOf = (
  kind: HarnessDriver["kind"],
  remotePlacements: HarnessCapabilities["remotePlacements"],
): HarnessDriver => ({
  kind,
  displayName: kind,
  capabilities: caps(remotePlacements),
  probe: Effect.succeed({ kind, installed: true, auth: { state: "unknown" }, problems: [] }),
  listModels: Effect.succeed([]),
  openSession: () => Effect.die("not used"),
})

const remote = remoteNodeSummary("nod_remote")
const remoteWithCodex = remoteNodeSummary("nod_codex", { capabilities: ["fs@1", "shell@1", "codex.exec-server@1"] })
const remoteWithBrowser = remoteNodeSummary("nod_browser", { capabilities: ["fs@1", "browser@1", "desktop@1"] })

describe("planPlacement (§3.3 / D1.5 matrix)", () => {
  const plan = (
    kind: string,
    remotePlacements: HarnessCapabilities["remotePlacements"],
    hostNode: NodeSummary,
    boundNodeIds: ReadonlyArray<string> = [],
  ) =>
    planPlacement({
      bot: makeBot({ hostNodeId: hostNode.id, boundNodeIds: boundNodeIds.map(nodeId) }),
      driverKind: kind,
      capabilities: caps(remotePlacements),
      hostNode,
    })
  const mode = (r: ReturnType<typeof plan>) => (Result.isSuccess(r) ? r.success.mode : r.failure.reason)

  test("local host → native-local for every harness", () => {
    for (const kind of ["claude", "codex", "opencode", "fake"]) {
      expect(mode(plan(kind, ["brain-mcp-hands"], localNodeSummary()))).toBe("native-local")
    }
  })

  test("remote host: codex + exec-server → codex-environment, otherwise B1", () => {
    expect(mode(plan("codex", ["codex-environment", "brain-mcp-hands"], remoteWithCodex))).toBe("codex-environment")
    expect(mode(plan("codex", ["codex-environment", "brain-mcp-hands"], remote))).toBe("brain-mcp-hands")
    expect(mode(plan("claude", ["brain-mcp-hands"], remoteWithCodex))).toBe("brain-mcp-hands")
    expect(mode(plan("opencode", ["brain-mcp-hands"], remote))).toBe("brain-mcp-hands")
  })

  test("B1 disables built-ins and adds the node toolset", () => {
    const r = plan("claude", ["brain-mcp-hands"], remote)
    expect(Result.isSuccess(r) && r.success.disableBuiltinTools).toBe(true)
    expect(Result.isSuccess(r) && r.success.toolsets).toEqual(["bot", "node"])
  })

  test("browser/computer toolsets follow host capabilities", () => {
    const r = plan("claude", ["brain-mcp-hands"], remoteWithBrowser)
    expect(Result.isSuccess(r) && r.success.toolsets).toEqual(["bot", "node", "browser", "computer"])
    const local = plan("claude", [], localNodeSummary())
    expect(Result.isSuccess(local) && local.success.toolsets).toEqual(["bot", "browser"])
    expect(Result.isSuccess(r) && r.success.sharedScreen).toBeFalsy()
    // a Mac's own screen: the computer toolset too, marked shared
    const mac = plan(
      "claude",
      ["brain-mcp-hands"],
      remoteNodeSummary("nod_mac", { capabilities: ["fs@1", "browser@1", "screen@1"] }),
    )
    expect(Result.isSuccess(mac) && mac.success.toolsets).toEqual(["bot", "node", "browser", "computer"])
    expect(Result.isSuccess(mac) && mac.success.sharedScreen).toBe(true)
  })

  test("node toolset for local bots bound to other nodes", () => {
    const r = plan("claude", [], localNodeSummary(), ["nod_remote"])
    expect(Result.isSuccess(r) && r.success.toolsets).toContain("node")
  })

  test("no remote placement implemented → unsupported; offline host → node-unavailable", () => {
    expect(mode(plan("claude", [], remote))).toBe("unsupported-placement")
    expect(mode(plan("claude", ["brain-mcp-hands"], { ...remote, status: "offline" }))).toBe("node-unavailable")
  })
})

describe("PlacementServiceFake", () => {
  test("resolves via NodeDirectory and releases when the scope closes", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const placement = yield* PlacementService
        const fake = yield* PlacementServiceFake
        const scope = yield* Scope.make()
        const resolved = yield* placement
          .resolve({
            bot: makeBot({ id: botId("bot_r"), hostNodeId: remote.id }),
            driver: driverOf("claude", ["brain-mcp-hands"]),
          })
          .pipe(Scope.provide(scope))
        const before = (yield* fake.resolutions).map((r) => r.released)
        yield* Scope.close(scope, Exit.void)
        const after = (yield* fake.resolutions).map((r) => r.released)
        return { resolved, before, after }
      }),
      TestPorts({ nodes: [localNodeSummary(), remote] }),
    )
    expect(result.resolved.mode).toBe("brain-mcp-hands")
    expect(result.resolved.hostNodeId).toBe(remote.id)
    expect(result.resolved.workspacePath).toBe("/home/nod_remote/openbot/workspaces/bot_r")
    expect(result.resolved.harnessCwd).toBe("/openbot-test/bots/bot_r/workspace")
    expect(result.before).toEqual([false])
    expect(result.after).toEqual([true])
  })

  test("local bots get native-local with workspace = harness cwd", async () => {
    const resolved = await runTest(
      Effect.scoped(
        Effect.flatMap(PlacementService, (p) =>
          p.resolve({ bot: makeBot({ id: botId("bot_l") }), driver: driverOf("fake", ["brain-mcp-hands"]) }),
        ),
      ),
      TestPorts(),
    )
    expect(resolved.mode).toBe("native-local")
    expect(resolved.workspacePath).toBe(resolved.harnessCwd)
  })

  test("unknown host node → PlacementError(node-unavailable)", async () => {
    const exit = await runTest(
      Effect.exit(
        Effect.scoped(
          Effect.flatMap(PlacementService, (p) =>
            p.resolve({
              bot: makeBot({ hostNodeId: nodeId("nod_gone") }),
              driver: driverOf("fake", ["brain-mcp-hands"]),
            }),
          ),
        ),
      ),
      TestPorts(),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("node-unavailable")
  })
})

describe("McpBindingIssuerFake", () => {
  test("bindings carry the token in headers and are revoked with their scope", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const issuer = yield* McpBindingIssuer
        const fake = yield* McpBindingIssuerFake
        const scope = yield* Scope.make()
        const binding = yield* issuer
          .issue({
            botId: botId("bot_a"),
            conversationId: conversationId("cnv_a"),
            sessionKey: "bot_a:cnv_a",
            toolsets: ["bot"],
            hostNodeId: LOCAL_NODE_ID,
            workspacePath: "/openbot-test/bots/bot_a/workspace",
            boundNodeIds: [],
          })
          .pipe(Scope.provide(scope))
        const token = binding.headers.Authorization!.replace("Bearer ", "")
        const live = yield* fake.verify(token)
        yield* Scope.close(scope, Exit.void)
        const revoked = yield* fake.verify(token)
        return { binding, live, revoked }
      }),
      TestPorts(),
    )
    expect(out.binding.name).toBe("openbot")
    expect(out.binding.url).toBe("http://127.0.0.1:0/mcp/bot_a")
    expect(out.binding.url).not.toContain("test-token")
    expect(out.live?.botId).toBe(botId("bot_a"))
    expect(out.revoked).toBeUndefined()
  })
})

describe("NodeDirectoryFake", () => {
  test("client requires an online node with a client; changes are published", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const directory = yield* NodeDirectory
        const control = yield* NodeDirectoryFake
        const noClient = yield* Effect.exit(directory.client(LOCAL_NODE_ID))
        yield* control.setClient(LOCAL_NODE_ID, {} as NodeClient)
        const withClient = yield* Effect.exit(directory.client(LOCAL_NODE_ID))
        const watcher = yield* Stream.runCollect(Stream.take(directory.changes, 3)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* control.upsert(localNodeSummary({ status: "offline" }))
        yield* control.upsert(remoteNodeSummary("nod_gone"))
        yield* control.remove(nodeId("nod_gone"))
        const changes = yield* Fiber.join(watcher)
        const offline = yield* Effect.exit(directory.client(LOCAL_NODE_ID))
        const unknown = yield* Effect.exit(directory.capabilities(nodeId("nod_x")))
        return { noClient, withClient, changes, offline, unknown }
      }),
      TestPorts(),
    )
    expect(Exit.isFailure(out.noClient)).toBe(true)
    expect(Exit.isSuccess(out.withClient)).toBe(true)
    expect(out.changes.map((c) => (c.type === "node.upserted" ? c.node.status : c.type))).toEqual([
      "offline",
      "online",
      "node.removed",
    ])
    expect(JSON.stringify(out.offline)).toContain("offline")
    expect(JSON.stringify(out.unknown)).toContain("NodeUnavailable")
  })
})

describe("ComputerPortFake and NotifierFake", () => {
  test("ensure → ready, lease toggles controller", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const computer = yield* ComputerPort
        yield* ComputerPortFake
        const absent = yield* computer.status(botId("bot_c"))
        const ready = yield* computer.ensure(botId("bot_c"))
        const taken = yield* computer.lease(botId("bot_c"), true)
        return [absent.state, ready.state, taken.controller]
      }),
      TestPorts(),
    )
    expect(out).toEqual(["absent", "ready", "user"])
  })

  test("notifications are recorded with ids and Clock time", async () => {
    const sent = await runTest(
      Effect.gen(function* () {
        const notifier = yield* Notifier
        yield* advance("5 seconds")
        yield* notifier.notify({ kind: "finished", botId: botId("bot_n"), title: "Scout", body: "Done" })
        return yield* Effect.flatMap(NotifierFake, (f) => f.sent)
      }),
      TestPorts(),
    )
    expect(sent.map((n) => [n.id, n.at, n.title])).toEqual([["ntf_000001", 5000, "Scout"]])
  })
})
