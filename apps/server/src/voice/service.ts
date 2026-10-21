/**
 * Voice calls (experiment): install them (Kokoro: `<data>/voice`) and run a call over
 * `/ws/voice/:botId`. The Bot does the thinking and the talking: what the owner says goes to it as a
 * voice message (a `voice` delivery: its turn stays out of the chat and notifies nobody), and what it
 * writes in that turn is spoken as it streams in. Kokoro starts with the first call and stops five
 * minutes after the last one. A call leaves one "Voice chat" line in the chat; what the Bot answers
 * after the owner hung up is posted there instead.
 */
import {
  type Bot,
  type BotId,
  Conflict,
  defaultVoiceFor,
  isTerminalTurnStatus,
  type KnownConversationChange,
  VOICE_OUTPUT_SAMPLE_RATE,
  type VoiceCallStatus,
  type VoiceClientMessage,
} from "@openbot/contracts"
import { BotRepo, ConversationService, LiveHub, Orchestrator } from "@openbot/core"
import { closeWriter, type Frame, open } from "@openbot/brain-nodes"
import { Context, Effect, Fiber, Layer, Option, Queue, Result, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { access, rm } from "node:fs/promises"
import path from "node:path"
import { sttPlatformOf } from "../stt/manifest.ts"
import { SpeechToText } from "../stt/service.ts"
import { CALL_INPUT_SAMPLE_RATE, toPcm16, type Transcription, VoiceCall } from "./call.ts"
import { downloadVoice, isVoiceInstalled, type Speaker, startSpeaker, voiceLayout } from "./engine.ts"
import { VOICE_MANIFEST, type VoiceManifest, voiceDownloadBytes } from "./manifest.ts"

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

const SPEAKER_IDLE_MS = 5 * 60_000
const STARTUP_TIMEOUT_MS = 60_000
const SPEAK_TIMEOUT_MS = 30_000
/** A turn that started this long before the call's own words is not its answer. */
const TURN_CLOCK_SLACK_MS = 2_000

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** What the Bot is given for the owner's words on a call (not shown in the chat). */
export const voiceText = (words: string, first: boolean): string =>
  first
    ? [
      "We're on a voice call now. You hear me through speech-to-text, so names and words may be misheard: go by what makes sense. What you write is read out to me as you write it.",
      "Talk like on a call: short, plain sentences, no lists, markdown or links. When you need tools, first say a few words (\"Let me check.\") so I'm not left in silence, then give the answer.",
      "",
      `Me: ${oneLine(words)}`,
    ].join("\n")
    : `Me (on the call): ${oneLine(words)}`

export const VoiceCallsLive = (options: VoiceCallsOptions): Layer.Layer<VoiceCalls, never, SpeechToText | Orchestrator | LiveHub | BotRepo | ConversationService> =>
  Layer.effect(
    VoiceCalls,
    Effect.gen(function*() {
      const manifest = options.manifest ?? VOICE_MANIFEST
      const layout = voiceLayout(options.dir)
      const platform = sttPlatformOf(process.platform, process.arch)
      const label = manifest.voices.label
      const speech = yield* SpeechToText
      const orchestrator = yield* Orchestrator
      const hub = yield* LiveHub
      const bots = yield* BotRepo
      const conversations = yield* ConversationService
      const layerScope = yield* Effect.scope

      const restingStatus = (): VoiceCallStatus =>
        platform === undefined ? { state: "unsupported", model: label } : { state: "absent", model: label, downloadBytes: voiceDownloadBytes(manifest, platform)! }
      const installed = platform !== undefined && (yield* Effect.promise(() => isVoiceInstalled(layout, manifest)))
      let status: VoiceCallStatus = installed ? { state: "ready", model: label } : restingStatus()

      // ------------------------------------------------------------ Kokoro (one for every call)
      let speaker: Promise<Speaker> | undefined
      let activeCalls = 0
      let idleTimer: ReturnType<typeof setTimeout> | undefined

      const startKokoro = async (): Promise<Speaker> => {
        const sherpaLibDir = path.join(options.sttDir, "runtime", "lib")
        await access(sherpaLibDir).catch(() => {
          throw new Error("Turn on voice input first (Settings › General): calls hear you with it.")
        })
        const started = await startSpeaker({ layout, manifest, sherpaLibDir, startupTimeoutMs: STARTUP_TIMEOUT_MS, speakTimeoutMs: SPEAK_TIMEOUT_MS })
        if (started.sampleRate !== VOICE_OUTPUT_SAMPLE_RATE) throw new Error(`Kokoro speaks at ${started.sampleRate} Hz, not ${VOICE_OUTPUT_SAMPLE_RATE}.`)
        return started
      }

      const stopKokoro = async () => {
        clearTimeout(idleTimer)
        const running = speaker
        speaker = undefined
        await (await running?.catch(() => undefined))?.stop()
      }

      const kokoroForCall = async (): Promise<Speaker> => {
        clearTimeout(idleTimer)
        const current = speaker ?? (speaker = startKokoro())
        const started = await current.catch((error) => {
          if (speaker === current) speaker = undefined
          throw error
        })
        if (started.alive()) return started
        if (speaker === current) speaker = undefined
        return kokoroForCall()
      }

      const callEnded = () => {
        activeCalls--
        if (activeCalls > 0) return
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => void stopKokoro(), SPEAKER_IDLE_MS)
      }

      yield* Effect.addFinalizer(() => Effect.promise(stopKokoro))

      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

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
          sendJson({ type: "phase", phase: "connecting" })
          const started = yield* Effect.tryPromise({ try: kokoroForCall, catch: describeError }).pipe(Effect.result)
          if (Result.isFailure(started)) {
            yield* Effect.ignore(io.writer.write(JSON.stringify({ type: "error", message: started.failure })))
            return yield* closeWriter(io.writer, 1011, started.failure)
          }
          const kokoro = started.success
          const voice = defaultVoiceFor(bot.id)
          const conversationId = bot.directConversationId

          // the Bot's turns answering this call, and from when on their messages count
          const answering = new Map<string, number>()
          /** Deliveries whose turn has not ended (their answer goes to the chat if the call ends first). */
          const unanswered = new Set<string>()
          let ended = false

          const call = new VoiceCall({
            transcribe,
            speak: (text) => kokoro.speak(text, voice.sid),
            ask: (words, first) => {
              const askedAt = Date.now()
              void run(orchestrator.deliver({
                conversationId,
                botId: bot.id,
                kind: "user-message",
                text: voiceText(words, first),
                urgency: "urgent",
                voice: true,
              })).then((receipt) => {
                // steered into a turn already running: its messages from now on answer this
                if (receipt.turnId !== undefined && !answering.has(receipt.turnId)) answering.set(receipt.turnId, askedAt)
                unanswered.add(receipt.deliveryId)
                void run(orchestrator.awaitDelivery(receipt.deliveryId)).then((outcome) => {
                  unanswered.delete(receipt.deliveryId)
                  // the call ended before this was answered: the chat gets the answer
                  const answer = outcome.lastBotMessage?.trim() ?? ""
                  if (!ended || answer === "" || answer === "NO_REPLY") return
                  void run(conversations.appendEntry({
                    conversationId,
                    kind: "message",
                    role: "bot",
                    author: { kind: "bot", botId: bot.id },
                    text: answer,
                    attachments: [],
                    streaming: false,
                  }).pipe(Effect.ignore))
                }, () => void unanswered.delete(receipt.deliveryId))
              }, (error) => {
                void Effect.runFork(Effect.logWarning("voice call: could not reach the Bot", { error: describeError(error) }))
                call.botDone(true)
              })
            },
            send: sendJson,
            sendAudio: (pcm) => Queue.offerUnsafe(outbox, pcm),
            log: (message, details) => void Effect.runFork(Effect.logInfo(message, { bot: bot.name, ...details })),
          })

          // what the Bot writes in its turns for this call, as it streams
          const apply = (change: KnownConversationChange) => {
            if (change.type === "turn.upserted") {
              const turn = change.turn
              if (turn.voice === true && turn.botId === bot.id && !answering.has(turn.id)) answering.set(turn.id, turn.startedAt - TURN_CLOCK_SLACK_MS)
              if (answering.has(turn.id) && isTerminalTurnStatus(turn.status)) call.botDone(turn.status === "failed")
              return
            }
            if (change.type !== "entry.upserted") return
            const entry = change.entry
            if (entry.kind !== "message" || entry.role !== "bot" || entry.turnId === undefined) return
            const since = answering.get(entry.turnId)
            if (since === undefined || entry.createdAt < since) return
            call.botText(entry.id, entry.text, !entry.streaming)
          }
          yield* hub.subscribeConversation({ conversationId }).pipe(
            Stream.runForEach((item) => Effect.sync(() => item.kind === "change" && apply(item.change as KnownConversationChange))),
            Effect.forkScoped,
          )

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
          ).pipe(
            Effect.ensuring(Effect.sync(() => {
              ended = true
              call.hangup()
            })),
            Effect.ignore,
          )
          // the chat keeps the call as one line ("Voice chat · 00:31") that opens to what was said
          const summary = call.summary()
          if (summary.lines.length > 0) {
            yield* conversations.appendEvent({
              conversationId,
              event: { type: "voice-call", botId: bot.id, durationMs: Math.round(summary.durationMs), lines: [...summary.lines] },
            }).pipe(Effect.ignore)
          }
          yield* Effect.logInfo("voice call ended", { bot: bot.name, seconds: Math.round(summary.durationMs / 1000), stillWorking: unanswered.size })
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
          // detached: the route's fiber is interrupted when the app closes the socket, and the call still
          // has to finish (the "Voice chat" line)
          const running = yield* Effect.forkDetach(runCall(upgraded.success, bot).pipe(Effect.ensuring(Effect.sync(callEnded))))
          yield* Fiber.await(running)
          return HttpServerResponse.empty()
        })

      // ------------------------------------------------------------ install / remove

      const runInstall = Effect.tryPromise({
        try: (signal) =>
          downloadVoice(layout, manifest, (downloadedBytes, downloadBytes) => {
            status = { state: "installing", model: label, downloadBytes, downloadedBytes }
          }, signal),
        catch: describeError,
      }).pipe(
        Effect.matchEffect({
          onSuccess: () =>
            Effect.sync(() => {
              status = { state: "ready", model: label }
            }),
          onFailure: (problem) =>
            Effect.logWarning("Voice calls could not be installed", { problem }).pipe(Effect.andThen(Effect.sync(() => {
              status = { state: "failed", model: label, problem }
            }))),
        }),
      )

      const install = Effect.suspend(() => {
        if (platform === undefined || status.state === "installing" || status.state === "ready") return Effect.succeed(status)
        status = { state: "installing", model: label, downloadBytes: voiceDownloadBytes(manifest, platform)!, downloadedBytes: 0 }
        return Effect.as(Effect.forkIn(runInstall, layerScope), status)
      })

      const remove = Effect.suspend(() => {
        if (status.state === "installing") return Effect.fail(new Conflict({ reason: "Voice calls are still installing." }))
        if (activeCalls > 0) return Effect.fail(new Conflict({ reason: "A call is still going." }))
        return Effect.promise(async () => {
          await stopKokoro()
          await rm(layout.root, { recursive: true, force: true })
          status = restingStatus()
          return status
        })
      })

      return VoiceCalls.of({ status: Effect.sync(() => status), install, remove, call })
    }),
  )

export { CALL_INPUT_SAMPLE_RATE }
