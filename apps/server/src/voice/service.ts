/**
 * Voice calls (experiment): install them (llama.cpp, the voice model, Kokoro: `<data>/voice`), and
 * run a call over `/ws/voice/:botId`. The voice model and Kokoro start with the first call and stop
 * five minutes after the last one.
 *
 * A call's voice model gets a short brief: who the Bot is, the time, what it is doing, its latest
 * messages with the owner. Work it hands over goes into the Bot's chat as the owner's message (their
 * words and the voice model's reading of them); the Bot's answer comes back when its turn ends.
 */
import {
  type Bot,
  type BotId,
  Conflict,
  type ConversationId,
  defaultVoiceFor,
  isTerminalTurnStatus,
  type KnownConversationChange,
  type TurnId,
  VOICE_OUTPUT_SAMPLE_RATE,
  type VoiceCallStatus,
  type VoiceClientMessage,
} from "@openbot/contracts"
import { BotRepo, EntryRepo, LiveHub, Orchestrator, SettingsService } from "@openbot/core"
import { closeWriter, type Frame, open } from "@openbot/brain-nodes"
import { Context, Duration, Effect, Layer, Option, Queue, Result, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { randomUUID } from "node:crypto"
import { access, rm } from "node:fs/promises"
import path from "node:path"
import { sttPlatformOf } from "../stt/manifest.ts"
import { SpeechToText } from "../stt/service.ts"
import { CALL_INPUT_SAMPLE_RATE, toPcm16, type Transcription, VoiceCall } from "./call.ts"
import { downloadVoice, isVoiceInstalled, type Speaker, startSpeaker, startThinker, type Thinker, voiceLayout } from "./engine.ts"
import { VOICE_MANIFEST, type VoiceManifest, voiceDownloadBytes } from "./manifest.ts"
import { streamReply } from "./reply.ts"

export class VoiceCalls extends Context.Service<VoiceCalls, {
  readonly status: Effect.Effect<VoiceCallStatus>
  readonly install: Effect.Effect<VoiceCallStatus, Conflict>
  readonly remove: Effect.Effect<VoiceCallStatus, Conflict>
  /** `/ws/voice/:botId`, after the route checked the owner's credentials. */
  readonly call: (botId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
}>()("openbot/server/VoiceCalls") {}

export interface VoiceCallsOptions {
  readonly dir: string
  /** Voice input's folder: Parakeet and the sherpa-onnx library Kokoro runs on. */
  readonly sttDir: string
  readonly manifest?: VoiceManifest | undefined
}

const ENGINES_IDLE_MS = 5 * 60_000
const STARTUP_TIMEOUT_MS = 90_000
const SPEAK_TIMEOUT_MS = 30_000
const ANSWER_TIMEOUT = Duration.minutes(20)
const RECENT_MESSAGES = 8
const RECENT_MESSAGE_CHARS = 220
const ABOUT_CHARS = 600
const ANSWER_CHARS = 2_000

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The voice model's brief for a call with `bot`. */
export const voiceBrief = (input: {
  readonly bot: Pick<Bot, "name" | "instructions">
  readonly owner: string
  readonly now: Date
  readonly timeZone: string
  readonly activity?: string | undefined
  readonly recent: ReadonlyArray<{ readonly fromOwner: boolean; readonly text: string }>
}): string => {
  const { bot, owner } = input
  const when = input.now.toLocaleString("en-GB", { timeZone: input.timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
  const about = oneLine(bot.instructions, ABOUT_CHARS)
  const recent = input.recent.map((m) => `  - ${m.fromOwner ? owner : "You"}: ${oneLine(m.text, RECENT_MESSAGE_CHARS)}`)
  return `You are the voice of ${bot.name}, on a phone call with ${owner}, the person you work for. Speak as ${bot.name}, in first person.

Every reply is JSON: {"action": "talk" or "delegate", "say": "...", "instruction": "..."}.
- "say" is spoken aloud: one or two short, plain sentences. No lists, no markdown, no emoji.
- action "delegate" whenever ${owner} wants something done or found out that is not in WHAT YOU KNOW below: checking or searching anything (Slack, email, calendar, files, code, the web, the weather, news), sending or writing anything, reminders, scheduling, changes, research. "instruction" is the complete task for your full self, with every detail ${owner} gave (names, times, places). "say" is a short line like "On it, I'll check Slack." Never pretend you did it.
- action "talk" for small talk, answers from WHAT YOU KNOW, "never mind", and when the request is unclear: then "say" asks one short question. "instruction" is "".
- When a RESULT arrives from your full self, action "talk": tell ${owner} the gist in one or two sentences.

WHAT YOU KNOW:
- Now: ${when} (${input.timeZone}).${about === "" ? "" : `\n- About you: ${about}`}${input.activity === undefined ? "" : `\n- Right now you are: ${input.activity}`}${recent.length === 0 ? "" : `\n- Your latest messages with ${owner} (oldest first):\n${recent.join("\n")}`}

Examples:
${owner}: "Did Karl answer my email?" → {"action":"delegate","say":"Let me check your email.","instruction":"Check ${owner}'s email for a reply from Karl and say what it says."}
${owner}: "Book a table for two at eight." → {"action":"delegate","say":"On it.","instruction":"Book a table for two at 20:00 tonight; ask ${owner} which restaurant if it isn't clear."}
${owner}: "Thanks, that's all." → {"action":"talk","say":"Anytime. Talk soon.","instruction":""}
${owner}: "Move it." → {"action":"talk","say":"Move what?","instruction":""}`
}

/** The owner's message in the Bot's chat for work handed over on a call. */
export const delegationText = (input: { readonly words: string; readonly instruction: string }): string =>
  `On our call: "${oneLine(input.words, 600)}"\n${input.instruction}\n\nKeep your answer short and plain: it's read out to me on the call.`

interface Engines {
  readonly thinker: Thinker
  readonly speaker: Speaker
}

export const VoiceCallsLive = (options: VoiceCallsOptions): Layer.Layer<VoiceCalls, never, SpeechToText | Orchestrator | LiveHub | BotRepo | EntryRepo | SettingsService> =>
  Layer.effect(
    VoiceCalls,
    Effect.gen(function*() {
      const manifest = options.manifest ?? VOICE_MANIFEST
      const layout = voiceLayout(options.dir)
      const platform = sttPlatformOf(process.platform, process.arch)
      const runner = platform === undefined ? undefined : manifest.runners[platform]
      const label = `${manifest.model.label} · ${manifest.voices.label}`
      const speech = yield* SpeechToText
      const orchestrator = yield* Orchestrator
      const hub = yield* LiveHub
      const bots = yield* BotRepo
      const entries = yield* EntryRepo
      const settings = yield* SettingsService
      const layerScope = yield* Effect.scope

      const restingStatus = (): VoiceCallStatus =>
        runner === undefined || platform === undefined
          ? { state: "unsupported", model: label }
          : { state: "absent", model: label, downloadBytes: voiceDownloadBytes(manifest, platform)! }
      const installed = runner !== undefined && (yield* Effect.promise(() => isVoiceInstalled(layout, runner, manifest)))
      let status: VoiceCallStatus = installed ? { state: "ready", model: label } : restingStatus()

      // ------------------------------------------------------------ engines (one pair for every call)
      let engines: Promise<Engines> | undefined
      let activeCalls = 0
      let idleTimer: ReturnType<typeof setTimeout> | undefined

      const startEngines = async (): Promise<Engines> => {
        const sherpaLibDir = path.join(options.sttDir, "runtime", "lib")
        await access(sherpaLibDir).catch(() => {
          throw new Error("Turn on voice input first (Settings › General): calls hear you with it.")
        })
        const [thinker, speaker] = await Promise.all([
          startThinker({ layout, startupTimeoutMs: STARTUP_TIMEOUT_MS }),
          startSpeaker({ layout, manifest, sherpaLibDir, startupTimeoutMs: STARTUP_TIMEOUT_MS, speakTimeoutMs: SPEAK_TIMEOUT_MS }),
        ])
        if (speaker.sampleRate !== VOICE_OUTPUT_SAMPLE_RATE) throw new Error(`Kokoro speaks at ${speaker.sampleRate} Hz, not ${VOICE_OUTPUT_SAMPLE_RATE}.`)
        return { thinker, speaker }
      }

      const stopEngines = async () => {
        clearTimeout(idleTimer)
        const running = engines
        engines = undefined
        const started = await running?.catch(() => undefined)
        await Promise.all([started?.thinker.stop(), started?.speaker.stop()])
      }

      const enginesForCall = async (): Promise<Engines> => {
        clearTimeout(idleTimer)
        const current = engines ?? (engines = startEngines())
        const started = await current.catch((error) => {
          if (engines === current) engines = undefined
          throw error
        })
        if (started.thinker.alive() && started.speaker.alive()) return started
        if (engines === current) {
          engines = undefined
          void Promise.all([started.thinker.stop(), started.speaker.stop()])
        }
        return enginesForCall()
      }

      const callEnded = () => {
        activeCalls--
        if (activeCalls > 0) return
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => void stopEngines(), ENGINES_IDLE_MS)
      }

      yield* Effect.addFinalizer(() => Effect.promise(stopEngines))

      // ------------------------------------------------------------ the Bot's side

      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

      const briefFor = (bot: Bot) =>
        Effect.gen(function*() {
          const owner = (yield* settings.get).ownerName ?? "the owner"
          const page = yield* entries.page({ conversationId: bot.directConversationId, limit: 40 }).pipe(Effect.orElseSucceed(() => ({ entries: [] })))
          const recent = page.entries
            .flatMap((e) => (e.kind === "message" && e.text.trim() !== "" ? [{ fromOwner: e.role === "user", text: e.text }] : []))
            .slice(-RECENT_MESSAGES)
          const activity = (yield* hub.activities).find((a) => a.botId === bot.id)
          return voiceBrief({
            bot,
            owner,
            now: new Date(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            activity: activity === undefined || activity.state === "idle" ? undefined : activity.label,
            recent,
          })
        })

      /** The Bot's answer to the turns started by a delegation: its messages in them, once they end. */
      const answerOf = (conversationId: ConversationId, turnIds: ReadonlyArray<TurnId>) =>
        Effect.gen(function*() {
          const messages = new Map<string, { readonly at: number; readonly text: string }>()
          const running = new Set(turnIds)
          const apply = (change: KnownConversationChange) => {
            if (change.type === "entry.upserted" && change.entry.kind === "message" && change.entry.role === "bot" && change.entry.turnId !== undefined && turnIds.includes(change.entry.turnId)) {
              messages.set(change.entry.id, { at: change.entry.createdAt, text: change.entry.text })
            }
            if (change.type === "turn.upserted" && running.has(change.turn.id) && isTerminalTurnStatus(change.turn.status)) running.delete(change.turn.id)
          }
          yield* hub.subscribeConversation({ conversationId }).pipe(
            Stream.map((item) => {
              if (item.kind === "snapshot") {
                for (const entry of item.entries) apply({ type: "entry.upserted", entry } as KnownConversationChange)
                for (const turn of item.turns) apply({ type: "turn.upserted", turn } as KnownConversationChange)
              } else if (item.kind === "change") apply(item.change as KnownConversationChange)
              return running.size === 0
            }),
            Stream.takeUntil((done) => done),
            Stream.runDrain,
            Effect.timeout(ANSWER_TIMEOUT),
            Effect.catch(() => Effect.void),
          )
          const text = [...messages.values()].sort((a, b) => a.at - b.at).map((m) => m.text.trim()).filter((t) => t !== "").join("\n\n")
          if (running.size > 0) return text === "" ? "Still working on it; the answer will be in the chat." : `So far: ${text.slice(-ANSWER_CHARS)}`
          return text === "" ? "It finished without saying anything." : text.slice(-ANSWER_CHARS)
        })

      const delegate = (bot: Bot) => async (work: { readonly instruction: string; readonly words: string }): Promise<string> => {
        const sent = await run(orchestrator.send({ conversationId: bot.directConversationId, text: delegationText(work), clientNonce: `voice-${randomUUID()}` }))
        return run(answerOf(bot.directConversationId, sent.turnIds))
      }

      const transcribe = async (): Promise<Transcription> => {
        const { sessionId } = await run(speech.open)
        return {
          append: async (samples) => (await run(speech.append(sessionId, toPcm16(samples)))).text,
          finish: async (samples) => (await run(speech.finish(sessionId, toPcm16(samples)))).text,
          discard: () => void run(speech.discard(sessionId)),
        }
      }

      // ------------------------------------------------------------ one call on a socket

      const runCall = (socket: Socket.Socket, bot: Bot) =>
        Effect.scoped(Effect.gen(function*() {
          const io = yield* open(socket)
          const outbox = yield* Queue.unbounded<Frame>()
          yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(outbox), (frame) => Effect.ignore(io.writer.write(frame)))))
          const sendJson = (message: unknown) => Queue.offerUnsafe(outbox, JSON.stringify(message))
          const fail = (message: string) =>
            Effect.gen(function*() {
              yield* Effect.ignore(io.writer.write(JSON.stringify({ type: "error", message })))
              yield* closeWriter(io.writer, 1011, message)
            })
          sendJson({ type: "phase", phase: "connecting" })
          const started = yield* Effect.tryPromise({ try: enginesForCall, catch: describeError }).pipe(Effect.result)
          if (Result.isFailure(started)) return yield* fail(started.failure)
          const { thinker, speaker } = started.success
          const brief = yield* briefFor(bot)
          const voice = defaultVoiceFor(bot.id)
          const call = new VoiceCall({
            transcribe,
            reply: (messages, signal) => streamReply({ url: thinker.url, messages, extras: manifest.model.requestExtras, signal }),
            speak: (text) => speaker.speak(text, voice.sid),
            delegate: delegate(bot),
            systemPrompt: async () => brief,
            send: sendJson,
            sendAudio: (pcm) => Queue.offerUnsafe(outbox, pcm),
            log: (message, details) => void Effect.runFork(Effect.logInfo(message, { bot: bot.name, ...details })),
          })
          sendJson({ type: "ready", sampleRate: VOICE_OUTPUT_SAMPLE_RATE, voice: voice.label })
          call.start()
          yield* Effect.logInfo("voice call started", { bot: bot.name, voice: voice.id })
          yield* Effect.forever(
            Effect.flatMap(io.pull, (frames) =>
              Effect.sync(() => {
                for (const frame of frames) {
                  if (typeof frame !== "string") {
                    call.audio(frame)
                    continue
                  }
                  let message: VoiceClientMessage
                  try {
                    message = JSON.parse(frame) as VoiceClientMessage
                  } catch {
                    continue
                  }
                  if (message.type === "mute") call.setMuted(message.muted)
                  else if (message.type === "played") call.played()
                  else if (message.type === "hangup") call.hangup()
                }
              })),
          ).pipe(Effect.ensuring(Effect.sync(() => call.hangup())), Effect.ignore)
          yield* Effect.logInfo("voice call ended", { bot: bot.name })
        })).pipe(Effect.catchCause((cause) => Effect.logDebug("voice call failed", { cause })))

      const call = (botId: string) =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (status.state !== "ready") return HttpServerResponse.text("Voice calls aren't set up on this OpenBot.", { status: 409 })
          const bot = yield* bots.get(botId as BotId).pipe(Effect.map(Option.getOrUndefined), Effect.orElseSucceed(() => undefined))
          if (bot === undefined) return HttpServerResponse.text("unknown bot", { status: 404 })
          const upgraded = yield* Effect.result(request.upgrade)
          if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
          activeCalls++
          yield* runCall(upgraded.success, bot).pipe(Effect.ensuring(Effect.sync(callEnded)))
          return HttpServerResponse.empty()
        })

      // ------------------------------------------------------------ install / remove

      const runInstall = (archive: NonNullable<typeof runner>) =>
        Effect.tryPromise({
          try: (signal) =>
            downloadVoice(layout, archive, manifest, (downloadedBytes, downloadBytes) => {
              status = { state: "installing", model: label, downloadBytes, downloadedBytes }
            }, signal),
          catch: describeError,
        }).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.sync(() => {
              status = { state: "ready", model: label }
            }),
            onFailure: (problem) =>
              Effect.logWarning("Voice calls could not be installed", { problem }).pipe(Effect.andThen(Effect.sync(() => {
                status = { state: "failed", model: label, problem }
              }))),
          }),
        )

      const install = Effect.suspend(() => {
        if (runner === undefined || platform === undefined || status.state === "installing" || status.state === "ready") return Effect.succeed(status)
        status = { state: "installing", model: label, downloadBytes: voiceDownloadBytes(manifest, platform)!, downloadedBytes: 0 }
        return Effect.as(Effect.forkIn(runInstall(runner), layerScope), status)
      })

      const remove = Effect.suspend(() => {
        if (status.state === "installing") return Effect.fail(new Conflict({ reason: "Voice calls are still installing." }))
        if (activeCalls > 0) return Effect.fail(new Conflict({ reason: "A call is still going." }))
        return Effect.promise(async () => {
          await stopEngines()
          await rm(layout.root, { recursive: true, force: true })
          status = restingStatus()
          return status
        })
      })

      return VoiceCalls.of({ status: Effect.sync(() => status), install, remove, call })
    }),
  )

export { CALL_INPUT_SAMPLE_RATE }
