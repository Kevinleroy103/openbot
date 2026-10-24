import type {
  HarnessSession,
  McpBinding,
  OpenSessionInput,
  RenderedInstructions,
  ResolvedPlacement,
  TurnInput,
} from "@openbot/core"
import { sessionKeyOf } from "@openbot/core"
import { botId, conversationId, makeBot, turnId } from "@openbot/core/testing"
import type { HarnessEvent, HarnessRequest, HarnessRequestResolution } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { Effect, Fiber, Stream } from "effect"

export const BOT = makeBot({ id: botId("bot_scout"), name: "Scout" })
export const CONVERSATION = conversationId("cnv_scout")

export const placement: ResolvedPlacement = {
  mode: "native-local",
  hostNodeId: LOCAL_NODE_ID,
  workspacePath: "/tmp/openbot-fake/workspace",
  harnessCwd: "/tmp/openbot-fake/workspace",
  env: {},
  disableBuiltinTools: false,
  toolsets: ["bot"],
  promptAppend: "",
  release: Effect.void,
}

export const instructions: RenderedInstructions = {
  text: "You are Scout, a helpful bot.",
  sections: { base: "", persona: "You are Scout, a helpful bot.", team: "", memoryIndex: "", placement: "" },
  hash: "hash-1",
}

export const openInput = (
  overrides?: Partial<OpenSessionInput> & {
    readonly mcp?: ReadonlyArray<McpBinding>
  },
): OpenSessionInput => ({
  bot: BOT,
  conversationId: CONVERSATION,
  sessionKey: sessionKeyOf(BOT.id, CONVERSATION),
  nativeSessionId: undefined,
  placement,
  instructions,
  mcp: [],
  model: undefined,
  effort: undefined,
  onRequest: () => Effect.succeed({ decision: "deny" }),
  ...overrides,
})

export const turn = (id: string, text: string, attachments: TurnInput["attachments"] = []): TurnInput => ({
  turnId: turnId(id),
  text,
  attachments,
})

export const isTerminal = (event: HarnessEvent): boolean =>
  event._tag === "TurnCompleted" || event._tag === "TurnFailed" || event._tag === "TurnInterrupted"

/**
 * Collects every event of a session in the background (one consumer, like the runner) and lets the
 * test wait for conditions on the collected list.
 */
export const collect = (session: HarnessSession) =>
  Effect.gen(function* () {
    const events: Array<HarnessEvent> = []
    let ended = false
    const fiber = yield* session.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.ensuring(
        Effect.sync(() => {
          ended = true
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const waitUntil = (predicate: (events: ReadonlyArray<HarnessEvent>) => boolean, timeoutMs = 5_000) =>
      Effect.gen(function* () {
        const deadline = Date.now() + timeoutMs
        while (!predicate(events)) {
          if (Date.now() > deadline) {
            return yield* Effect.die(new Error(`timed out; events: ${JSON.stringify(events.map(describe))}`))
          }
          yield* Effect.sleep("5 millis")
        }
        return events
      })
    /** Waits for the terminal event of `id` and returns that turn's events (TurnStarted..terminal). */
    const turnEvents = (id: string) =>
      Effect.map(
        waitUntil((list) => list.some((e) => isTerminal(e) && "turnId" in e && e.turnId === id)),
        (list) => {
          const start = list.findIndex((e) => e._tag === "TurnStarted" && e.turnId === id)
          const end = list.findIndex((e) => isTerminal(e) && "turnId" in e && e.turnId === id)
          return list.slice(start, end + 1)
        },
      )
    return {
      events,
      waitUntil,
      turnEvents,
      ended: () => ended,
      join: Fiber.join(fiber),
    }
  })

export const describe = (event: HarnessEvent): string => {
  switch (event._tag) {
    case "ItemUpserted": {
      const item = event.item
      switch (item._tag) {
        case "Message":
          return `Message(${item.streaming ? "streaming" : "final"}${item.aborted ? ",aborted" : ""}):${item.text}`
        case "ToolCall":
          return `ToolCall(${item.status}):${item.toolName}`
        case "Reasoning":
          return `Reasoning(${item.streaming ? "streaming" : "final"})`
        case "Notice":
          return `Notice:${item.text}`
      }
      return "Item"
    }
    case "Activity":
      return `Activity:${event.label}`
    default:
      return event._tag
  }
}

/** Collapses consecutive streaming updates of the same message into one marker for sequence checks. */
export const shape = (events: ReadonlyArray<HarnessEvent>): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const event of events) {
    const text = describe(event)
    if (event._tag === "ItemUpserted" && event.item._tag === "Message" && event.item.streaming) {
      if (out[out.length - 1] === "Message(streaming)") continue
      out.push("Message(streaming)")
      continue
    }
    if (event._tag === "Activity") {
      out.push("Activity")
      continue
    }
    out.push(text.startsWith("Message(final)") ? "Message(final)" : text)
  }
  return out
}

export const finalMessages = (events: ReadonlyArray<HarnessEvent>): ReadonlyArray<string> =>
  events.flatMap((e) =>
    e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming ? [e.item.text] : [],
  )

export const toolCalls = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((e) => (e._tag === "ItemUpserted" && e.item._tag === "ToolCall" ? [{ key: e.key, item: e.item }] : []))

/** Records requests and answers them with `respond`. */
export const recordingOnRequest = (respond: (request: HarnessRequest) => HarnessRequestResolution) => {
  const requests: Array<HarnessRequest> = []
  return {
    requests,
    onRequest: (request: HarnessRequest) =>
      Effect.sync(() => {
        requests.push(request)
        return respond(request)
      }),
  }
}

export const run = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))
