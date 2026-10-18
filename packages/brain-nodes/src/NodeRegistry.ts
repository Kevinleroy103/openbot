/**
 * `NodeRegistry` (architecture §4.8): the brain's view of every node.
 *
 * - Node records come from `NodeRepo` (cached in memory; this registry is their only writer) and
 *   live connection state is kept here. Status is derived: a node is `online` while a verified
 *   connection (or the in-process local node) is attached.
 * - Implements the core ports `NodeDirectory` (list/get/changes/client/capabilities) and `NodeAdmin`
 *   (pairing codes, rename, revoke, capability approval). `changes` emits roster-shaped
 *   `node.upserted` / `node.removed` that LiveHub forwards; brain-nodes never depends on LiveHub.
 * - The internal `NodeRegistry` tag is what the node gateway, the local node and the pairing route
 *   use: verify keys, attach/detach connections, pair new nodes, fan out `node.event`s.
 *
 * Layer 0 (interfaces.md §2.3): depends on repositories, `IdGen`, config and the brain identity only.
 */
import type { NodeId, NodeSummary } from "@openbot/contracts"
import { Forbidden, InvalidInput, LOCAL_NODE_ID, NodeUnavailable, NotFound, PairingCode } from "@openbot/contracts"
import { IdGen, NodeAdmin, type NodeClient, NodeDirectory, type NodeDirectoryChange, type NodeRecord, NodeRepo } from "@openbot/core"
import {
  CloseCodes,
  effectiveCapabilities,
  formatCapability,
  formatPairingCode,
  generatePairingCode,
  hashPairingCode,
  isValidPublicKey,
  type NodeHello,
  normalizePairingCode,
  type PairRequest,
  type PairResponse,
  pairingCodeExpiresAt,
  parseCapability,
} from "@openbot/node-protocol"
import { Clock, Context, Effect, Layer, Option, PubSub, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import { hostname as osHostname } from "node:os"
import { BrainIdentity, BrainNodesConfig } from "./config.ts"
import { installCommand } from "./NodeInstall.ts"

// ============================================================================ types

export interface NodeConnection {
  readonly nodeId: NodeId
  /** Increases with every attach; used to ignore stale detaches. */
  readonly connId: number
  readonly client: NodeClient
  readonly hello: NodeHello
  /** Close the transport with a WebSocket close code (no-op for the in-process local node). */
  readonly close: (code: number, reason: string) => Effect.Effect<void>
  readonly connectedAt: number
}

export interface AttachInput {
  readonly nodeId: NodeId
  readonly hello: NodeHello
  readonly client: NodeClient
  readonly close: (code: number, reason: string) => Effect.Effect<void>
}

/** `node.event` as received from a node (`nodeId` from the brain mux stamp). */
export interface NodeEvent {
  readonly nodeId: NodeId
  readonly type: string
  readonly data: unknown
}

/** `POST /node/pair` refused. `status` is the HTTP status to answer with. */
export class PairingRefused extends Schema.TaggedError<PairingRefused>()("PairingRefused", {
  status: Schema.Number,
  reason: Schema.String,
}) {}

/** The node may not attach (unknown, revoked, or the local node is disabled). */
export class AttachRefused extends Schema.TaggedError<AttachRefused>()("AttachRefused", {
  nodeId: Schema.String,
  closeCode: Schema.Number,
  reason: Schema.String,
}) {}

export interface NodeRegistryShape {
  /** The stored record, including revoked nodes (`revokedAt` set). */
  readonly record: (nodeId: string) => Effect.Effect<Option.Option<NodeRecord>>
  /**
   * Attach a verified connection. Replaces (closes with 4000) an older connection of the same node.
   * Updates the record from `hello` (declared capabilities, platform, roots, version, lastSeenAt).
   * The connection is detached when the scope closes.
   */
  readonly attach: (input: AttachInput) => Effect.Effect<NodeConnection, AttachRefused, Scope.Scope>
  readonly connection: (nodeId: string) => Effect.Effect<Option.Option<NodeConnection>>
  /** Completes once `nodeId` has a connection newer than `afterConnId` (tests, server boot). */
  readonly awaitConnection: (nodeId: string, afterConnId?: number) => Effect.Effect<NodeConnection>
  /** Liveness (heartbeat): updates `lastSeenAt` in memory. */
  readonly touch: (nodeId: string) => Effect.Effect<void>
  /** `POST /node/pair`. */
  readonly pair: (request: PairRequest) => Effect.Effect<PairResponse, PairingRefused>
  /** `node.event` fan-out (hot, no replay). */
  readonly events: Stream.Stream<NodeEvent>
  readonly publishEvent: (event: NodeEvent) => Effect.Effect<void>
  /** Summary of a visible node (non-revoked), with live status. */
  readonly summary: (nodeId: string) => Effect.Effect<Option.Option<NodeSummary>>
  /**
   * Close every remote control connection (brain shutdown; nodes redial with backoff). Call it before
   * stopping the public listener: Bun's `server.stop()` waits for open WebSockets.
   */
  readonly closeAll: (code?: number, reason?: string) => Effect.Effect<void>
}

export class NodeRegistry extends Context.Service<NodeRegistry, NodeRegistryShape>()("openbot/brain-nodes/NodeRegistry") {}

// ============================================================================ helpers

/** Canonical, de-duplicated capability names (`browser` → `browser@1`); invalid names are dropped. */
export const normalizeCapabilities = (capabilities: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const c of capabilities) {
    const parsed = parseCapability(c.trim())
    if (parsed === undefined) continue
    const name = formatCapability(parsed)
    if (!out.includes(name)) out.push(name)
  }
  return out
}

