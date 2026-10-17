/**
 * The fake harness session (architecture §4.5 Fake, D2.4): a deterministic, scripted
 * `HarnessSession`. Each turn's text is parsed into directives (`script.ts`) that stream text,
 * call OpenBot tools through the real MCP gateway, raise approvals and questions via `onRequest`,
 * and fail on cue.
 *
 * Event stream semantics: `events` is backed by an unbounded queue created when the session opens,
 * so no event is lost regardless of when the consumer subscribes (`SessionBound` is emitted at open).
 * It is meant for a single consumer (the conversation runner). The stream ends when the session
 * scope closes or after a scripted `crash:`.
 *
 * Turn rules:
 * - one turn at a time: `startTurn` while a turn runs fails with `turn-rejected`;
 * - `steer` appends the input to the running turn (processed after the current directives, same
 *   turn id); without a running turn it fails with `turn-rejected`;
 * - `interrupt` interrupts the running turn: open streaming messages are re-emitted with
 *   `aborted: true`, then `TurnInterrupted`;
 * - approvals never execute anything: an allowed `approve:` command is reported as simulated.
 */
import type { HarnessError as HarnessErrorType, HarnessSession, OpenSessionInput, TurnInput } from "@openbot/core"
import { HarnessError } from "@openbot/core"
import type {
  HarnessApprovalRequest,
  HarnessEvent,
  HarnessItem,
  HarnessQuestionRequest,
  HarnessTurnError,
  NodeId,
  ToolKind,
  TurnId,
} from "@openbot/contracts"
import { isAnswersResolution, openBotToolActivity } from "@openbot/contracts"
import { Cause, Duration, Effect, FiberHandle, Queue, Result, Scope, Stream } from "effect"
import { makeMcpToolClient, type McpToolClient } from "./mcp.ts"
import { cap, chunksOf, type Directive, estimateTokens, parseScript } from "./script.ts"


/** The `[Attachments: …]` line OpenBot appends to turns that carry files. */
const ATTACHMENTS_LINE = /^\[Attachments: .*\]$/m
/** The brief of a new Bot's hidden first turn (core `introductionText`). */
const INTRODUCTION = /^\[You just joined the team/

/** File names listed in the `[Attachments: inbox/…/name (mime, size), …]` line. */
const receivedFileNames = (text: string): ReadonlyArray<string> => {
  const line = ATTACHMENTS_LINE.exec(text)?.[0]
  if (line === undefined) return []
  return line
    .slice("[Attachments: ".length, -1)
    .split(/\), /)
    .map((item) => item.split(" (")[0]!.split("/").pop()!.trim())
    .filter((name) => name !== "")
}

export const FAKE_HARNESS_KIND = "fake"

export interface FakeSessionConfig {
  /** Native session id to bind (the resumed id or a fresh one). */
  readonly nativeSessionId: string
  /** Delay between streamed chunks of normal replies. */
  readonly chunkDelay: Duration.Input
  /** Delay between streamed chunks of `slow:` replies. */
  readonly slowChunkDelay: Duration.Input
  /** Context window reported by `ContextUsage`. */
  readonly windowTokens: number
  /** Per-call timeout of `tool:` MCP calls (progress resets it). */
  readonly toolTimeout: Duration.Input
  /** Emit a reasoning item at the start of every turn (model `fake-reasoning`). */
  readonly reasoning: boolean
}

/** Output previews are capped like real adapters (≈2 KB). */
const PREVIEW_CAP = 2000
const SUMMARY_CAP = 200

type Outcome =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Failed"; readonly error: HarnessTurnError }
  | { readonly _tag: "Crashed"; readonly reason: string }

const Continue: Outcome = { _tag: "Continue" }

type ToolCallItem = Extract<HarnessItem, { _tag: "ToolCall" }>
type MessageItem = Extract<HarnessItem, { _tag: "Message" }>

interface ActiveTurn {
  readonly turnId: TurnId
  readonly steered: Array<TurnInput>
  /** Messages currently streaming (key → text), re-emitted as aborted on interrupt. */
  readonly streaming: Map<string, string>
  inputTokens: number
  outputTokens: number
}

