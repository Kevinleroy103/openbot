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
  defaultVoiceFor,
  VOICE_OUTPUT_SAMPLE_RATE,
  type VoiceCallStatus,
  type VoiceClientMessage,
} from "@openbot/contracts"
import { BotRepo, EntryRepo, LiveHub, Orchestrator, SettingsService } from "@openbot/core"
import { closeWriter, type Frame, open } from "@openbot/brain-nodes"
import { Context, Duration, Effect, Layer, Option, Queue, Result } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
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
  const tomorrow = new Date(input.now.getTime() + 24 * 60 * 60_000).toLocaleDateString("en-GB", { timeZone: input.timeZone, weekday: "long", day: "numeric", month: "long" })
  const about = oneLine(bot.instructions, ABOUT_CHARS)
  const recent = input.recent.map((m) => `  - ${m.fromOwner ? owner : "You"}: ${oneLine(m.text, RECENT_MESSAGE_CHARS)}`)
  return `You are the voice of ${bot.name}, on a phone call with ${owner}, the person you work for. Speak as ${bot.name}, in first person.

Every reply is JSON: {"action": "talk" or "delegate", "say": "...", "instruction": "..."}.
- "say" is spoken aloud: one or two short, plain sentences. No lists, no markdown, no emoji.
- action "delegate" whenever ${owner} wants something done or found out that is not in WHAT YOU KNOW below: checking or searching anything (Slack, email, calendar, files, code, the web, the weather, news), sending or writing anything, reminders, scheduling, changes, research. "instruction" is the complete task for your full self, with every detail ${owner} gave (names, times, places, dates written out). "say" tells ${owner}, in your own words, what you are about to do for this request, the way a colleague would ("Let me pull up your calendar."). Say it differently every time; never just "On it". Don't repeat times, dates or numbers in it. Never pretend you did it.
- action "talk" for small talk, answers from WHAT YOU KNOW, "never mind", and when the request is unclear: then "say" asks one short question. "instruction" is "".
- When a RESULT arrives from your full self, action "talk": tell ${owner} the gist in one or two sentences.

WHAT YOU KNOW:
- Now: ${when} (${input.timeZone}). Tomorrow is ${tomorrow}.${about === "" ? "" : `\n- About you: ${about}`}${input.activity === undefined ? "" : `\n- Right now you are: ${input.activity}`}${recent.length === 0 ? "" : `\n- Your latest messages with ${owner} (oldest first):\n${recent.join("\n")}`}

Examples:
${owner}: "Did Karl answer my email?" → {"action":"delegate","say":"Let me look through your inbox for Karl.","instruction":"Check ${owner}'s email for a reply from Karl and say what it says."}
${owner}: "Book a table for two at eight." → {"action":"delegate","say":"Sure, I'll find you a table.","instruction":"Book a table for two at 20:00 tonight; ask ${owner} which restaurant if it isn't clear."}
${owner}: "What's on my plate this week?" → {"action":"delegate","say":"Give me a second, I'll go through this week.","instruction":"List ${owner}'s meetings and deadlines from today to Sunday."}
${owner}: "Thanks, that's all." → {"action":"talk","say":"Anytime. Talk soon.","instruction":""}
${owner}: "Move it." → {"action":"talk","say":"Move what?","instruction":""}`
}

/** What the Bot is given for work handed over on a call (it is not shown in the chat). */
export const delegationText = (input: { readonly words: string; readonly instruction: string }): string =>
  `On a voice call with you I said: "${oneLine(input.words, 600)}"\n(Your voice on the call took it as: ${input.instruction} If that doesn't match my words, go by my words.)\n\nDo it, then answer in a few short, plain sentences: your answer is read out to me on the call.`

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

      /**
       * Work for the Bot: delivered like the owner's words but with no message in the chat (the call is
       * the conversation); its answer is the turn's last message, which the chat shows.
       */
      const delegate = (bot: Bot) => async (work: { readonly instruction: string; readonly words: string }): Promise<string> => {
        const receipt = await run(orchestrator.deliver({
          conversationId: bot.directConversationId,
          botId: bot.id,
          kind: "user-message",
          text: delegationText(work),
          urgency: "urgent",
        }))
        const outcome = await run(orchestrator.awaitDelivery(receipt.deliveryId).pipe(
          Effect.timeout(ANSWER_TIMEOUT),
          Effect.orElseSucceed(() => undefined),
        ))
        if (outcome === undefined) return "Still working on it; the answer will be in the chat."
        const answer = outcome.lastBotMessage?.trim() ?? ""
        if (outcome.status !== "completed") return answer === "" ? "It stopped before it could answer." : `It stopped partway. So far: ${answer.slice(-ANSWER_CHARS)}`
        return answer === "" ? "It finished without saying anything." : answer.slice(-ANSWER_CHARS)
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
          // warm up: the voice model reads the brief now (it keeps it cached), so the first answer is quick
          void fetch(`${thinker.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "system", content: brief }, { role: "user", content: "Hello?" }], max_tokens: 1, ...manifest.model.requestExtras }),
          }).catch(() => undefined)
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