const summarize = (record: NodeRecord, connection: NodeConnection | undefined, lastSeenAt: number | undefined): NodeSummary => {
  const seen = lastSeenAt ?? record.lastSeenAt
  return {
    id: record.id,
    label: record.label.trim().length > 0 ? record.label : record.hostname || record.id,
    kind: record.kind,
    status: connection === undefined ? "offline" : "online",
    capabilities: effectiveCapabilities(record.declaredCapabilities, record.approvedCapabilities).effective,
    declaredCapabilities: record.declaredCapabilities,
    platform: record.platform,
    hostname: record.hostname,
    roots: record.roots,
    ...(record.version === undefined ? {} : { version: record.version }),
    // a Mac shares its own screen instead: what it needs are permissions, not desktop programs
    ...(connection?.hello.screen === undefined && connection?.hello.desktop !== undefined && connection.hello.desktop.missing.length > 0
      ? { desktopMissing: connection.hello.desktop.missing }
      : {}),
    ...(connection?.hello.screen !== undefined && connection.hello.screen.missing.length > 0
      ? { screenMissing: connection.hello.screen.missing }
      : {}),
    ...(seen === undefined ? {} : { lastSeenAt: seen as NodeSummary["createdAt"] }),
    createdAt: record.createdAt,
  }
}

const MAX_LABEL = 64

// ============================================================================ live layer

