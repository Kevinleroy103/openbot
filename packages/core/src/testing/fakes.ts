/**
 * Fakes for the brain-nodes / gateway ports: `NodeDirectory`, `NodeFiles`, `PlacementService`,
 * `McpBindingIssuer`, `ComputerPort` and `Notifier`. Each fake comes with a control service
 * (`*Fake`) that tests use to drive and inspect it.
 */
import type { Bot, Notification, NodeId, NodeSummary } from "@openbot/contracts"
import { LOCAL_NODE_ID, NodeUnavailable, NotFound } from "@openbot/contracts"
import { FsError, PathDenied } from "@openbot/node-protocol"
import { Clock, Context, Effect, Layer, PubSub, Ref, Result, Stream } from "effect"
import type { ComputerStatus } from "@openbot/contracts"
import { type ComputerLeaseChange, ComputerPort } from "../ports/Computer.ts"
import { DataDir } from "../ports/DataDir.ts"
import { PlacementError } from "../ports/errors.ts"
import { IdGen } from "../ports/IdGen.ts"
import { type McpBinding, McpBindingIssuer, type McpClaims } from "../ports/Mcp.ts"
import { type NodeClient, NodeDirectory, type NodeDirectoryChange } from "../ports/NodeDirectory.ts"
import { type NodeDownload, type NodeDownloadError, type NodeDownloadInput, NodeFiles } from "../ports/NodeFiles.ts"
import { Notifier, type NotificationInput } from "../ports/Notifier.ts"
import {
  describePlacement,
  PlacementService,
  planPlacement,
  type ResolvedPlacement,
  workspacePathFor,
} from "../ports/Placement.ts"

// ============================================================================ node summaries

export const localNodeSummary = (overrides?: Partial<NodeSummary>): NodeSummary => ({
  id: LOCAL_NODE_ID,
  label: "This computer",
  kind: "local",
  status: "online",
  capabilities: ["fs@1", "shell@1", "pty@1", "browser@1"],
  declaredCapabilities: ["fs@1", "shell@1", "pty@1", "browser@1"],
  platform: "linux",
  hostname: "brain",
  roots: ["/openbot-test"],
  createdAt: 0,
  ...overrides,
})

export const remoteNodeSummary = (id: string, overrides?: Partial<NodeSummary>): NodeSummary => ({
  id: id as NodeId,
  label: id,
  kind: "remote",
  status: "online",
  capabilities: ["fs@1", "shell@1", "pty@1"],
  declaredCapabilities: ["fs@1", "shell@1", "pty@1"],
  platform: "linux",
  hostname: id,
  roots: [`/home/${id}/openbot`],
  createdAt: 0,
  ...overrides,
})

// ============================================================================ NodeDirectory fake

export class NodeDirectoryFake extends Context.Service<
  NodeDirectoryFake,
  {
    /** Insert or replace a node (publishes `node.upserted` on `changes`). */
    readonly upsert: (node: NodeSummary) => Effect.Effect<void>
    /** Removes a node (publishes `node.removed` on `changes`). */
    readonly remove: (nodeId: NodeId) => Effect.Effect<void>
    /** Sets the RPC client returned by `NodeDirectory.client` (tests usually pass a partial cast). */
    readonly setClient: (nodeId: NodeId, client: NodeClient) => Effect.Effect<void>
  }
