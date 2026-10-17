/**
 * Orchestrator (architecture §4.3, §4.3.1, §5.1): `messages.send`, group routing of owner messages,
 * deliveries to the per-bot `BotRunner`s (one mind per bot, D5.0: one runner and one native session
 * per bot, shared by all of its conversations), interrupts, New session / Compact, group deletion,
 * gateway tool approvals, delivery outcomes and the boot recovery hook.
 *
 * - Runners live in the layer scope and evict themselves after 15 idle minutes. Different bots run
 *   in parallel; one bot runs one turn at a time.
 * - Delivery outcomes are kept in memory (they do not survive a restart, D2.5); resolved outcomes
 *   stay available to `awaitDelivery` for a bounded window.
 * - The layer drains `ApprovalService.asyncAnswers` (answers to `ask_user` / `request_approval`)
 *   into deliveries for the asking bot, which keeps ApprovalService independent of this layer.
 */
import type {
  Bot,
  BotId,
  Conversation,
  ConversationId,
  EntryId,
  HarnessApprovalRequest,
  HarnessRequestResolution,
  KnownTranscriptEntry,
  SendInput,
  SendResult,
  TranscriptEntry,
  Turn,
  TurnId,
} from "@openbot/contracts"
import {
  ANSWERED_IN_CHAT,
  HarnessUnavailable,
  InvalidInput,
  isTerminalTurnStatus,
  NotFound,
  OWNER_USER_ID,
} from "@openbot/contracts"
import { Cause, Clock, Deferred, Effect, Layer, Option, Semaphore, Stream } from "effect"
import { HarnessRegistry } from "../../ports/Harness.ts"
import { CoreIdPrefix, IdGen } from "../../ports/IdGen.ts"
import { McpBindingIssuer } from "../../ports/Mcp.ts"
import { NodeFiles } from "../../ports/NodeFiles.ts"
import { Notifier } from "../../ports/Notifier.ts"
import type { BootRecoveryReport } from "../../ports/Persistence.ts"
import { PlacementService } from "../../ports/Placement.ts"
import { BotRepo, ConversationRepo, EntryRepo, type ReplicaLog, RequestRepo, TurnRepo } from "../../ports/repos.ts"
import {
  ApprovalService,
  BackgroundTasks,
  ConversationService,
  type Delivery,
  type DeliveryInput,
  type DeliveryOutcome,
  type DeliveryReceipt,
  type EntryDraft,
  InstructionRenderer,
  LiveHub,
  Orchestrator,
  SendFileLimits,
  SettingsService,
  type ToolContext,
  UsageService,
} from "../../ports/services.ts"
import { AttachmentStore } from "../../ports/stores.ts"
import { toAttachment } from "./AttachmentService.ts"
import { DEFAULT_RUNNER_OPTIONS, type DeliveryOutcomes, makeRunner, type Runner, type RunnerOptions } from "./BotRunner.ts"
import { routeOwnerMessage } from "./GroupRouter.ts"
import { ConversationStore, ConversationStoreLive } from "./internal/ConversationStore.ts"
import { compact, conversationBotIds, orDie, required } from "./internal/util.ts"

/** Attachments per message (Grok desktop: 6). */
export const MAX_MESSAGE_ATTACHMENTS = 6
/** Upper bound for one owner message (characters). */
export const MAX_MESSAGE_CHARS = 100_000
/** Resolved delivery outcomes kept for late `awaitDelivery` calls. */
const RESOLVED_OUTCOMES_KEPT = 2_000
/** Attempts to hand a delivery to a runner that keeps getting evicted underneath us. */
const RUNNER_ATTEMPTS = 3

const denyAll: HarnessRequestResolution = { decision: "deny" }