export const makeNodeRegistry = Effect.gen(function*() {
  const repo = yield* NodeRepo
  const ids = yield* IdGen
  const config = yield* BrainNodesConfig
  const identity = yield* BrainIdentity

  const lock = yield* Semaphore.make(1)
  const locked = lock.withPermits(1)
  const records = new Map<NodeId, NodeRecord>()
  for (const r of yield* Effect.orDie(repo.list)) records.set(r.id, r)
  const connections = new Map<NodeId, NodeConnection>()
  const lastSeen = new Map<NodeId, number>()
  let connSeq = 0

  const changes = yield* PubSub.unbounded<NodeDirectoryChange>()
  const events = yield* PubSub.unbounded<NodeEvent>()
  const connectionVersion = yield* SubscriptionRef.make(0)
  yield* Effect.addFinalizer(() => Effect.andThen(PubSub.shutdown(changes), PubSub.shutdown(events)))

  const now = Clock.currentTimeMillis
  const persist = (record: NodeRecord) =>
    Effect.andThen(Effect.orDie(repo.upsert(record)), Effect.sync(() => void records.set(record.id, record)))

  const isVisible = (record: NodeRecord): boolean =>
    record.revokedAt === undefined && (record.kind !== "local" || config.localNode.enabled)

  const summaryOf = (record: NodeRecord): NodeSummary =>
    summarize(record, connections.get(record.id), lastSeen.get(record.id))

  const publishUpsert = (nodeId: NodeId) =>
    Effect.suspend(() => {
      const record = records.get(nodeId)
      if (record === undefined || !isVisible(record)) return Effect.void
      return Effect.asVoid(PubSub.publish(changes, { type: "node.upserted", node: summaryOf(record) }))
    })

  const visibleRecord = (nodeId: string): Option.Option<NodeRecord> => {
    const record = records.get(nodeId as NodeId)
    return record !== undefined && isVisible(record) ? Option.some(record) : Option.none()
  }

  const unavailable = (nodeId: string, message: string) => new NodeUnavailable({ nodeId: nodeId as NodeId, message })

  // ---- the local node record exists whenever the local node is enabled (§3.4)
  if (config.localNode.enabled) {
    const existing = records.get(LOCAL_NODE_ID)
    if (existing === undefined || existing.kind !== "local") {
      yield* persist({
        id: LOCAL_NODE_ID,
        label: config.localNode.label,
        kind: "local",
        declaredCapabilities: [],
        approvedCapabilities: [],
        platform: process.platform,
        hostname: osHostname(),
        roots: [],
        createdAt: (yield* now) as NodeRecord["createdAt"],
      })
    }
  }

  // ---------------------------------------------------------------- NodeDirectory
  const directory = NodeDirectory.of({
    list: Effect.sync(() => [...records.values()].filter(isVisible).map(summaryOf)),
    get: (nodeId) =>
      Effect.suspend(() => {
        const record = visibleRecord(nodeId)
        return Option.isSome(record)
          ? Effect.succeed(summaryOf(record.value))
          : Effect.fail(unavailable(nodeId, `Node ${nodeId} is unknown or was removed`))
      }),
    changes: Stream.fromPubSub(changes),
    client: (nodeId) =>
      Effect.suspend(() => {
        const record = visibleRecord(nodeId)
        if (Option.isNone(record)) return Effect.fail(unavailable(nodeId, `Node ${nodeId} is unknown or was removed`))
        const connection = connections.get(nodeId)
        return connection === undefined
          ? Effect.fail(unavailable(nodeId, `Node ${summaryOf(record.value).label} is offline`))
          : Effect.succeed(connection.client)
      }),
    capabilities: (nodeId) =>
      Effect.suspend(() => {
        const record = visibleRecord(nodeId)
        return Option.isSome(record)
          ? Effect.succeed(summaryOf(record.value).capabilities)
          : Effect.fail(unavailable(nodeId, `Node ${nodeId} is unknown or was removed`))
      }),
  })

  // ---------------------------------------------------------------- NodeAdmin
  const notFound = (nodeId: string) => new NotFound({ entity: "node", id: nodeId })

  const admin = NodeAdmin.of({
    createPairingCode: Effect.gen(function*() {
      const code = generatePairingCode()
      const createdAt = yield* now
      const expiresAt = pairingCodeExpiresAt(createdAt)
      yield* Effect.orDie(
        repo.putPairingCode({
          code: yield* hashPairingCode(code),
          createdAt: createdAt as NodeRecord["createdAt"],
          expiresAt: expiresAt as NodeRecord["createdAt"],
        }),
      )
      const origin = yield* config.brainOrigin
      const display = formatPairingCode(code)
      return PairingCode.make({
        code: display,
        expiresAt: expiresAt as NodeRecord["createdAt"],
        command: config.nodeInstall === undefined
          ? `${config.nodeCommand} pair ${origin} ${display}`
          : installCommand(origin, display),
      })
    }),
    rename: (nodeId, label) =>
      locked(
        Effect.gen(function*() {
          const record = visibleRecord(nodeId)
          if (Option.isNone(record)) return yield* notFound(nodeId)
          const trimmed = label.trim()
          if (trimmed.length === 0) return yield* new InvalidInput({ message: "A computer name cannot be empty" })
          if (trimmed.length > MAX_LABEL) {
            return yield* new InvalidInput({ message: `A computer name is at most ${MAX_LABEL} characters` })
          }
          yield* persist({ ...record.value, label: trimmed })
          yield* publishUpsert(record.value.id)
          return summaryOf(records.get(record.value.id)!)
        }),
      ),
    revoke: (nodeId) =>
      locked(
        Effect.gen(function*() {
          if (nodeId === LOCAL_NODE_ID) {
            return yield* new Forbidden({ reason: "The local node cannot be revoked; disable it with --no-local-node" })
          }
          const record = records.get(nodeId)
          if (record === undefined) return yield* notFound(nodeId)
          if (record.revokedAt !== undefined) return
          yield* persist({ ...record, revokedAt: (yield* now) as NodeRecord["createdAt"] })
          const connection = connections.get(nodeId)
          if (connection !== undefined) {
            connections.delete(nodeId)
            yield* connection.close(CloseCodes.revoked, "node revoked")
            yield* SubscriptionRef.update(connectionVersion, (n) => n + 1)
          }
          yield* PubSub.publish(changes, { type: "node.removed", nodeId })
        }),
      ),
    setCapabilities: (nodeId, approved) =>
      locked(
        Effect.gen(function*() {
          const record = visibleRecord(nodeId)
          if (Option.isNone(record)) return yield* notFound(nodeId)
          const invalid = approved.filter((c) => parseCapability(c.trim()) === undefined)
          if (invalid.length > 0) {
            return yield* new InvalidInput({ message: `Unknown capability name: ${invalid.join(", ")}` })
          }
          yield* persist({ ...record.value, approvedCapabilities: normalizeCapabilities(approved) })
          yield* publishUpsert(record.value.id)
          return summaryOf(records.get(record.value.id)!)
        }),
      ),
  })

  // ---------------------------------------------------------------- internal registry
  // acquireRelease: inserting the connection and registering its detach are one uninterruptible step,
  // so a socket that drops while attaching (route fiber interrupted) can never leave a stale "online"
  const attach = (input: AttachInput) =>
    Effect.acquireRelease(
      locked(
        Effect.gen(function*() {
          const record = records.get(input.nodeId)
          if (record === undefined) {
            return yield* new AttachRefused({ nodeId: input.nodeId, closeCode: CloseCodes.revoked, reason: "unknown node" })
          }
          if (record.revokedAt !== undefined) {
            return yield* new AttachRefused({ nodeId: input.nodeId, closeCode: CloseCodes.revoked, reason: "node revoked" })
          }
          if (record.kind === "local" && !config.localNode.enabled) {
            return yield* new AttachRefused({ nodeId: input.nodeId, closeCode: CloseCodes.revoked, reason: "local node disabled" })
          }
          const at = yield* now
          const declared = normalizeCapabilities(input.hello.capabilities)
          let approved = record.approvedCapabilities
          if (record.kind === "local") {
            // the brain machine is trusted: newly declared capabilities are approved, but a capability
            // the owner switched off (declared before, not approved now) stays off
            const fresh = declared.filter((c) => !record.declaredCapabilities.includes(c))
            approved = normalizeCapabilities([...approved, ...fresh])
          } else if (record.lastSeenAt === undefined && config.autoApproveFirstHello) {
            approved = declared
          }
          yield* persist({
            ...record,
            declaredCapabilities: declared,
            approvedCapabilities: approved,
            platform: input.hello.platform || record.platform,
            hostname: input.hello.hostname || record.hostname,
            roots: input.hello.roots.map((r) => r.path),
            ...(input.hello.version ? { version: input.hello.version } : {}),
            lastSeenAt: at as NodeRecord["createdAt"],
          })
          lastSeen.set(input.nodeId, at)
          const previous = connections.get(input.nodeId)
          const conn: NodeConnection = {
            nodeId: input.nodeId,
            connId: ++connSeq,
            client: input.client,
            hello: input.hello,
            close: input.close,
            connectedAt: at,
          }
          connections.set(input.nodeId, conn)
          if (previous !== undefined) yield* previous.close(CloseCodes.replaced, "replaced by a newer connection")
          yield* publishUpsert(input.nodeId)
          yield* SubscriptionRef.update(connectionVersion, (n) => n + 1)
          return conn
        }),
      ),
      (connection) => detach(connection),
    )

  const detach = (connection: NodeConnection) =>
    locked(
      Effect.gen(function*() {
        if (connections.get(connection.nodeId)?.connId !== connection.connId) return
        connections.delete(connection.nodeId)
        const at = yield* now
        lastSeen.set(connection.nodeId, at)
        const record = records.get(connection.nodeId)
        if (record !== undefined && record.revokedAt === undefined) {
          yield* persist({ ...record, lastSeenAt: at as NodeRecord["createdAt"] })
          yield* publishUpsert(connection.nodeId)
        }
        yield* SubscriptionRef.update(connectionVersion, (n) => n + 1)
      }),
    )

  const pair = (request: PairRequest) =>
    locked(
      Effect.gen(function*() {
        const code = normalizePairingCode(request.code)
        if (code === undefined) return yield* new PairingRefused({ status: 400, reason: "malformed pairing code" })
        if (!isValidPublicKey(request.publicKey)) {
          return yield* new PairingRefused({ status: 400, reason: "publicKey must be a base64url Ed25519 public key" })
        }
        const hostname = request.hostname.trim().slice(0, 255)
        const at = yield* now
        const consumed = yield* Effect.orDie(
          repo.consumePairingCode(yield* hashPairingCode(code), at as NodeRecord["createdAt"]),
        )
        if (Option.isNone(consumed)) {
          return yield* new PairingRefused({ status: 401, reason: "invalid, used or expired pairing code" })
        }
        const existing = Option.getOrUndefined(yield* Effect.orDie(repo.findByPublicKey(request.publicKey)))
        const reuse = existing !== undefined && existing.revokedAt === undefined && existing.kind === "remote"
        const nodeId = reuse ? existing.id : yield* ids.nodeId
        const base: NodeRecord = reuse
          ? existing
          : {
            id: nodeId,
            label: (hostname || "Computer").slice(0, MAX_LABEL),
            kind: "remote",
            publicKey: request.publicKey,
            declaredCapabilities: [],
            approvedCapabilities: [],
            platform: request.platform,
            hostname,
            roots: [],
            createdAt: at as NodeRecord["createdAt"],
          }
        yield* persist({
          ...base,
          platform: request.platform || base.platform,
          hostname: hostname || base.hostname,
          ...(request.nodeVersion ? { version: request.nodeVersion } : {}),
        })
        yield* publishUpsert(nodeId)
        return { nodeId, brainPublicKey: identity.publicKey, brainOrigin: yield* config.brainOrigin }
      }),
    )

  const registry = NodeRegistry.of({
    record: (nodeId) => Effect.sync(() => Option.fromNullishOr(records.get(nodeId as NodeId))),
    attach,
    connection: (nodeId) => Effect.sync(() => Option.fromNullishOr(connections.get(nodeId as NodeId))),
    awaitConnection: (nodeId, afterConnId = 0) =>
      SubscriptionRef.changes(connectionVersion).pipe(
        Stream.filterMap((): Result.Result<NodeConnection, void> => {
          const c = connections.get(nodeId as NodeId)
          return c !== undefined && c.connId > afterConnId ? Result.succeed(c) : Result.failVoid
        }),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
        Effect.orDie,
      ),
    touch: (nodeId) =>
      Effect.flatMap(now, (at) =>
        Effect.sync(() => {
          if (connections.has(nodeId as NodeId)) lastSeen.set(nodeId as NodeId, at)
        })),
    pair,
    events: Stream.fromPubSub(events),
    publishEvent: (event) => Effect.asVoid(PubSub.publish(events, event)),
    summary: (nodeId) => Effect.sync(() => Option.map(visibleRecord(nodeId), summaryOf)),
    closeAll: (code = 1001, reason = "brain shutting down") =>
      Effect.suspend(() =>
        Effect.forEach(
          [...connections.values()].filter((c) => c.nodeId !== LOCAL_NODE_ID),
          (c) => c.close(code, reason),
          { discard: true },
        )
      ),
  })

  return { directory, admin, registry }
})

/**
 * `NodeDirectory` + `NodeAdmin` + the internal `NodeRegistry`, over `NodeRepo`. Layer 0.
 * Requires `BrainNodesConfig` and `BrainIdentity` (for `PairResponse.brainPublicKey`).
 */
export const NodeRegistryLive: Layer.Layer<
  NodeDirectory | NodeAdmin | NodeRegistry,
  never,
  NodeRepo | IdGen | BrainNodesConfig | BrainIdentity
> = Layer.effectContext(
  Effect.map(makeNodeRegistry, ({ admin, directory, registry }) =>
    Context.make(NodeDirectory, directory).pipe(
      Context.add(NodeAdmin, admin),
      Context.add(NodeRegistry, registry),
    )),
)
