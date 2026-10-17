/**
 * OpenCode `HarnessSession` (architecture §4.5 OpenCode): one native session per (bot, conversation).
 *
 * Open:
 *   1. connect (server up + subscription saw `server.connected`), register this session's route;
 *   2. `session.get` (resume) or `session.create {location: {directory}, metadata, permissions}`;
 *   3. persona as instruction entries (`openbot.*` keys; changed keys only);
 *   4. `mcp.add` per binding (directory-scoped, `type: "remote"`, `codemode: false`), waiting for
 *      `connected`; repeated whenever the server generation changed (restart drops them).
 * Turns: `startTurn` → `session.prompt {delivery: "queue"}`; `steer` → `delivery: "steer"`; a turn
 * ends on `session.execution.*`. Approvals/questions are answered on their own fibers, so the
 * event consumer never blocks. `interrupt` → `session.interrupt` (5 s, best effort).
 *
 * Native busy periods: OpenCode reports ONE `execution.started` / terminal pair per busy period,
 * and a busy period also drains inputs queued while it runs. A prompt is therefore only sent once
 * the session is natively idle (bounded wait), so the terminal of an execution OpenBot no longer
 * tracks (a late interrupt, a compaction) can never end the next OpenBot turn. `compact` waits for
 * its compaction's own terminal for the same reason (and so the context meter reflects it).
 */
import type { ContextUsage, HarnessEvent, HarnessRequestResolution, TurnId } from "@openbot/contracts"
import { isAnswersResolution } from "@openbot/contracts"
import { HarnessError, type HarnessSession, type OpenSessionInput, type TurnInput } from "@openbot/core"
import { Cause, Deferred, Effect, FiberMap, FiberSet, Option, Queue, Schedule, Scope, Semaphore, Stream } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { describeClientError, isNotFoundError, type OpenCodeApi, type OpenCodeEvent, type PermissionRule } from "./client.ts"
import {
  INSTRUCTION_KEY_PREFIX,
  instructionEntries,
  mcpServerName,
  parseModel,
  sessionGrants,
  sessionRules,
} from "./config.ts"
import type { HostConnection, OpenCodeHost } from "./hub.ts"
import { eventSessionId, isTerminalEvent, makeNormalizer, turnErrorOf } from "./normalize.ts"
import {
  decodeForm,
  decodePermission,
  formAnswer,
  formToRequest,
  type NativeForm,
  type NativePermission,
  permissionReply,
  permissionToRequest,
} from "./requests.ts"

export interface SessionOptions {
  /** How long to wait for an added MCP server to report `connected`. Default 10 s. */
  readonly mcpConnectTimeoutMs?: number | undefined
  /**
   * Pause after the OpenBot tools report `connected`, before the first prompt. OpenCode reloads its
   * tool registry 100 ms (debounced) after `mcp.tools.changed`, so a prompt sent right away still
   * lacks the tools (hands-architecture-synthesis.md G5). Default 500 ms.
   */
  readonly mcpSettleMs?: number | undefined
  /** After a successful `session.interrupt`, end the turn locally if no terminal arrived. Default 5 s. */
  readonly interruptGraceMs?: number | undefined
  /** Before prompting, wait this long for a native execution OpenBot does not track to settle. Default 10 s. */
  readonly busyWaitMs?: number | undefined
  /** How long `compact` waits for OpenCode to finish compacting. Default 5 min. */
  readonly compactTimeoutMs?: number | undefined
}

/** A manual compaction in flight (`compact`). */
interface Compacting {
  readonly done: Deferred.Deferred<void, HarnessError>
  /** The compaction's busy period was observed (so its terminal is ours). */
  progressed: boolean
  failure: string | undefined
  summaryChars: number
  model: { readonly providerID: string; readonly id: string } | undefined
}

type Rec = Readonly<Record<string, unknown>>
const rec = (u: unknown): Rec => (typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Rec) : {})
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)

type Inbound =
  | { readonly _tag: "event"; readonly event: OpenCodeEvent }
  | { readonly _tag: "disconnect"; readonly reason: string }

const harnessError = (code: HarnessError["code"], message: string, cause?: unknown, retryable?: boolean) =>
  new HarnessError({
    harness: "opencode",
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(retryable === undefined ? {} : { retryable }),
  })