/** Classifies an OpenBot gateway tool for the transcript (architecture §4.6 toolkits). */
export const toolKindOf = (name: string): ToolKind => {
  switch (name) {
    case "shell":
      return "shell"
    case "read_file":
      return "file-read"
    case "write_file":
      return "file-write"
    case "edit_file":
      return "file-edit"
    case "list_dir":
    case "glob":
    case "grep":
      return "search"
    default:
      return name.startsWith("browser") ? "browser" : name.startsWith("computer") ? "computer" : "mcp"
  }
}

const KIND_ACTIVITY: Partial<Record<ToolKind, string>> = {
  shell: "Running a command",
  "file-read": "Reading files",
  "file-write": "Editing files",
  "file-edit": "Editing files",
  search: "Searching",
  browser: "Using the browser",
  computer: "Using the computer",
}

/** The activity row phrase of a gateway tool, as the real adapters say it (D6.4: never a tool name). */
export const toolActivityOf = (name: string): string => KIND_ACTIVITY[toolKindOf(name)] ?? openBotToolActivity(name)

const harnessError = (code: HarnessErrorType["code"], message: string) =>
  new HarnessError({ harness: FAKE_HARNESS_KIND, code, message })

const sleepFor = (delay: Duration.Input): Effect.Effect<void> =>
  Duration.toMillis(delay) <= 0 ? Effect.yieldNow : Effect.sleep(delay)