>()("openbot/core/testing/NodeDirectoryFake") {
  /**
   * `NodeDirectory` over a mutable map. `client(id)` fails with `NodeUnavailable` when the node is
   * unknown, not online, or has no client set.
   */
  static readonly layer = (options?: {
    readonly nodes?: ReadonlyArray<NodeSummary>
    readonly clients?: ReadonlyArray<readonly [NodeId, NodeClient]>
  }): Layer.Layer<NodeDirectory | NodeDirectoryFake> =>
    Layer.effectContext(
      Effect.gen(function* () {
        const nodes = yield* Ref.make<ReadonlyMap<NodeId, NodeSummary>>(
          new Map((options?.nodes ?? [localNodeSummary()]).map((n) => [n.id, n] as const)),
        )
        const clients = new Map<NodeId, NodeClient>(options?.clients ?? [])
        const changes = yield* PubSub.unbounded<NodeDirectoryChange>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(changes))

        const getNode = (nodeId: NodeId) =>
          Effect.flatMap(Ref.get(nodes), (map) => {
            const node = map.get(nodeId)
            return node === undefined
              ? Effect.fail(new NodeUnavailable({ nodeId, message: `Node ${nodeId} is unknown` }))
              : Effect.succeed(node)
          })
        const online = (nodeId: NodeId) =>
          Effect.flatMap(getNode(nodeId), (node) =>
            node.status === "online"
              ? Effect.succeed(node)
              : Effect.fail(new NodeUnavailable({ nodeId, message: `Node ${node.label} is offline` })),
          )

        const directory = NodeDirectory.of({
          list: Effect.map(Ref.get(nodes), (map) => [...map.values()]),
          get: getNode,
          changes: Stream.fromPubSub(changes),
          client: (nodeId) =>
            Effect.flatMap(online(nodeId), (node) => {
              const client = clients.get(nodeId)
              return client === undefined
                ? Effect.fail(new NodeUnavailable({ nodeId, message: `Node ${node.label} has no client in this test` }))
                : Effect.succeed(client)
            }),
          capabilities: (nodeId) => Effect.map(getNode(nodeId), (node) => node.capabilities),
        })
        const control = NodeDirectoryFake.of({
          upsert: (node) =>
            Ref.update(nodes, (map) => new Map(map).set(node.id, node)).pipe(
              Effect.andThen(PubSub.publish(changes, { type: "node.upserted", node })),
              Effect.asVoid,
            ),
          remove: (nodeId) =>
            Ref.update(nodes, (map) => {
              const next = new Map(map)
              next.delete(nodeId)
              return next
            }).pipe(Effect.andThen(PubSub.publish(changes, { type: "node.removed", nodeId })), Effect.asVoid),
          setClient: (nodeId, client) => Effect.sync(() => void clients.set(nodeId, client)),
        })
        return Context.make(NodeDirectory, directory).pipe(Context.add(NodeDirectoryFake, control))
      }),
    )
}

// ============================================================================ placement rules

/** Re-exported for tests written against the wave-0 testing surface (the rules live in ports). */
export { describePlacement, planPlacement, type PlacementPlan } from "../ports/Placement.ts"

// ============================================================================ PlacementService fake

export interface PlacementRecord {
  readonly botId: Bot["id"]
  readonly placement: ResolvedPlacement
  readonly released: boolean
}

export class PlacementServiceFake extends Context.Service<
  PlacementServiceFake,
  {
    /** Every resolve so far, oldest first; `released` flips when the resolve scope closes. */
    readonly resolutions: Effect.Effect<ReadonlyArray<PlacementRecord>>
  }
>()("openbot/core/testing/PlacementServiceFake") {
  /** Rule-following `PlacementService` (via {@link planPlacement}) over `NodeDirectory` + `DataDir`. */
  static readonly layer: Layer.Layer<PlacementService | PlacementServiceFake, never, NodeDirectory | DataDir> =
    Layer.effectContext(
      Effect.gen(function* () {
        const directory = yield* NodeDirectory
        const dataDir = yield* DataDir
        const records = yield* Ref.make<ReadonlyArray<PlacementRecord>>([])
        const markReleased = (index: number) =>
          Ref.update(records, (all) => all.map((r, i) => (i === index ? { ...r, released: true } : r)))

        const service = PlacementService.of({
          resolve: ({ bot, driver }) =>
            Effect.gen(function* () {
              const hostNode = yield* directory.get(bot.hostNodeId).pipe(
                Effect.mapError(
                  (e) =>
                    new PlacementError({
                      botId: bot.id,
                      nodeId: bot.hostNodeId,
                      reason: "node-unavailable",
                      message: e.message,
                    }),
                ),
              )
              const plan = planPlacement({ bot, driverKind: driver.kind, capabilities: driver.capabilities, hostNode })
              if (Result.isFailure(plan)) return yield* plan.failure
              const brainWorkspace = dataDir.workspaceDir(bot.id)
              const workspacePath = workspacePathFor({ node: hostNode, botId: bot.id, dataDir })
              const index = (yield* Ref.get(records)).length
              const release = markReleased(index)
              const placement: ResolvedPlacement = {
                mode: plan.success.mode,
                hostNodeId: hostNode.id,
                workspacePath,
                harnessCwd: brainWorkspace,
                env: {},
                disableBuiltinTools: plan.success.disableBuiltinTools,
                codexEnvironment:
                  plan.success.mode === "codex-environment"
                    ? {
                        environmentId: `node-${hostNode.id}`,
                        execServerUrl: `ws://127.0.0.1:0/relay/${hostNode.id}/codex.exec-server`,
                        authBearerToken: "test-relay-secret",
                        cwd: workspacePath,
                      }
                    : undefined,
                toolsets: plan.success.toolsets,
                ...(plan.success.sharedScreen ? { sharedScreen: true } : {}),
                promptAppend: describePlacement(plan.success, hostNode, workspacePath),
                release,
              }
              yield* Ref.update(records, (all) => [...all, { botId: bot.id, placement, released: false }])
              yield* Effect.addFinalizer(() => release)
              return placement
            }),
        })
        return Context.make(PlacementService, service).pipe(
          Context.add(PlacementServiceFake, PlacementServiceFake.of({ resolutions: Ref.get(records) })),
        )
      }),
    )
}

