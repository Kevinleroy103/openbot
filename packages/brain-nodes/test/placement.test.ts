// PlacementServiceLive (D1.5, architecture §3.3): the placement matrix
// (local vs remote host × claude/codex/opencode/fake × node capabilities), Codex relay grants, the
// prompt append, workspaces and release.
import { afterAll, describe, expect, test } from "bun:test"
import type { Bot, HarnessCapabilities, NodeId, NodeSummary, PlacementMode } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { DataDir, type HarnessDriver, InternalAddress, PlacementService, type ResolvedPlacement } from "@openbot/core"
import { localNodeSummary, makeBot, NodeDirectoryFake, remoteNodeSummary, SequentialIdGen } from "@openbot/core/testing"
import { Effect, Exit, Layer, Scope } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  BrainNodesConfig,
  PlacementServiceLive,
  RelayService,
  RelayServiceLive,
  StreamBrokerLive,
} from "../src/index.ts"
import { run, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

const INTERNAL = "http://127.0.0.1:47999"

type Kind = "claude" | "codex" | "opencode" | "fake"

/** Remote placements each v1 driver declares (mirrors the adapters' `capabilities`). */
const remotePlacementsOf: Record<Kind, ReadonlyArray<PlacementMode>> = {
  claude: ["brain-mcp-hands"],
  codex: ["brain-mcp-hands", "codex-environment"],
  opencode: ["brain-mcp-hands"],
  fake: ["brain-mcp-hands"],
}

const driver = (kind: string, remotePlacements: ReadonlyArray<PlacementMode>): HarnessDriver => {
  const capabilities: HarnessCapabilities = {
    resume: true,
    steer: false,
    interrupt: true,
    approvals: "interactive",
    questions: true,
    compact: false,
    contextUsage: false,
    images: false,
    remotePlacements: [...remotePlacements],
  }
  return {
    kind,
    displayName: kind,
    capabilities,
    probe: Effect.die("unused"),
    listModels: Effect.die("unused"),
    openSession: () => Effect.die("unused"),
  } as unknown as HarnessDriver
}

const REMOTE = "nod_laptop" as NodeId
const OTHER = "nod_server" as NodeId

const hosts = {
  local: localNodeSummary({ capabilities: ["fs@1", "shell@1", "pty@1"] }),
  localBrowser: localNodeSummary({ capabilities: ["fs@1", "shell@1", "pty@1", "browser@1"] }),
  remote: remoteNodeSummary(REMOTE, { label: "Laptop", roots: ["/home/u/openbot"] }),
  remoteCodex: remoteNodeSummary(REMOTE, {
    label: "Laptop",
    roots: ["/home/u/openbot"],
    capabilities: ["fs@1", "shell@1", "pty@1", "codex.exec-server@1"],
  }),
  remoteBrowser: remoteNodeSummary(REMOTE, {
    label: "Laptop",
    roots: ["/home/u/openbot"],
    capabilities: ["fs@1", "shell@1", "browser@1"],
  }),
  remoteDesktop: remoteNodeSummary(REMOTE, {
    label: "Laptop",
    roots: ["/home/u/openbot"],
    capabilities: ["fs@1", "shell@1", "browser@1", "desktop@1"],
  }),
} satisfies Record<string, NodeSummary>

const layer = (nodes: ReadonlyArray<NodeSummary>) => {
  const base = Layer.mergeAll(
    NodeDirectoryFake.layer({ nodes }),
    DataDir.layer(dir.path),
    InternalAddress.layer(INTERNAL),
    SequentialIdGen(),
    BrainNodesConfig.layer({ brainOrigin: "https://brain.test" }),
  )
  return PlacementServiceLive.pipe(
    Layer.provideMerge(RelayServiceLive),
    Layer.provideMerge(StreamBrokerLive),
    Layer.provideMerge(base),
  )
}

const resolve = (bot: Bot, kind: string, remotePlacements: ReadonlyArray<PlacementMode>) =>
  Effect.flatMap(PlacementService, (s) => s.resolve({ bot, driver: driver(kind, remotePlacements) }))

const resolveIn = (nodes: ReadonlyArray<NodeSummary>, bot: Bot, kind: Kind) =>
  run(Effect.provide(resolve(bot, kind, remotePlacementsOf[kind]), layer(nodes)))

const botOn = (hostNodeId: NodeId, extra?: Partial<Bot>) =>
  makeBot({ id: "bot_ada" as Bot["id"], hostNodeId, ...extra })

interface Expectation {
  readonly mode: PlacementMode
  readonly disableBuiltinTools: boolean
  readonly toolsets: ReadonlyArray<string>
  readonly codexEnvironment: boolean
}

const kinds: ReadonlyArray<Kind> = ["claude", "codex", "opencode", "fake"]

/** The D1.5 matrix: [host, kind, expectation]. */
const matrix: ReadonlyArray<readonly [keyof typeof hosts, Kind, Expectation]> = kinds.flatMap((kind) => [
  // local host: native tools everywhere
  [
    "local",
    kind,
    { mode: "native-local", disableBuiltinTools: false, toolsets: ["bot"], codexEnvironment: false },
  ] as const,
  [
    "localBrowser",
    kind,
    { mode: "native-local", disableBuiltinTools: false, toolsets: ["bot", "browser"], codexEnvironment: false },
  ] as const,
  // remote host without codex.exec-server: B1 for everyone (Codex falls back to B1)
  [
    "remote",
    kind,
    { mode: "brain-mcp-hands", disableBuiltinTools: true, toolsets: ["bot", "node"], codexEnvironment: false },
  ] as const,
  // remote host with codex.exec-server: Codex E, everyone else B1
  [
    "remoteCodex",
    kind,
    kind === "codex"
      ? { mode: "codex-environment", disableBuiltinTools: false, toolsets: ["bot"], codexEnvironment: true }
      : { mode: "brain-mcp-hands", disableBuiltinTools: true, toolsets: ["bot", "node"], codexEnvironment: false },
  ] as const,
  // capabilities add the browser / computer toolsets
  [
    "remoteBrowser",
    kind,
    {
      mode: "brain-mcp-hands",
      disableBuiltinTools: true,
      toolsets: ["bot", "node", "browser"],
      codexEnvironment: false,
    },
  ] as const,
  [
    "remoteDesktop",
    kind,
    {
      mode: "brain-mcp-hands",
      disableBuiltinTools: true,
      toolsets: ["bot", "node", "browser", "computer"],
      codexEnvironment: false,
    },
  ] as const,
])

describe("placement matrix (D1.5)", () => {
  for (const [hostName, kind, want] of matrix) {
    test(`${hostName} × ${kind} → ${want.mode} [${want.toolsets.join(",")}]`, async () => {
      const host = hosts[hostName]
      const placement = await resolveIn([host], botOn(host.id), kind)
      expect(placement.mode).toBe(want.mode)
      expect(placement.hostNodeId).toBe(host.id)
      expect(placement.disableBuiltinTools).toBe(want.disableBuiltinTools)
      expect([...placement.toolsets] as Array<string>).toEqual([...want.toolsets])
      expect(placement.codexEnvironment !== undefined).toBe(want.codexEnvironment)
      // the harness always runs on the brain, in an existing directory
      expect(placement.harnessCwd).toBe(join(dir.path, "bots", "bot_ada", "workspace"))
      expect(existsSync(placement.harnessCwd)).toBe(true)
      expect(placement.workspacePath).toBe(
        host.id === LOCAL_NODE_ID ? placement.harnessCwd : "/home/u/openbot/workspaces/bot_ada",
      )
      expect(placement.promptAppend).toContain(placement.workspacePath)
      if (want.mode === "brain-mcp-hands") expect(placement.promptAppend).toContain("openbot node tools")
    })
  }
})

describe("placement details", () => {
  test("codex-environment: relay URL on the internal listener, bearer grant, node cwd; release revokes it", () =>
    run(
      Effect.gen(function* () {
        const relays = yield* RelayService
        const scope = yield* Scope.make()
        const placement: ResolvedPlacement = yield* resolve(botOn(REMOTE), "codex", remotePlacementsOf.codex).pipe(
          Scope.provide(scope),
        )
        expect(placement.codexEnvironment).toEqual({
          environmentId: `${REMOTE}-bot_ada`,
          execServerUrl: `ws://127.0.0.1:47999/relay/${REMOTE}/codex.exec-server`,
          authBearerToken: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
          cwd: "/home/u/openbot/workspaces/bot_ada",
        })
        expect(placement.promptAppend).toContain("built-in tools execute there")
        expect(yield* relays.activeGrants).toBe(1)

        // a second session of the same bot shares the grant (an environment/add upsert must not
        // invalidate the first session's token)
        const scope2 = yield* Scope.make()
        const second = yield* resolve(botOn(REMOTE), "codex", remotePlacementsOf.codex).pipe(Scope.provide(scope2))
        expect(second.codexEnvironment?.authBearerToken).toBe(placement.codexEnvironment?.authBearerToken)
        expect(yield* relays.activeGrants).toBe(1)

        yield* placement.release
        expect(yield* relays.activeGrants).toBe(1)
        yield* Scope.close(scope2, Exit.void)
        expect(yield* relays.activeGrants).toBe(0)
        // release is idempotent with the scope closing
        yield* Scope.close(scope, Exit.void)
        expect(yield* relays.activeGrants).toBe(0)
      }).pipe(Effect.provide(layer([hosts.remoteCodex]))),
    ))

  test("bound nodes add the node toolset to native-local and are listed in the prompt", async () => {
    const other = remoteNodeSummary(OTHER, { label: "Build server", status: "offline" })
    const bot = botOn(LOCAL_NODE_ID, { boundNodeIds: [OTHER] })
    const placement = await resolveIn([hosts.local, other], bot, "claude")
    expect(placement.mode).toBe("native-local")
    expect([...placement.toolsets]).toEqual(["bot", "node"])
    expect(placement.promptAppend).toContain(`"Build server" (node: "${OTHER}", linux, offline)`)

    const remoteBot = botOn(REMOTE, { boundNodeIds: [REMOTE, OTHER] })
    const remote = await resolveIn([hosts.remote, other], remoteBot, "opencode")
    expect([...remote.toolsets]).toEqual(["bot", "node"])
    expect(remote.promptAppend).toContain("Build server")
    expect(remote.promptAppend).not.toContain(`node: "${REMOTE}"`)
  })

  test("an offline or unknown host fails with node-unavailable", async () => {
    const offline = remoteNodeSummary(REMOTE, { status: "offline", label: "Laptop" })
    const failed = await run(
      Effect.flip(resolve(botOn(REMOTE), "claude", remotePlacementsOf.claude)).pipe(Effect.provide(layer([offline]))),
    )
    expect(failed).toMatchObject({ _tag: "PlacementError", reason: "node-unavailable", nodeId: REMOTE })
    expect(failed.message).toContain("Laptop")

    const unknown = await run(
      Effect.flip(resolve(botOn("nod_gone" as NodeId), "claude", remotePlacementsOf.claude)).pipe(
        Effect.provide(layer([hosts.local])),
      ),
    )
    expect(unknown).toMatchObject({ _tag: "PlacementError", reason: "node-unavailable", nodeId: "nod_gone" })
  })

  test("a driver that implements no remote placement cannot use a remote host (no faked placements)", async () => {
    const failed = await run(
      Effect.flip(resolve(botOn(REMOTE), "custom", [])).pipe(Effect.provide(layer([hosts.remote]))),
    )
    expect(failed).toMatchObject({ _tag: "PlacementError", reason: "unsupported-placement" })
    // but it still runs on the local node
    const local = await run(Effect.provide(resolve(botOn(LOCAL_NODE_ID), "custom", []), layer([hosts.local])))
    expect(local.mode).toBe("native-local")
  })

  test("a codex driver without codex-environment support falls back to B1 even with exec-server", async () => {
    const placement = await run(
      Effect.provide(resolve(botOn(REMOTE), "codex", ["brain-mcp-hands"]), layer([hosts.remoteCodex])),
    )
    expect(placement.mode).toBe("brain-mcp-hands")
    expect(placement.codexEnvironment).toBeUndefined()
  })
})