const makeOrchestrator = (options: RunnerOptions) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const hub = yield* LiveHub
    const conversationService = yield* ConversationService
    const store = yield* ConversationStore
    const approvals = yield* ApprovalService
    const tasks = yield* BackgroundTasks
    const renderer = yield* InstructionRenderer
    const settings = yield* SettingsService
    const usage = yield* UsageService
    const notifier = yield* Notifier
    const registry = yield* HarnessRegistry
    const placement = yield* PlacementService
    const issuer = yield* McpBindingIssuer
    const ids = yield* IdGen
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const entries = yield* EntryRepo
    const turns = yield* TurnRepo
    const attachments = yield* AttachmentStore
    const nodeFiles = yield* NodeFiles
    const sendLimits = yield* SendFileLimits

    // ------------------------------------------------------------------ delivery outcomes

    const outcomes = new Map<string, Deferred.Deferred<DeliveryOutcome>>()
    const resolvedOrder: Array<string> = []

    const outcomeFor = (deliveryId: string) =>
      Effect.gen(function*() {
        const existing = outcomes.get(deliveryId)
        if (existing !== undefined) return existing
        const created = yield* Deferred.make<DeliveryOutcome>()
        outcomes.set(deliveryId, created)
        return created
      })

    const deliveryOutcomes: DeliveryOutcomes = {
      register: (deliveryId) => Effect.asVoid(outcomeFor(deliveryId)),
      resolve: (deliveryId, outcome) =>
        Effect.gen(function*() {
          const deferred = yield* outcomeFor(deliveryId)
          const completed = yield* Deferred.succeed(deferred, compact({ ...outcome, deliveryId }))
          if (!completed) return
          resolvedOrder.push(deliveryId)
          while (resolvedOrder.length > RESOLVED_OUTCOMES_KEPT) outcomes.delete(resolvedOrder.shift()!)
        }),
    }

    // ------------------------------------------------------------------ runners

    const runners = new Map<string, Runner>()
    const runnerLock = yield* Semaphore.make(1)

    const runnersOf = (filter: (runner: Runner) => boolean) => [...runners.values()].filter(filter)

    const forget = (runner: Runner) =>
      Effect.sync(() => {
        if (runners.get(runner.botId) === runner) runners.delete(runner.botId)
      })

    // `deliver` is referenced by runners (group follow-ups) before it is defined below.
    let deliverRef: (input: DeliveryInput) => Effect.Effect<DeliveryReceipt, NotFound | HarnessUnavailable> = () =>
      Effect.die(new Error("Orchestrator not ready"))

    const runnerDeps = {
      ids,
      bots,
      conversations,
      entries,
      turns,
      attachments,
      nodeFiles,
      maxFileBytes: sendLimits.maxFileBytes,
      registry,
      placement,
      issuer,
      renderer,
      approvals,
      conversationService,
      store,
      hub,
      usage,
      notifier,
      settings,
      outcomes: deliveryOutcomes,
      followUp: (input: DeliveryInput) =>
        deliverRef(input).pipe(
          Effect.catch((error) => Effect.logWarning(`Orchestrator: follow-up delivery to ${input.botId} failed`, error)),
          Effect.asVoid,
        ),
      onEvicted: forget,
      scope,
      options,
    }

    /** The bot's one runner (created on demand). */
    const runnerFor = (botId: BotId) =>
      runnerLock.withPermits(1)(Effect.gen(function*() {
        const existing = runners.get(botId)
        if (existing !== undefined) return existing
        const runner = yield* makeRunner(runnerDeps, botId)
        runners.set(botId, runner)
        return runner
      }))

    const existingRunner = (botId: BotId) => Effect.sync(() => Option.fromNullishOr(runners.get(botId)))

    // ------------------------------------------------------------------ helpers

    const getBot = (botId: BotId) => required(bots.get(botId), "bot", botId)

    const requireMember = (conversation: Conversation, botId: BotId) =>
      conversationBotIds(conversation).includes(botId)
        ? Effect.void
        : Effect.fail(new NotFound({ entity: "conversation-member", id: `${botId} in ${conversation.id}` }))

    const publishTurn = (turn: Turn) =>
      Effect.gen(function*() {
        yield* orDie(turns.upsert(turn))
        yield* hub.publishConversation(turn.conversationId, { type: "turn.upserted", turn })
      })

    // ------------------------------------------------------------------ deliver

    const deliver = Effect.fn("Orchestrator.deliver")(function*(input: DeliveryInput) {
      const conversation = yield* store.get(input.conversationId)
      const bot = yield* getBot(input.botId)
      yield* requireMember(conversation, bot.id)
      const driver = yield* registry.get(bot.harness.kind, bot.harness.profileId)
      const id = input.id ?? (yield* ids.next(CoreIdPrefix.delivery))
      const delivery: Delivery = compact({
        ...input,
        id,
        mode: input.mode ?? "auto",
        attachmentIds: input.attachmentIds ?? [],
        causalChain: input.causalChain ?? { rootId: id, hops: 0 },
      })
      for (let attempt = 0;; attempt++) {
        const runner = yield* runnerFor(bot.id)
        const receipt = yield* runner.deliver(delivery, driver.capabilities)
        if (receipt !== "closed") return receipt
        yield* forget(runner)
        if (attempt + 1 >= RUNNER_ATTEMPTS) {
          return yield* Effect.die(new Error(`Orchestrator: no runner accepted delivery ${id}`))
        }
      }
    })
    deliverRef = deliver

    // ------------------------------------------------------------------ send

    const sendLock = yield* Semaphore.make(1)

    const resolveTargets = (conversation: Conversation, input: SendInput, replyTo: TranscriptEntry | undefined) =>
      Effect.gen(function*() {
        if (conversation.kind !== "group") {
          return { botIds: [conversation.botId] as ReadonlyArray<BotId>, addressed: undefined }
        }
        const members = (yield* Effect.forEach(conversation.memberBotIds, (id) => orDie(bots.get(id))))
          .flatMap((b): Array<Bot> => (Option.isSome(b) ? [b.value] : []))
        const route = routeOwnerMessage({
          group: conversation,
          members,
          text: input.text,
          addressedBotIds: input.addressedBotIds,
          addressEveryone: input.addressEveryone,
          replyTo,
        })
        return {
          botIds: route.botIds,
          addressed: route.reason === "mentions" || route.reason === "everyone" ? route.botIds : undefined,
        }
      })

    const send = Effect.fn("Orchestrator.send")(function*(input: SendInput) {
      const conversation = yield* store.get(input.conversationId)
      const attachmentIds = input.attachmentIds ?? []
      if (input.text.trim() === "" && attachmentIds.length === 0) {
        return yield* new InvalidInput({ message: "A message needs text or an attachment." })
      }
      if (input.text.length > MAX_MESSAGE_CHARS) {
        return yield* new InvalidInput({ message: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` })
      }
      if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
        return yield* new InvalidInput({ message: `A message can carry at most ${MAX_MESSAGE_ATTACHMENTS} attachments.` })
      }

      const accepted = yield* sendLock.withPermits(1)(Effect.gen(function*() {
        const duplicate = yield* orDie(entries.findByClientNonce(conversation.id, input.clientNonce))
        if (Option.isSome(duplicate)) {
          return { _tag: "duplicate" as const, entryId: duplicate.value.id }
        }
        const files = yield* Effect.forEach(
          attachmentIds,
          (id) => Effect.map(required(attachments.get(id), "attachment", id), toAttachment),
        )
        let replyTo: TranscriptEntry | undefined
        if (input.replyToId !== undefined) {
          const found = yield* orDie(entries.get(input.replyToId))
          if (Option.isNone(found) || found.value.conversationId !== conversation.id) {
            return yield* new NotFound({ entity: "entry", id: input.replyToId })
          }
          replyTo = found.value
        }
        const targets = yield* resolveTargets(conversation, input, replyTo)
        // Fail before persisting when a target bot cannot run at all.
        for (const botId of targets.botIds) {
          const bot = yield* getBot(botId)
          yield* registry.get(bot.harness.kind, bot.harness.profileId)
        }
        const draft: EntryDraft = compact({
          kind: "message" as const,
          conversationId: conversation.id,
          author: { kind: "user" as const, userId: OWNER_USER_ID },
          role: "user" as const,
          text: input.text,
          attachments: files,
          streaming: false,
          clientNonce: input.clientNonce,
          delivery: "accepted" as const,
          replyToId: input.replyToId,
          addressedBotIds: targets.addressed,
        })
        const entry = yield* conversationService.appendEntry(draft)
        return { _tag: "accepted" as const, entryId: entry.id as EntryId, targets: targets.botIds }
      }))

      if (accepted._tag === "duplicate") {
        const result: SendResult = { entryId: accepted.entryId, turnIds: [], disposition: "duplicate" }
        return result
      }

      // Writing in a DM instead of on an open question card answers it ("Or answer in the chat"):
      // the card closes, and the Bot reads the message as the answer.
      if (conversation.kind === "direct") {
        yield* approvals.cancelPending({
          conversationId: conversation.id,
          kinds: ["question"],
          asyncOnly: true,
          reason: ANSWERED_IN_CHAT,
          cardDetail: "Answered in chat",
        })
      }

      const receipts: Array<DeliveryReceipt> = []
      let firstError: NotFound | HarnessUnavailable | undefined
      for (const botId of accepted.targets) {
        const receipt = yield* Effect.result(deliver({
          conversationId: conversation.id,
          botId,
          kind: "user-message",
          text: input.text,
          attachmentIds,
          sourceEntryId: accepted.entryId,
          urgency: "urgent",
          mode: input.mode ?? "auto",
        }))
        if (receipt._tag === "Success") receipts.push(receipt.success)
        else firstError ??= receipt.failure
      }
      if (receipts.length === 0 && firstError !== undefined) {
        yield* Effect.ignore(conversationService.updateEntry(accepted.entryId, (entry) =>
          entry.kind === "message" ? { ...entry, delivery: "failed" } : entry))
        return yield* firstError
      }
      const turnIds = receipts.flatMap((r): Array<TurnId> => (r.turnId === undefined ? [] : [r.turnId]))
      const disposition: SendResult["disposition"] = receipts.some((r) => r.disposition === "started")
        ? "started"
        : receipts.length > 0 && receipts.every((r) => r.disposition === "steered")
        ? "steered"
        : "queued"
      const result: SendResult = { entryId: accepted.entryId, turnIds, disposition }
      return result
    })

    // ------------------------------------------------------------------ interrupt

    const interrupt = Effect.fn("Orchestrator.interrupt")(function*(input: {
      readonly conversationId: ConversationId
      readonly turnId?: TurnId | undefined
    }) {
      const conversation = yield* store.get(input.conversationId)
      if (input.turnId === undefined) {
        // Each member bot: its running turn if it is in THIS conversation, else its queued turns here.
        const members = new Set(conversationBotIds(conversation))
        const affected = yield* Effect.forEach(
          runnersOf((r) => members.has(r.botId)),
          (runner) => runner.interruptConversation(conversation.id),
        )
        return affected.flat()
      }
      const turn = yield* required(turns.get(input.turnId), "turn", input.turnId)
      if (turn.conversationId !== input.conversationId) {
        return yield* new NotFound({ entity: "turn", id: input.turnId })
      }
      const runner = yield* existingRunner(turn.botId)
      if (Option.isSome(runner)) {
        const affected = yield* runner.value.interruptTurn(turn.id)
        if (affected.length > 0 || isTerminalTurnStatus(turn.status)) return affected
      }
      if (isTerminalTurnStatus(turn.status)) return []
      // A stale active turn with nobody running it (should only follow a crash): close it.
      const closed: Turn = { ...turn, status: "interrupted", endedAt: yield* Clock.currentTimeMillis, stopReason: "interrupted" }
      yield* publishTurn(closed)
      return [closed]
    })

    // ------------------------------------------------------------------ sessions (one per bot)

    const newSession = Effect.fn("Orchestrator.newSession")(function*(input: { readonly botId: BotId }) {
      const bot = yield* getBot(input.botId)
      const home = bot.directConversationId
      const afterDrop = Effect.gen(function*() {
        yield* orDie(bots.clearSession(bot.id))
        const epoch = yield* hub.resetConversation(home, "new-session")
        const now = yield* Clock.currentTimeMillis
        yield* Effect.ignore(store.update(home, (c) => {
          const rows = c.sessions ?? []
          const others = rows.filter((r) => r.botId !== bot.id)
          return { ...c, epoch, sessions: [...others, { botId: bot.id, active: false, updatedAt: now }] }
        }))
        yield* Effect.ignore(conversationService.appendEvent({
          conversationId: home,
          event: { type: "session-changed", botId: bot.id, action: "new-session" },
        }))
      })
      // Hold the registry lock so no runner for this bot is created while the session is reset.
      yield* runnerLock.withPermits(1)(Effect.gen(function*() {
        const runner = runners.get(bot.id)
        if (runner === undefined) yield* afterDrop
        else yield* runner.resetSession(afterDrop)
      }))
    })

    const compactSession = Effect.fn("Orchestrator.compact")(function*(input: { readonly botId: BotId }) {
      const bot = yield* getBot(input.botId)
      const driver = yield* registry.get(bot.harness.kind, bot.harness.profileId)
      if (!driver.capabilities.compact) {
        return yield* new HarnessUnavailable({
          harness: bot.harness.kind,
          message: `${driver.displayName} cannot compact a session.`,
        })
      }
      const runner = yield* runnerFor(bot.id)
      yield* runner.compact
      yield* Effect.ignore(conversationService.appendEvent({
        conversationId: bot.directConversationId,
        event: { type: "session-changed", botId: bot.id, action: "compacted" },
      }))
    })

    // ------------------------------------------------------------------ delete a group

    const deleteConversation = Effect.fn("Orchestrator.deleteConversation")(function*(conversationId: ConversationId) {
      const conversation = yield* store.get(conversationId)
      if (conversation.kind !== "group") {
        return yield* new InvalidInput({
          message: "Only group chats can be deleted. A bot's direct chat is deleted with the bot.",
        })
      }
      // Members stop working here (their running turn in this group, their queued turns for it).
      const members = new Set(conversation.memberBotIds)
      yield* Effect.forEach(runnersOf((r) => members.has(r.botId)), (runner) => runner.cancelConversation(conversationId), {
        discard: true,
        concurrency: "unbounded",
      })
      // Background work started there stops too (nobody is told: the group is gone).
      yield* tasks.cancelForConversation(conversationId)
      yield* approvals.cancelPending({ conversationId, reason: "conversation-deleted" })
      yield* conversationService.removeGroup(conversationId)
    })

    // ------------------------------------------------------------------ approvals of gateway tools

    const approveToolCall = (tool: ToolContext, request: HarnessApprovalRequest) =>
      Effect.gen(function*() {
        const { botId, conversationId } = tool.claims
        // The workspace the gateway session was issued for (host node), for autonomy "workspace".
        const workspace = { nodeId: tool.claims.hostNodeId, path: tool.claims.workspacePath }
        // A background task's call: its card is labelled and the answer goes back to its session.
        const taskId = tool.taskId ?? tool.claims.taskId
        if (taskId !== undefined) return yield* tasks.approve(taskId, request, workspace)
        const runner = yield* existingRunner(botId)
        if (Option.isSome(runner)) return yield* runner.value.approve(request, workspace)
        const bot = yield* orDie(bots.get(botId))
        if (Option.isNone(bot)) return denyAll
        return yield* approvals.evaluate(
          { bot: bot.value, conversationId, turnId: tool.turnId, harness: bot.value.harness.kind, workspace },
          request,
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Orchestrator.approveToolCall failed; denying", cause).pipe(Effect.as(denyAll))
        ),
      )

    // ------------------------------------------------------------------ boot recovery

    const recover = (report: BootRecoveryReport) =>
      Effect.gen(function*() {
        const touched = new Set<ConversationId>()
        for (const turn of report.interruptedTurns) {
          yield* hub.publishConversation(turn.conversationId, { type: "turn.upserted", turn })
          touched.add(turn.conversationId)
        }
        for (const request of report.expiredRequests) {
          yield* hub.publishConversation(request.conversationId, { type: "request.upserted", request })
          touched.add(request.conversationId)
        }
        for (const entry of report.updatedEntries) {
          if (entry.kind === "unknown") continue
          yield* hub.publishConversation(entry.conversationId, { type: "entry.upserted", entry: entry as KnownTranscriptEntry })
          touched.add(entry.conversationId)
        }
        for (const conversationId of touched) yield* store.publishSummary(conversationId)
        const now = yield* Clock.currentTimeMillis
        for (const bot of yield* orDie(bots.list)) {
          yield* hub.setActivity({ botId: bot.id, state: "idle", since: now })
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("Orchestrator.recover failed", cause)))

    // ------------------------------------------------------------------ async answers (D3.3)

    yield* Effect.forkScoped(
      Stream.runForEach(approvals.asyncAnswers, (input) =>
        deliver(input).pipe(
          Effect.catch((error) => Effect.logWarning(`Orchestrator: answer for ${input.botId} not delivered`, error)),
          Effect.catchDefect((defect) => Effect.logError("Orchestrator: answer delivery failed", defect)),
          Effect.asVoid,
        )).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Orchestrator: asyncAnswers ended", cause)
          ),
        ),
      { startImmediately: true },
    )

    // Finished background tasks (D5.7): their results wake the bot in the task's origin conversation.
    yield* Effect.forkScoped(
      Stream.runForEach(tasks.results, (input) =>
        deliver(input).pipe(
          Effect.catch((error) => Effect.logWarning(`Orchestrator: task result for ${input.botId} not delivered`, error)),
          Effect.catchDefect((defect) => Effect.logError("Orchestrator: task result delivery failed", defect)),
          Effect.asVoid,
        )).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Orchestrator: task results ended", cause)
          ),
        ),
      { startImmediately: true },
    )

    // Stop every runner (and close its harness session) before the layer's scope closes.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...runners.values()], (runner) => runner.stop("shutting down"), { discard: true }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Orchestrator: shutdown", cause)),
      )
    )

    return Orchestrator.of({
      send,
      lookupSend: Effect.fn("Orchestrator.lookupSend")(function*(input) {
        yield* store.get(input.conversationId)
        const found = yield* orDie(entries.findByClientNonce(input.conversationId, input.clientNonce))
        if (Option.isNone(found)) return { outcome: "not-found" as const }
        const entry = found.value
        return {
          outcome: "found" as const,
          entryId: entry.id,
          delivery: entry.kind === "message" ? entry.delivery ?? "accepted" : "accepted",
        }
      }),
      react: Effect.fn("Orchestrator.react")(function*(input) {
        yield* store.get(input.conversationId)
        const found = yield* orDie(entries.get(input.entryId))
        if (Option.isNone(found) || found.value.conversationId !== input.conversationId) {
          return yield* new NotFound({ entity: "entry", id: input.entryId })
        }
        const emoji = input.emoji.trim()
        if (emoji === "" || found.value.kind !== "message") return
        yield* conversationService.updateEntry(input.entryId, (entry) => {
          if (entry.kind !== "message") return entry
          const reactions = entry.reactions ?? []
          const mine = reactions.some((r) => r.emoji === emoji && r.by.kind === "user")
          const next = mine
            ? reactions.filter((r) => !(r.emoji === emoji && r.by.kind === "user"))
            : [...reactions, { emoji, by: { kind: "user" as const, userId: OWNER_USER_ID } }]
          const { reactions: _drop, ...rest } = entry
          return next.length === 0 ? rest : { ...rest, reactions: next }
        })
      }),
      interrupt,
      deliver,
      awaitDelivery: (deliveryId) => {
        const deferred = outcomes.get(deliveryId)
        return deferred === undefined
          ? Effect.fail(new NotFound({ entity: "delivery", id: deliveryId }))
          : Deferred.await(deferred)
      },
      newSession,
      compact: compactSession,
      deleteConversation,
      approveToolCall,
      stopBot: (botId) =>
        Effect.forEach(
          runnersOf((r) => r.botId === botId),
          (runner) => Effect.andThen(runner.stop("bot stopped"), forget(runner)),
          { discard: true },
        ),
      noteGroupAddress: ({ botId, conversationId, ...note }) =>
        Effect.flatMap(existingRunner(botId), (runner) =>
          Option.isSome(runner) ? runner.value.noteAddress({ ...note, conversationId }) : Effect.succeed(false)),
      currentChain: (botId) =>
        Effect.flatMap(existingRunner(botId), (runner) =>
          Option.isSome(runner) ? runner.value.currentChain : Effect.succeed(Option.none())),
      activeTurn: (botId) =>
        Effect.flatMap(existingRunner(botId), (runner) =>
          Option.isSome(runner) ? runner.value.activeTurn : Effect.succeed(Option.none())),
      recover,
    })
  })

/** The Orchestrator layer with custom runner timings (tests); `OrchestratorLive` uses the defaults. */
export const makeOrchestratorLayer = (options?: Partial<RunnerOptions>): Layer.Layer<
  Orchestrator,
  never,
  | LiveHub
  | ConversationService
  | ApprovalService
  | BackgroundTasks
  | InstructionRenderer
  | SettingsService
  | UsageService
  | Notifier
  | HarnessRegistry
  | PlacementService
  | McpBindingIssuer
  | IdGen
  | BotRepo
  | ConversationRepo
  | EntryRepo
  | RequestRepo
  | TurnRepo
  | ReplicaLog
  | AttachmentStore
  | NodeFiles
> =>
  Layer.effect(Orchestrator, makeOrchestrator({ ...DEFAULT_RUNNER_OPTIONS, ...options })).pipe(
    Layer.provide(ConversationStoreLive),
  )

export const OrchestratorLive = makeOrchestratorLayer()