// ============================================================================ McpBindingIssuer fake

export interface IssuedBinding {
  readonly token: string
  readonly claims: McpClaims
  readonly binding: McpBinding
  readonly revoked: boolean
}

export class McpBindingIssuerFake extends Context.Service<
  McpBindingIssuerFake,
  {
    /** Every binding issued so far, oldest first; `revoked` flips when the issue scope closes. */
    readonly issued: Effect.Effect<ReadonlyArray<IssuedBinding>>
    /** Claims for a token, if issued and not revoked (what the gateway would accept). */
    readonly verify: (token: string) => Effect.Effect<McpClaims | undefined>
  }
>()("openbot/core/testing/McpBindingIssuerFake") {
  /** Tokens are `test-token-<n>`; URL is `<baseUrl>/mcp/<botId>`. */
  static readonly layer = (options?: {
    readonly baseUrl?: string
  }): Layer.Layer<McpBindingIssuer | McpBindingIssuerFake> =>
    Layer.effectContext(
      Effect.gen(function* () {
        const baseUrl = options?.baseUrl ?? "http://127.0.0.1:0"
        const issued = yield* Ref.make<ReadonlyArray<IssuedBinding>>([])
        const issuer = McpBindingIssuer.of({
          issue: (claims) =>
            Effect.gen(function* () {
              const n = (yield* Ref.get(issued)).length + 1
              const token = `test-token-${n}`
              const binding: McpBinding = {
                name: "openbot",
                url: `${baseUrl}/mcp/${claims.botId}`,
                headers: { Authorization: `Bearer ${token}` },
              }
              yield* Ref.update(issued, (all) => [...all, { token, claims, binding, revoked: false }])
              yield* Effect.addFinalizer(() =>
                Ref.update(issued, (all) => all.map((b) => (b.token === token ? { ...b, revoked: true } : b))),
              )
              return binding
            }),
        })
        const control = McpBindingIssuerFake.of({
          issued: Ref.get(issued),
          verify: (token) =>
            Effect.map(Ref.get(issued), (all) => {
              const found = all.find((b) => b.token === token && !b.revoked)
              return found?.claims
            }),
        })
        return Context.make(McpBindingIssuer, issuer).pipe(Context.add(McpBindingIssuerFake, control))
      }),
    )
}

// ============================================================================ ComputerPort fake

export class ComputerPortFake extends Context.Service<
  ComputerPortFake,
  {
    readonly set: (status: ComputerStatus) => Effect.Effect<void>
    /** `lease` calls (`{botId, take}`), oldest first. */
    readonly leases: Effect.Effect<ReadonlyArray<{ readonly botId: Bot["id"]; readonly take: boolean }>>
    /** `reset` calls, oldest first. */
    readonly resets: Effect.Effect<ReadonlyArray<Bot["id"]>>
  }