const call = <A>(
  what: string,
  code: HarnessError["code"],
  thunk: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, HarnessError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => harnessError(code, `OpenCode ${what} failed: ${describeClientError(cause)}`, cause),
  })

const isNotFound = (error: HarnessError): boolean => isNotFoundError(error.cause) || /\b404\b|not.?found/i.test(error.message)

export const openOpenCodeSession = (
  host: OpenCodeHost,
  input: OpenSessionInput,
  options: SessionOptions = {},
): Effect.Effect<HarnessSession, HarnessError, Scope.Scope> =>
  Effect.gen(function*() {
    const directory = input.placement.harnessCwd
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) => harnessError("open-failed", `Cannot create the bot workspace ${directory}: ${describeClientError(cause)}`, cause),
    })

    let conn = yield* host.connection
    const model = parseModel(input.model, input.effort)
    const servers = input.mcp.map((binding) => ({ binding, name: mcpServerName(input.sessionKey, binding.name) }))
    let grants: ReadonlyArray<PermissionRule> = []
    const rules = () =>
      sessionRules({
        disableBuiltinTools: input.placement.disableBuiltinTools,
        mcpServerNames: servers.map((s) => s.name),
        grants,
      })
    const metadata = {
      openbot: { botId: input.bot.id, conversationId: input.conversationId, sessionKey: input.sessionKey },
    }

    // ------------------------------------------------------------------ native session (resume or create)
    const create = call("session.create", "open-failed", (signal) =>
      conn.client.session.create({
        title: `OpenBot · ${input.bot.name}`,
        location: { directory },
        metadata,
        permissions: rules(),
        ...(model ? { model } : {}),
      }, { signal }))
    const found = input.nativeSessionId === undefined
      ? undefined
      : yield* call("session.get", "open-failed", (signal) => conn.client.session.get({ sessionID: input.nativeSessionId! }, { signal })).pipe(
        Effect.map((info) => info as { readonly id: string; readonly location?: { readonly directory?: string } } | undefined),
        Effect.catch((error) =>
          isNotFound(error)
            ? Effect.logWarning(`OpenCode session ${input.nativeSessionId} is gone; starting a new one.`).pipe(Effect.as(undefined))
            : Effect.fail(error)
        ),
      )
    // MCP servers are registered per directory: a session bound elsewhere (placement or workspace
    // changed) would never see this session's OpenBot tools, so it is not resumed.
    const foundDirectory = found?.location?.directory
    const canonical = yield* Effect.promise(() => realpath(directory).catch(() => directory))
    const resumed = found !== undefined && (foundDirectory === undefined || foundDirectory === directory || foundDirectory === canonical)
      ? found
      : undefined
    if (found !== undefined && resumed === undefined) {
      yield* Effect.logWarning(`OpenCode session ${found.id} is bound to ${foundDirectory}, not ${directory}; starting a new one.`)
    }
    const sessionID = resumed?.id ?? (yield* create).id
    if (resumed) {
      // Placement and MCP names may have changed since the session was created.
      yield* call("session.update", "open-failed", (signal) =>
        conn.client.session.update({ sessionID, metadata, permissions: rules() }, { signal }))
      if (model) {
        yield* call("session.switchModel", "open-failed", (signal) => conn.client.session.switchModel({ sessionID, model }, { signal }))
      }
    }

    // ------------------------------------------------------------------ persona (instruction entries)
    const wanted = instructionEntries(input.instructions)
    const existing = yield* call("instructions.entry.list", "open-failed", (signal) =>
      conn.client.session.instructions.entry.list({ sessionID }, { signal }))
    for (const entry of existing) {
      if (entry.key.startsWith(INSTRUCTION_KEY_PREFIX) && !wanted.some((w) => w.key === entry.key)) {
        yield* call("instructions.entry.remove", "open-failed", (signal) =>
          conn.client.session.instructions.entry.remove({ sessionID, key: entry.key }, { signal }))
      }
    }
    for (const entry of wanted) {
      if (existing.some((e) => e.key === entry.key && e.value === entry.value)) continue
      yield* call("instructions.entry.put", "open-failed", (signal) =>
        conn.client.session.instructions.entry.put({ sessionID, key: entry.key, value: entry.value }, { signal }))
    }

    // ------------------------------------------------------------------ MCP registration (per server generation)
    let registeredGeneration = -1
    const registerLock = yield* Semaphore.make(1)
    const mcpConnectTimeoutMs = options.mcpConnectTimeoutMs ?? 10_000
    const mcpSettleMs = options.mcpSettleMs ?? 500
    const registerMcp = (connection: HostConnection) =>
      registerLock.withPermits(1)(Effect.gen(function*() {
        if (registeredGeneration === connection.generation || servers.length === 0) {
          registeredGeneration = connection.generation
          return
        }
        for (const { binding, name } of servers) {
          yield* call("mcp.add", "open-failed", (signal) =>
            connection.client.mcp.add({
              server: name,
              location: { directory },
              config: { type: "remote", url: binding.url, headers: { ...binding.headers }, oauth: false, codemode: false },
            }, { signal }))
        }
        // A prompt sent while a server is still `pending` does not see its tools (sdk-opencode.md §8.3).
        const names = new Set(servers.map((s) => s.name))
        yield* call("mcp.list", "open-failed", (signal) => connection.client.mcp.list({ location: { directory } }, { signal })).pipe(
          Effect.flatMap((out) => {
            const ours = out.data.filter((s) => names.has(s.name))
            const failed = ours.find((s) => s.status.status === "failed" || s.status.status === "needs_auth")
            if (failed) return Effect.fail(harnessError("open-failed", `OpenBot tools failed to connect: ${failed.status.error ?? failed.status.status}`))
            return ours.length === names.size && ours.every((s) => s.status.status === "connected")
              ? Effect.void
              : Effect.fail(harnessError("open-failed", "OpenBot tools are still connecting."))
          }),
          Effect.retry({ while: (e) => e.message === "OpenBot tools are still connecting.", schedule: Schedule.spaced(150) }),
          Effect.timeoutOrElse({
            duration: mcpConnectTimeoutMs,
            orElse: () => Effect.fail(harnessError("open-failed", "Timed out waiting for the OpenBot tools to connect.")),
          }),
          // Let the tool registry pick the new tools up before anything is prompted (G5).
          Effect.andThen(mcpSettleMs > 0 ? Effect.sleep(mcpSettleMs) : Effect.void),
          // OpenBot tools are an addition: the bot can still answer without them.
          Effect.catch((error) => Effect.logWarning(`OpenCode MCP registration incomplete: ${error.message}`)),
        )
        registeredGeneration = connection.generation
      }))
    yield* registerMcp(conn)

    // ------------------------------------------------------------------ events
    const normalizer = makeNormalizer({
      sessionID,
      contextWindow: host.contextWindow,
      hostNodeId: input.placement.hostNodeId,
    })
    const out = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
    const inbound = yield* Queue.unbounded<Inbound>()
    const processing = yield* Semaphore.make(1)
    const requests = yield* FiberMap.make<string>()
    const background = yield* FiberSet.make()
    const emit = (events: ReadonlyArray<HarnessEvent>) => Effect.sync(() => {
      for (const event of events) Queue.offerUnsafe(out, event)
    })

    // ------------------------------------------------------------------ native busy periods & compaction
    let nativeBusy = false
    const idleWaiters: Array<Deferred.Deferred<void>> = []
    let compacting: Compacting | undefined
    const setIdle = () => {
      nativeBusy = false
      for (const waiter of idleWaiters.splice(0)) Deferred.doneUnsafe(waiter, Effect.void)
    }
    const busyWaitMs = options.busyWaitMs ?? 10_000
    /** Waits (bounded) until no native execution is running; never fails. */
    const awaitNativeIdle: Effect.Effect<void> = Effect.suspend(() => {
      if (!nativeBusy) return Effect.void
      const waiter = Deferred.makeUnsafe<void>()
      idleWaiters.push(waiter)
      return Deferred.await(waiter).pipe(Effect.timeoutOption(busyWaitMs), Effect.asVoid)
    })
    const settleCompaction = (c: Compacting, outcome: Effect.Effect<void, HarnessError>) => {
      if (compacting === c) compacting = undefined
      Deferred.doneUnsafe(c.done, outcome)
    }
    /** Lifecycle bookkeeping for one event of THIS session (before normalization). */
    const track = (event: OpenCodeEvent) => {
      const data = rec(event.data)
      const c = compacting
      switch (event.type) {
        case "session.execution.started":
          nativeBusy = true
          if (c) c.progressed = true
          return
        case "session.compaction.started":
          if (c) c.progressed = true
          return
        case "session.compaction.ended": {
          if (!c) return
          c.progressed = true
          c.summaryChars = (str(data.text)?.length ?? 0) + (str(data.recent)?.length ?? 0)
          const ref = rec(data.model)
          const providerID = str(ref.providerID)
          const id = str(ref.id)
          if (providerID && id) c.model = { providerID, id }
          return
        }
        case "session.compaction.failed":
          if (!c) return
          c.progressed = true
          c.failure = str(rec(data.error).message) ?? str(rec(data.error).type) ?? "unknown error"
          return
      }
    }
    /** A terminal of THIS session (after normalization). */
    const terminated = (event: OpenCodeEvent) => {
      setIdle()
      const c = compacting
      // A terminal from before the compaction's busy period (stale execution) is not ours.
      if (!c || !c.progressed) return
      const data = rec(event.data)
      if (c.failure !== undefined) {
        settleCompaction(c, Effect.fail(harnessError("other", `OpenCode could not compact the conversation: ${c.failure}`, undefined, true)))
      } else if (event.type === "session.execution.failed") {
        settleCompaction(c, Effect.fail(harnessError("other", `Compaction failed: ${turnErrorOf(data.error).message}`, undefined, true)))
      } else if (event.type === "session.execution.interrupted") {
        settleCompaction(c, Effect.fail(harnessError("other", "Compaction was interrupted.", undefined, true)))
      } else {
        normalizer.compacted(Math.ceil(c.summaryChars / 4), c.model)
        settleCompaction(c, Effect.void)
      }
    }

    yield* host.register(sessionID, {
      onEvent: (event) => {
        Queue.offerUnsafe(inbound, { _tag: "event", event })
      },
      onDisconnect: (reason) => {
        Queue.offerUnsafe(inbound, { _tag: "disconnect", reason })
      },
    })
    yield* Effect.forkScoped(host.models(directory).pipe(Effect.ignore))

    const liveClient: Effect.Effect<OpenCodeApi, HarnessError> = Effect.flatMap(host.current, (c) =>
      c ? Effect.succeed(c.client) : Effect.fail(harnessError("closed", "The OpenCode server is gone.")))

    // ------------------------------------------------------------------ approvals & questions
    const answerPermission = (permission: NativePermission) =>
      Effect.gen(function*() {
        const key = permission.tool ? normalizer.toolKey(permission.tool.messageID, permission.tool.id) : undefined
        const info = key ? normalizer.toolInfo(key) : undefined
        const request = permissionToRequest(permission, { name: info?.name, input: info?.input, key }, { cwd: directory })
        const resolution: HarnessRequestResolution = yield* input.onRequest(request)
        const plan = permissionReply(resolution)
        const client = yield* liveClient
        if (plan.grant) {
          grants = [...grants, ...sessionGrants(permission.action, permission.save)]
          yield* call("session.update", "other", (signal) => client.session.update({ sessionID, permissions: rules() }, { signal }))
        }
        yield* call("permission.reply", "other", (signal) =>
          client.permission.reply({
            sessionID: permission.sessionID,
            requestID: permission.id,
            decision: plan.decision,
            ...(plan.message !== undefined ? { message: plan.message } : {}),
          }, { signal }))
      }).pipe(Effect.catch((error) => Effect.logWarning(`OpenCode permission ${permission.id}: ${error.message}`)))

    const answerForm = (form: NativeForm) =>
      Effect.gen(function*() {
        const key = form.tool ? normalizer.toolKey(form.tool.messageID, form.tool.id) : undefined
        const resolution = yield* input.onRequest(formToRequest(form, key))
        const client = yield* liveClient
        if (isAnswersResolution(resolution)) {
          yield* call("form.reply", "other", (signal) =>
            client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer: formAnswer(form, resolution.answers) }, { signal }))
        } else {
          const message = resolution.decision === "cancel"
            ? undefined
            : (resolution.message?.trim() || "The user declined to answer. Continue without the answer or ask in a chat message.")
          yield* call("form.cancel", "other", (signal) =>
            client.session.form.cancel({ sessionID: form.sessionID, formID: form.id, ...(message ? { message } : {}) }, { signal }))
        }
      }).pipe(Effect.catch((error) => Effect.logWarning(`OpenCode form ${form.id}: ${error.message}`)))

    // ------------------------------------------------------------------ the single event consumer
    const handle = (item: Inbound): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (item._tag === "disconnect") {
          yield* FiberMap.clear(requests)
          yield* emit(normalizer.failTurn({ code: "closed", message: item.reason, retryable: true }))
          // A stdio server takes its executions with it.
          setIdle()
          if (compacting) settleCompaction(compacting, Effect.fail(harnessError("closed", item.reason, undefined, true)))
          return
        }
        const event = item.event
        switch (event.type) {
          case "permission.asked": {
            const permission = decodePermission(event.data)
            if (permission) yield* FiberMap.run(requests, `per:${permission.id}`, answerPermission(permission))
            break
          }
          case "form.created": {
            const form = decodeForm(event.data)
            if (form) yield* FiberMap.run(requests, `frm:${form.id}`, answerForm(form))
            break
          }
          case "permission.replied": {
            // Answered elsewhere (or by us): stop waiting for OpenBot's decision.
            const id = (event.data as { requestID?: unknown } | undefined)?.requestID
            if (typeof id === "string") yield* FiberMap.remove(requests, `per:${id}`)
            break
          }
          case "form.replied":
          case "form.cancelled": {
            const id = (event.data as { id?: unknown } | undefined)?.id
            if (typeof id === "string") yield* FiberMap.remove(requests, `frm:${id}`)
            break
          }
        }
        const ours = eventSessionId(event) === sessionID
        if (!ours && event.type !== "permission.replied") return
        if (ours) track(event)
        const events = normalizer.apply(event)
        yield* emit(events)
        if (ours && isTerminalEvent(event)) terminated(event)
        if (events.some((e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted")) {
          // The execution is over: pending native requests are moot.
          yield* FiberMap.clear(requests)
        }
      })

    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(Queue.take(inbound), (item) => processing.withPermits(1)(handle(item)))),
    )

    // ------------------------------------------------------------------ turns
    const ensureReady = Effect.gen(function*() {
      conn = yield* host.connection
      yield* registerMcp(conn)
      return conn
    })

    const prompt = (connection: HostConnection, turn: TurnInput, delivery: "queue" | "steer") =>
      Effect.tryPromise({
        try: (signal) =>
          connection.client.session.prompt({
            sessionID,
            text: turn.text,
            delivery,
            ...(turn.attachments.length > 0
              ? { files: turn.attachments.map((a) => ({ uri: pathToFileURL(a.path).href, name: a.name })) }
              : {}),
          }, { signal }),
        catch: (cause) => {
          const message = describeClientError(cause)
          const transport = /Transport|ECONNREFUSED|fetch failed|socket/i.test(message)
          return harnessError(transport ? "closed" : "turn-rejected", `OpenCode rejected the prompt: ${message}`, cause, transport)
        },
      })

    const startTurn = (turn: TurnInput): Effect.Effect<void, HarnessError> =>
      Effect.gen(function*() {
        if (normalizer.activeTurn() !== undefined) {
          return yield* Effect.fail(harnessError("turn-rejected", "A turn is already running in this OpenCode session."))
        }
        const connection = yield* ensureReady
        // Never prompt into a busy period OpenBot does not track (its terminal would end this turn).
        yield* awaitNativeIdle
        // Hold the consumer while prompting so `TurnStarted` precedes the turn's own events.
        yield* processing.withPermits(1)(Effect.gen(function*() {
          if (normalizer.activeTurn() !== undefined) {
            return yield* Effect.fail(harnessError("turn-rejected", "A turn is already running in this OpenCode session."))
          }
          if (compacting !== undefined) {
            return yield* Effect.fail(harnessError("turn-rejected", "OpenCode is compacting this conversation; try again when it is done."))
          }
          normalizer.beginTurn(turn.turnId)
          yield* prompt(connection, turn, "queue").pipe(Effect.tapError(() => Effect.sync(() => normalizer.abandonTurn())))
          yield* emit([{ _tag: "TurnStarted", turnId: turn.turnId }])
        }))
      })

    const steer = (turn: TurnInput): Effect.Effect<void, HarnessError> =>
      Effect.gen(function*() {
        if (normalizer.activeTurn() === undefined) {
          return yield* Effect.fail(harnessError("turn-rejected", "No running turn to steer."))
        }
        const connection = yield* ensureReady
        yield* prompt(connection, turn, "steer")
      })

    const endLocally = (turnId: TurnId) =>
      processing.withPermits(1)(Effect.suspend(() => (normalizer.activeTurn() === turnId ? emit(normalizer.interruptTurn()) : Effect.void)))

    const interruptGraceMs = options.interruptGraceMs ?? 5_000
    const interrupt: Effect.Effect<void> = Effect.gen(function*() {
      const turnId = normalizer.activeTurn()
      if (turnId === undefined) return
      const current = yield* host.current
      const result = current
        ? yield* call("session.interrupt", "other", (signal) => current.client.session.interrupt({ sessionID }, { signal })).pipe(
          Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.fail(harnessError("other", "session.interrupt timed out")) }),
          Effect.option,
        )
        : Option.none()
      if (Option.isSome(result) && result.value.interrupted) {
        // The terminal `execution.interrupted` normally follows; never leave the turn hanging.
        yield* FiberSet.run(background, Effect.sleep(interruptGraceMs).pipe(Effect.andThen(endLocally(turnId))))
      } else {
        // OpenCode says nothing is running: no stale terminal can follow.
        if (Option.isSome(result)) yield* Effect.sync(setIdle)
        // Nothing was running natively (or the server is gone): end the turn here.
        yield* endLocally(turnId)
      }
    })

    const compactTimeoutMs = options.compactTimeoutMs ?? 300_000
    const compact: Effect.Effect<void, HarnessError> = Effect.gen(function*() {
      if (normalizer.activeTurn() !== undefined || compacting !== undefined) {
        return yield* Effect.fail(harnessError("turn-rejected", "The bot is busy in this OpenCode session; compact after the turn ends."))
      }
      const connection = yield* ensureReady
      yield* awaitNativeIdle
      // Registered before the call: the compaction's events can beat the HTTP reply.
      const state: Compacting = { done: Deferred.makeUnsafe(), progressed: false, failure: undefined, summaryChars: 0, model: undefined }
      compacting = state
      yield* call("session.compact", "other", (signal) => connection.client.session.compact({ sessionID }, { signal })).pipe(
        Effect.andThen(Deferred.await(state.done)),
        Effect.timeoutOrElse({
          duration: compactTimeoutMs,
          orElse: () => Effect.fail(harnessError("other", "Timed out waiting for OpenCode to finish compacting.", undefined, true)),
        }),
        Effect.ensuring(Effect.sync(() => {
          if (compacting === state) compacting = undefined
        })),
      )
    })

    // ------------------------------------------------------------------ close
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        const current = yield* host.current
        if (current && normalizer.activeTurn() !== undefined) {
          // Dropping the subscription does not stop OpenCode; interrupt explicitly.
          yield* call("session.interrupt", "other", (signal) => current.client.session.interrupt({ sessionID }, { signal })).pipe(
            Effect.timeout(5_000),
            Effect.ignore,
          )
        }
        if (current && current.generation === registeredGeneration) {
          for (const { name } of servers) {
            yield* call("mcp.remove", "other", (signal) => current.client.mcp.remove({ server: name, location: { directory } }, { signal })).pipe(
              Effect.timeout(5_000),
              Effect.ignore,
            )
          }
        }
        yield* Queue.end(out)
      })
    )

    yield* emit([{ _tag: "SessionBound", nativeSessionId: sessionID }])

    return {
      events: Stream.fromQueue(out),
      nativeSessionId: Effect.succeed(sessionID),
      startTurn,
      steer,
      interrupt,
      compact,
      contextUsage: Effect.sync((): ContextUsage | undefined => normalizer.contextUsage()),
    } satisfies HarnessSession
  })