const answerText = (value: string | ReadonlyArray<string> | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? value : value.join(", ")

export const openFakeSession = (
  input: OpenSessionInput,
  config: FakeSessionConfig,
): Effect.Effect<HarnessSession, HarnessError, Scope.Scope> =>
  Effect.gen(function*() {
    const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
    const state = {
      closed: false,
      active: undefined as ActiveTurn | undefined,
      usedTokens: estimateTokens(input.instructions.text),
      /** Turns started in this session (all of the bot's conversations share it, D5.0). */
      turns: 0,
      /** The last final message of the previous turns (what `recall:` remembers). */
      lastSaid: undefined as string | undefined,
      /** The title of the last `work:` (a background task's session), for its updates. */
      lastWork: undefined as string | undefined,
    }
    const emit = (event: HarnessEvent): void => {
      if (!state.closed) Queue.offerUnsafe(events, event)
    }
    const closeEvents = (): void => {
      state.closed = true
      Queue.endUnsafe(events)
    }
    // Finalizers run in reverse order: the MCP client closes first, then the running turn is
    // interrupted (emitting TurnInterrupted), then the event stream ends.
    yield* Effect.addFinalizer(() => Effect.sync(closeEvents))
    const turns = yield* FiberHandle.make<void, never>()
    const binding = input.mcp.find((b) => b.name === "openbot") ?? input.mcp[0]
    const mcp: McpToolClient | undefined = binding
      ? yield* makeMcpToolClient(binding, { timeout: config.toolTimeout })
      : undefined

    emit({ _tag: "SessionBound", nativeSessionId: config.nativeSessionId })

    const contextUsageEvent = (): HarnessEvent => ({
      _tag: "ContextUsage",
      usedTokens: Math.min(state.usedTokens, config.windowTokens),
      windowTokens: config.windowTokens,
    })

    // ------------------------------------------------------------------ turn execution
    const runTurn = (turn: TurnInput): Effect.Effect<void> => {
      const turnId = turn.turnId
      let itemSeq = 0
      const nextKey = (kind: string) => `${turnId}/${kind}${++itemSeq}`
      const activeOf = (): ActiveTurn | undefined => (state.active?.turnId === turnId ? state.active : undefined)
      const upsert = (key: string, item: HarnessItem) => emit({ _tag: "ItemUpserted", turnId, key, item })
      const activity = (label: string, toolKind?: ToolKind) =>
        Effect.sync(() => emit(toolKind ? { _tag: "Activity", label, toolKind } : { _tag: "Activity", label }))
      const countOutput = (text: string) => {
        const active = activeOf()
        if (active) active.outputTokens += estimateTokens(text)
      }

      const streamMessage = (text: string, delay: Duration.Input): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("msg")
          yield* activity("Typing…")
          let acc = ""
          for (const chunk of chunksOf(text)) {
            acc += chunk
            const snapshot = acc
            yield* Effect.sync(() => {
              activeOf()?.streaming.set(key, snapshot)
              upsert(key, { _tag: "Message", role: "bot", text: snapshot, streaming: true } satisfies MessageItem)
            })
            yield* sleepFor(delay)
          }
          yield* Effect.sync(() => {
            activeOf()?.streaming.delete(key)
            upsert(key, { _tag: "Message", role: "bot", text: acc, streaming: false, phase: "final" } satisfies MessageItem)
            countOutput(acc)
            if (!recalling) state.lastSaid = acc
          })
          return Continue
        })

      const reply = (text: string) => streamMessage(text, config.chunkDelay)
      let recalling = false

      const reasoning = (text: string): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("reasoning")
          yield* activity("Thinking…")
          yield* Effect.sync(() => upsert(key, { _tag: "Reasoning", text, streaming: true, source: "thinking" }))
          yield* sleepFor(config.chunkDelay)
          yield* Effect.sync(() => {
            upsert(key, { _tag: "Reasoning", text, streaming: false, source: "thinking" })
            countOutput(text)
          })
          return Continue
        })

      const callTool = (name: string, args: Record<string, unknown>): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("tool")
          const kind = toolKindOf(name)
          const node = typeof args["node"] === "string" && args["node"] !== "" ? (args["node"] as NodeId) : undefined
          const base: ToolCallItem = {
            _tag: "ToolCall",
            toolName: `mcp__openbot__${name}`,
            title: name,
            kind,
            status: "running",
            inputSummary: cap(JSON.stringify(args), SUMMARY_CAP).text,
            input: args,
            mcp: { server: "openbot", tool: name },
            ...(node ? { nodeId: node } : {}),
          }
          yield* activity(toolActivityOf(name), kind)
          yield* Effect.sync(() => upsert(key, base))
          if (!mcp) {
            const error = "ERROR: No OpenBot MCP binding was provided to this session."
            yield* Effect.sync(() => upsert(key, { ...base, status: "failed", error }))
            return yield* reply(error)
          }
          const result = yield* Effect.result(mcp.call(name, args))
          if (Result.isFailure(result)) {
            const error = `ERROR: ${result.failure.message}`
            yield* Effect.sync(() => upsert(key, { ...base, status: "failed", error }))
            return yield* reply(error)
          }
          const outcome = result.success
          const preview = cap(outcome.text, PREVIEW_CAP)
          const imageNote = outcome.images > 0 ? ` (+${outcome.images} image${outcome.images === 1 ? "" : "s"})` : ""
          yield* Effect.sync(() =>
            upsert(key, {
              ...base,
              status: outcome.isError ? "failed" : "completed",
              outputPreview: preview.text,
              output: { text: preview.text, ...(preview.truncated ? { truncated: true } : {}) },
              ...(outcome.isError ? { error: preview.text } : {}),
            })
          )
          return yield* reply(
            outcome.isError
              ? `The ${name} tool failed: ${preview.text}`
              : `I called ${name}${imageNote}. Result:\n${preview.text}`,
          )
        })

      const approve = (command: string, at?: string): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("tool")
          const cwd = at ?? input.placement.workspacePath
          const base: ToolCallItem = {
            _tag: "ToolCall",
            toolName: "fake_shell",
            title: command,
            kind: "shell",
            status: "pending",
            inputSummary: cap(command, SUMMARY_CAP).text,
            input: { command },
            command: { command, cwd },
          }
          const request: HarnessApprovalRequest = {
            kind: "command-approval",
            toolName: "fake_shell",
            title: `Run ${command}`,
            detail: `The fake harness wants to run \`${command}\` in ${cwd}. It is simulated: nothing is executed.`,
            surface: "shell",
            toolKey: key,
            nativeRequestId: key,
            command,
            cwd,
            input: { command },
          }
          yield* Effect.sync(() => upsert(key, base))
          yield* activity(`Waiting for approval: ${cap(command, 60).text}`, "shell")
          const resolution = yield* input.onRequest(request)
          const decision = isAnswersResolution(resolution) ? "deny" : resolution.decision
          const message = isAnswersResolution(resolution) ? undefined : resolution.message
          if (decision === "allow-once" || decision === "allow-session" || decision === "allow-always") {
            const output = `(simulated) ${command}`
            yield* Effect.sync(() =>
              upsert(key, {
                ...base,
                status: "completed",
                outputPreview: output,
                output: { text: output },
                command: { command, cwd, exitCode: 0 },
              })
            )
            return yield* reply(`Approved (${decision}). I ran \`${command}\` (simulated).`)
          }
          yield* Effect.sync(() =>
            upsert(key, { ...base, status: "declined", ...(message ? { error: message } : {}) })
          )
          return yield* reply(
            `Okay, I did not run \`${command}\` (${decision}).${message ? ` You said: ${message}` : ""}`,
          )
        })

      const ask = (prompt: string, options: ReadonlyArray<string>): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("question")
          const base: ToolCallItem = {
            _tag: "ToolCall",
            toolName: "fake_ask",
            title: prompt,
            kind: "question",
            status: "pending",
            inputSummary: cap(prompt, SUMMARY_CAP).text,
            input: { prompt, options },
          }
          const request: HarnessQuestionRequest = {
            kind: "question",
            title: prompt,
            toolKey: key,
            nativeRequestId: key,
            questions: [{
              id: "q1",
              prompt,
              options: options.map((label) => ({ label })),
              multiSelect: false,
              allowFreeText: true,
            }],
          }
          yield* Effect.sync(() => upsert(key, base))
          yield* activity("Waiting for your answer", "question")
          const resolution = yield* input.onRequest(request)
          if (isAnswersResolution(resolution)) {
            const answer = answerText(resolution.answers["q1"])
            yield* Effect.sync(() =>
              upsert(key, { ...base, status: "completed", outputPreview: answer, output: { text: answer } })
            )
            return yield* reply(`You answered: ${answer === "" ? "(nothing)" : answer}`)
          }
          yield* Effect.sync(() => upsert(key, { ...base, status: "declined" }))
          return yield* reply(`No answer (${resolution.decision}), moving on.`)
        })

      /** `bg:` — starts parallel work through the gateway's `start_task` and replies at once (D5.7). */
      const background = (seconds: number, title: string): Effect.Effect<Outcome> =>
        bookkeeping("start_task", { title, brief: `work: ${seconds} ${title}` }, `Sure — I'll get back to you about ${title}.`)

      /** `upd:` — passes a change on to running work (`update_task`) and replies at once (D5.7). */
      const updateWork = (title: string, message: string): Effect.Effect<Outcome> =>
        bookkeeping("update_task", { task: title, message }, `Got it — I'm working that into ${title}.`)

      /** A task tool call through the gateway, then a short reply (`ok`, or why it failed). */
      const bookkeeping = (tool: string, args: Record<string, unknown>, ok: string): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("tool")
          const base: ToolCallItem = {
            _tag: "ToolCall",
            toolName: `mcp__openbot__${tool}`,
            title: tool,
            kind: "mcp",
            status: "running",
            inputSummary: cap(JSON.stringify(args), SUMMARY_CAP).text,
            input: args,
            mcp: { server: "openbot", tool },
          }
          yield* activity(toolActivityOf(tool), "mcp")
          yield* Effect.sync(() => upsert(key, base))
          const result = mcp === undefined ? undefined : yield* Effect.result(mcp.call(tool, args))
          const error = result === undefined
            ? "ERROR: No OpenBot MCP binding was provided to this session."
            : Result.isFailure(result)
            ? `ERROR: ${result.failure.message}`
            : result.success.isError
            ? result.success.text
            : undefined
          yield* Effect.sync(() =>
            upsert(key, {
              ...base,
              status: error === undefined ? "completed" : "failed",
              ...(error === undefined ? {} : { error }),
              ...(result !== undefined && Result.isSuccess(result) ? { output: { text: cap(result.success.text, PREVIEW_CAP).text } } : {}),
            })
          )
          return yield* reply(error === undefined ? ok : `I couldn't do that: ${error}`)
        })

      /** `work:` — a slow piece of work: one step, then the result (a background task's turn). */
      const work = (seconds: number, title: string): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          const key = nextKey("tool")
          const base: ToolCallItem = {
            _tag: "ToolCall",
            toolName: "fake_work",
            title: `Working on ${title}`,
            kind: "other",
            status: "running",
            inputSummary: cap(`${title} (${seconds}s)`, SUMMARY_CAP).text,
            input: { title, seconds },
          }
          yield* Effect.sync(() => upsert(key, base))
          const ticks = Math.max(1, Math.ceil(seconds))
          for (let i = 1; i <= ticks; i++) {
            yield* activity(`Working on ${title} (${i}/${ticks})`, "other")
            yield* sleepFor(Duration.millis((seconds * 1000) / ticks))
          }
          state.lastWork = title
          const output = `${title}: done after ${seconds}s.`
          yield* Effect.sync(() => upsert(key, { ...base, status: "completed", outputPreview: output, output: { text: output } }))
          return yield* reply(`Here is ${title}: everything checked out after ${seconds}s of work.`)
        })

      const defaultReply = (text: string): string => {
        // a new Bot's hidden first turn (`introduction`): greet instead of echoing the brief
        if (INTRODUCTION.test(text)) return `Hi, I'm ${input.bot.name}, running on the offline Fake harness. What should I help with first?`
        // files arrive inline (images) and/or copied into the workspace (`[Attachments: …]` line)
        const listed = receivedFileNames(text)
        const names = [...new Set([...turn.attachments.map((a) => a.name), ...listed])]
        const attachments = names.length === 0
          ? ""
          : ` I received ${names.length} attachment${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`
        const said = cap(text.replace(ATTACHMENTS_LINE, "").trim(), 280).text
        return `Hi, I'm ${input.bot.name}, running on the offline Fake harness.${attachments}${
          said === "" ? "" : ` You said: "${said}"`
        }`
      }

      const runDirective = (directive: Directive): Effect.Effect<Outcome> => {
        switch (directive._tag) {
          case "Echo":
            return reply(directive.text)
          case "Slow":
            return streamMessage(directive.text, config.slowChunkDelay)
          case "Think":
            return reasoning(directive.text)
          case "Tool":
            return callTool(directive.name, directive.args)
          case "ToolInvalid":
            return Effect.gen(function*() {
              const key = nextKey("tool")
              const name = directive.name === "" ? "tool" : directive.name
              const error = `ERROR: ${directive.message}`
              yield* Effect.sync(() =>
                upsert(key, {
                  _tag: "ToolCall",
                  toolName: `mcp__openbot__${name}`,
                  title: name,
                  kind: toolKindOf(name),
                  status: "failed",
                  inputSummary: cap(directive.raw, SUMMARY_CAP).text,
                  error,
                })
              )
              return yield* reply(error)
            })
          case "Approve":
            return approve(directive.command, directive.cwd)
          case "Ask":
            return ask(directive.prompt, directive.options)
          case "Fail":
            return Effect.succeed<Outcome>({
              _tag: "Failed",
              error: { code: "scripted-failure", message: directive.message, retryable: false },
            })
          case "Crash":
            return Effect.succeed<Outcome>({ _tag: "Crashed", reason: directive.reason })
          case "Recall":
            return Effect.suspend(() => {
              recalling = true
              const said = state.lastSaid === undefined ? "nothing yet" : `"${cap(state.lastSaid, 200).text}"`
              return reply(`Session ${config.nativeSessionId} · turn ${state.turns} · I last said: ${said}`).pipe(
                Effect.ensuring(Effect.sync(() => {
                  recalling = false
                })),
              )
            })
          case "Background":
            return background(directive.seconds, directive.title)
          case "Work":
            return work(directive.seconds, directive.title)
          case "Report":
            return reply(directive.body === "" ? `${directive.title} is done.` : `Update on ${directive.title}: ${directive.body}`)
          case "UpdateWork":
            return updateWork(directive.title, directive.message)
          case "Updated":
            return reply(`Here is ${state.lastWork ?? "the work"}, now with your update (${directive.message}): everything checked out.`)
          case "Default":
            return reply(defaultReply(directive.text))
        }
      }

      const runInput = (next: TurnInput): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          yield* Effect.sync(() => {
            const active = activeOf()
            if (active) active.inputTokens += estimateTokens(next.text) + 256 * next.attachments.length
          })
          for (const directive of parseScript(next.text)) {
            const outcome = yield* runDirective(directive)
            if (outcome._tag !== "Continue") return outcome
          }
          return Continue
        })

      /** Atomically ends the turn (clears `active`, emits the terminal events). */
      const finish = (outcome: Outcome): void => {
        const active = activeOf()
        if (!active) return
        state.active = undefined
        state.usedTokens += active.inputTokens + active.outputTokens
        emit({ _tag: "Usage", turnId, usage: { inputTokens: active.inputTokens, outputTokens: active.outputTokens } })
        emit(contextUsageEvent())
        switch (outcome._tag) {
          case "Continue":
            emit({ _tag: "TurnCompleted", turnId, stopReason: "end_turn" })
            return
          case "Failed":
            emit({ _tag: "TurnFailed", turnId, error: outcome.error })
            return
          case "Crashed":
            emit({ _tag: "TurnFailed", turnId, error: { code: "crashed", message: outcome.reason, retryable: true } })
            emit({ _tag: "SessionClosed", reason: outcome.reason })
            closeEvents()
            return
        }
      }

      const interrupted = (): void => {
        const active = activeOf()
        if (!active) return
        state.active = undefined
        for (const [key, text] of active.streaming) {
          upsert(key, { _tag: "Message", role: "bot", text, streaming: false, aborted: true })
        }
        emit({ _tag: "TurnInterrupted", turnId })
      }

      const program = Effect.gen(function*() {
        yield* activity("Thinking…")
        if (config.reasoning) yield* reasoning(`Planning a reply to: ${cap(turn.text, SUMMARY_CAP).text}`)
        let outcome = yield* runInput(turn)
        while (outcome._tag === "Continue") {
          // Take steered input or finish, atomically (a concurrent `steer` either lands here or fails).
          const steered = yield* Effect.sync(() => {
            const active = activeOf()
            const next = active?.steered.shift()
            if (next === undefined) finish(Continue)
            return next
          })
          if (steered === undefined) return
          outcome = yield* runInput(steered)
        }
        yield* Effect.sync(() => finish(outcome))
      })

      return program.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            finish({
              _tag: "Failed",
              error: { code: "internal", message: Cause.pretty(cause), retryable: false },
            })
          )
        ),
        Effect.onInterrupt(() => Effect.sync(interrupted)),
      )
    }

    // ------------------------------------------------------------------ session API
    const startTurn = (turn: TurnInput): Effect.Effect<void, HarnessError> =>
      Effect.suspend(() => {
        if (state.closed) return Effect.fail(harnessError("closed", "The fake session is closed."))
        if (state.active) {
          return Effect.fail(harnessError("turn-rejected", `Turn ${state.active.turnId} is still running.`))
        }
        state.active = { turnId: turn.turnId, steered: [], streaming: new Map(), inputTokens: 0, outputTokens: 0 }
        state.turns += 1
        emit({ _tag: "TurnStarted", turnId: turn.turnId })
        return FiberHandle.run(turns, runTurn(turn), { startImmediately: true }).pipe(Effect.asVoid)
      })

    const steer = (turn: TurnInput): Effect.Effect<void, HarnessError> =>
      Effect.suspend(() => {
        if (state.closed) return Effect.fail(harnessError("closed", "The fake session is closed."))
        if (!state.active) return Effect.fail(harnessError("turn-rejected", "No turn is running to steer."))
        state.active.steered.push(turn)
        return Effect.void
      })

    const compact = Effect.suspend(() => {
      if (state.closed) return Effect.fail(harnessError("closed", "The fake session is closed."))
      if (state.active) return Effect.fail(harnessError("turn-rejected", "Cannot compact while a turn is running."))
      state.usedTokens = Math.max(estimateTokens(input.instructions.text), Math.ceil(state.usedTokens / 10))
      emit(contextUsageEvent())
      return Effect.void
    })

    return {
      events: Stream.fromQueue(events),
      nativeSessionId: Effect.succeed(config.nativeSessionId),
      startTurn,
      steer,
      interrupt: FiberHandle.clear(turns),
      compact,
      contextUsage: Effect.sync(() => ({
        usedTokens: Math.min(state.usedTokens, config.windowTokens),
        windowTokens: config.windowTokens,
      })),
    } satisfies HarnessSession
  })