>()("openbot/core/testing/ComputerPortFake") {
  /**
   * `status` → "absent" until `ensure`, which makes it "ready" on the given node. `lease` and `reset`
   * publish `leaseChanges` when the holder changes; `reset` makes the screen "absent" again.
   */
  static readonly layer: Layer.Layer<ComputerPort | ComputerPortFake> = Layer.effectContext(
    Effect.gen(function* () {
      const statuses = yield* Ref.make<ReadonlyMap<string, ComputerStatus>>(new Map())
      const leaseCalls = yield* Ref.make<ReadonlyArray<{ readonly botId: Bot["id"]; readonly take: boolean }>>([])
      const resetCalls = yield* Ref.make<ReadonlyArray<Bot["id"]>>([])
      const changes = yield* PubSub.unbounded<ComputerLeaseChange>()
      const current = (botId: Bot["id"]): Effect.Effect<ComputerStatus> =>
        Effect.map(
          Ref.get(statuses),
          (map) =>
            map.get(botId) ?? { botId, nodeId: LOCAL_NODE_ID, state: "absent", surface: "browser", controller: "bot" },
        )
      const put = (status: ComputerStatus) => Ref.update(statuses, (map) => new Map(map).set(status.botId, status))
      const port = ComputerPort.of({
        status: current,
        ensure: (botId) =>
          Effect.gen(function* () {
            const status: ComputerStatus = {
              ...(yield* current(botId)),
              state: "ready",
              viewPath: `/ws/computer/${botId}`,
            }
            yield* put(status)
            return status
          }),
        lease: (botId, take) =>
          Effect.gen(function* () {
            yield* Ref.update(leaseCalls, (all) => [...all, { botId, take }])
            const before = yield* current(botId)
            if (before.state !== "ready") return yield* new NotFound({ entity: "computer", id: botId })
            const status: ComputerStatus = { ...before, controller: take ? "user" : "bot" }
            yield* put(status)
            if (status.controller !== before.controller) {
              yield* PubSub.publish(changes, {
                botId,
                holder: status.controller,
                cause: "lease",
              } satisfies ComputerLeaseChange)
            }
            return status
          }),
        reset: (botId) =>
          Effect.gen(function* () {
            yield* Ref.update(resetCalls, (all) => [...all, botId])
            const before = yield* current(botId)
            const status: ComputerStatus = { ...before, state: "absent", controller: "bot" }
            yield* put(status)
            if (before.controller === "user") {
              yield* PubSub.publish(changes, { botId, holder: "bot", cause: "reset" } satisfies ComputerLeaseChange)
            }
            return status
          }),
        leaseChanges: Stream.fromPubSub(changes),
      })
      return Context.make(ComputerPort, port).pipe(
        Context.add(
          ComputerPortFake,
          ComputerPortFake.of({ set: put, leases: Ref.get(leaseCalls), resets: Ref.get(resetCalls) }),
        ),
      )
    }),
  )
}

// ============================================================================ Notifier fake

export class NotifierFake extends Context.Service<
  NotifierFake,
  {
    readonly sent: Effect.Effect<ReadonlyArray<Notification>>
  }
>()("openbot/core/testing/NotifierFake") {
  /** Records notifications (requires `IdGen`). */
  static readonly layer: Layer.Layer<Notifier | NotifierFake, never, IdGen> = Layer.effectContext(
    Effect.gen(function* () {
      const ids = yield* IdGen
      const sent = yield* Ref.make<ReadonlyArray<Notification>>([])
      const notifier = Notifier.of({
        notify: (input: NotificationInput) =>
          Effect.gen(function* () {
            const notification: Notification = {
              id: yield* ids.notificationId,
              kind: input.kind,
              title: input.title,
              body: input.body,
              at: yield* Clock.currentTimeMillis,
              ...(input.botId === undefined ? {} : { botId: input.botId }),
              ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
            }
            yield* Ref.update(sent, (all) => [...all, notification])
            return notification
          }),
      })
      return Context.make(Notifier, notifier).pipe(Context.add(NotifierFake, NotifierFake.of({ sent: Ref.get(sent) })))
    }),
  )
}

// ============================================================================ NodeFiles fake

/** Normalizes a POSIX path (`.`/`..` segments); relative paths are joined with `cwd`. */
const resolveFakePath = (path: string, cwd: string | undefined): string => {
  const joined = path.startsWith("/") ? path : `${(cwd ?? "/").replace(/\/+$/, "")}/${path}`
  const out: Array<string> = []
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}

export class NodeFilesFake extends Context.Service<
  NodeFilesFake,
  {
    /** Puts a file on a node (absolute path). */
    readonly put: (nodeId: NodeId, path: string, bytes: Uint8Array) => Effect.Effect<void>
    /** Every download request, oldest first. */
    readonly requests: Effect.Effect<ReadonlyArray<NodeDownloadInput>>
    /** A file on a node (put by a test or uploaded by the brain). */
    readonly file: (nodeId: NodeId, path: string) => Effect.Effect<Uint8Array | undefined>
    /** Every upload (path + whether it was skipped), oldest first. */
    readonly uploads: Effect.Effect<
      ReadonlyArray<{ readonly nodeId: NodeId; readonly path: string; readonly skipped: boolean }>
    >
  }
>()("openbot/core/testing/NodeFilesFake") {
  /**
   * `NodeFiles` over an in-memory file map per node. Relative paths join `cwd`; a missing file fails
   * with `FsError{code: "ENOENT"}`, one over `maxBytes` with `EFBIG`, a path containing `/denied/`
   * with `PathDenied`. Chunks are 64 KiB slices. `upload` stores the bytes (a same-size file is
   * kept: `skipped`); a path containing `/denied/` fails with `PathDenied`; node `nod_offline` with
   * `NodeUnavailable`.
   */
  static readonly layer: Layer.Layer<NodeFiles | NodeFilesFake> = Layer.effectContext(
    Effect.sync(() => {
      const files = new Map<string, Uint8Array>()
      const requests: Array<NodeDownloadInput> = []
      const uploads: Array<{ readonly nodeId: NodeId; readonly path: string; readonly skipped: boolean }> = []
      const service = NodeFiles.of({
        upload: (input) =>
          Effect.gen(function* () {
            if (input.nodeId === "nod_offline") {
              return yield* new NodeUnavailable({ nodeId: input.nodeId, message: "Node nod_offline is offline" })
            }
            if (input.path.includes("/denied/"))
              return yield* new PathDenied({ path: input.path, reason: "outside the node's roots" })
            const key = `${input.nodeId}\u0000${input.path}`
            const existing = files.get(key)
            if (existing !== undefined && existing.byteLength === input.size) {
              uploads.push({ nodeId: input.nodeId, path: input.path, skipped: true })
              return { path: input.path, size: input.size, skipped: true }
            }
            const parts = yield* Stream.runCollect(input.chunks)
            const data = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0))
            let at = 0
            for (const part of parts) {
              data.set(part, at)
              at += part.byteLength
            }
            files.set(key, data)
            uploads.push({ nodeId: input.nodeId, path: input.path, skipped: false })
            return { path: input.path, size: data.byteLength, skipped: false }
          }),
        download: (input) =>
          Effect.suspend((): Effect.Effect<NodeDownload, NodeDownloadError> => {
            requests.push(input)
            const path = resolveFakePath(input.path, input.cwd)
            if (path.includes("/denied/"))
              return Effect.fail(new PathDenied({ path: input.path, reason: "outside the node's roots" }))
            const data = files.get(`${input.nodeId}\u0000${path}`)
            if (data === undefined) {
              return Effect.fail(
                new FsError({ op: "download", path: input.path, code: "ENOENT", reason: "no such file" }),
              )
            }
            if (data.byteLength > input.maxBytes) {
              return Effect.fail(
                new FsError({
                  op: "download",
                  path: input.path,
                  code: "EFBIG",
                  reason: `the file is larger than ${input.maxBytes} bytes`,
                }),
              )
            }
            const slices: Array<Uint8Array> = []
            for (let at = 0; at < data.byteLength; at += 65_536) slices.push(data.slice(at, at + 65_536))
            return Effect.succeed({
              path,
              name: path.split("/").pop() ?? path,
              size: data.byteLength,
              mtimeMs: 0,
              head: data.slice(0, 4096),
              chunks: Stream.fromIterable(slices),
            })
          }),
      })
      return Context.make(NodeFiles, service).pipe(
        Context.add(
          NodeFilesFake,
          NodeFilesFake.of({
            put: (nodeId, path, bytes) => Effect.sync(() => void files.set(`${nodeId}\u0000${path}`, bytes.slice())),
            requests: Effect.sync(() => [...requests]),
            file: (nodeId, path) => Effect.sync(() => files.get(`${nodeId}\u0000${path}`)?.slice()),
            uploads: Effect.sync(() => [...uploads]),
          }),
        ),
      )
    }),
  )
}
