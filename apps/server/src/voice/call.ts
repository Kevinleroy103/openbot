/**
 * One voice call (experiment): the owner's microphone in, the Bot's voice out.
 *
 * - Turn taking by loudness (voice input's segmenter levels, 30 ms frames): an utterance starts after
 *   a short run of speech (longer, and louder, while the Bot's voice is still playing) and ends after
 *   ~0.65 s of quiet. Captions follow as Parakeet hears it.
 * - The owner talking over the Bot stops it at once: the reply being written is dropped and the app
 *   is told to drop audio it has not played yet.
 * - Each reply from the voice model is spoken sentence by sentence while it is written. `delegate`
 *   hands the work to the Bot; its answer comes back later and is told at the next quiet moment
 *   (then it leaves the chat: `Answer.told`).
 */
import type { VoiceCallPhase, VoiceServerMessage } from "@openbot/contracts"
import { frameLevels, speechThreshold } from "../stt/segmenter.ts"
import { type ChatMessage, type ReplyEvent, SentenceChunker, type VoiceReply } from "./reply.ts"

export const CALL_INPUT_SAMPLE_RATE = 16_000
const FRAME_SAMPLES = Math.round(CALL_INPUT_SAMPLE_RATE * 0.03)
const START_FRAMES = 4 // 120 ms of speech starts an utterance
const START_FRAMES_OVER_BOT = 8 // 240 ms while the Bot's voice plays
const OVER_BOT_LEVEL_FACTOR = 2
const END_QUIET_FRAMES = 22 // ~0.65 s
const PRE_ROLL_FRAMES = 10 // 300 ms kept from before it started
const PARTIAL_EVERY_SAMPLES = Math.round(CALL_INPUT_SAMPLE_RATE * 0.4)
const MAX_UTTERANCE_SAMPLES = CALL_INPUT_SAMPLE_RATE * 60
const LEVEL_HISTORY_FRAMES = 1_000
const HISTORY_MESSAGES = 24

/** One utterance's transcription (voice input's dictation session). */
export interface Transcription {
  readonly append: (samples: Float32Array) => Promise<string>
  readonly finish: (samples: Float32Array) => Promise<string>
  readonly discard: () => void
}

export interface CallDeps {
  readonly transcribe: () => Promise<Transcription>
  readonly reply: (messages: ReadonlyArray<ChatMessage>, signal: AbortSignal) => AsyncIterable<ReplyEvent>
  /** Speech for `text` at the call's output rate. */
  readonly speak: (text: string) => Promise<Float32Array>
  /** Hands work to the Bot; resolves with its answer (`told`: it was said on the call). */
  readonly delegate: (work: { readonly instruction: string; readonly words: string }) => Promise<Answer>
  readonly systemPrompt: () => Promise<string>
  readonly send: (message: VoiceServerMessage) => void
  readonly sendAudio: (pcm16: Uint8Array) => void
  readonly log: (message: string, details?: Record<string, unknown>) => void
}

const concat = (parts: ReadonlyArray<Float32Array>): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export const toPcm16 = (samples: Float32Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff), true)
  return out
}

export const fromPcm16 = (pcm: Uint8Array): Float32Array => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const out = new Float32Array(Math.floor(pcm.byteLength / 2))
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

interface Utterance {
  readonly transcription: Promise<Transcription | undefined>
  /** Heard but not yet given to the transcription. */
  pending: Array<Float32Array>
  pendingSamples: number
  totalSamples: number
  quietFrames: number
  /** One transcription call at a time. */
  busy: Promise<unknown>
  latestText: string
}

interface Turn {
  readonly abort: AbortController
  said: string
}

export interface Answer {
  readonly text: string
  /** Called once the answer has been told on the call. */
  readonly told?: (() => void) | undefined
}

interface Work {
  readonly id: string
  readonly instruction: string
  readonly answer: Answer
}

export class VoiceCall {
  private phase: VoiceCallPhase = "connecting"
  private readonly history: Array<ChatMessage> = []
  private readonly levels: Array<number> = []
  private readonly preRoll: Array<Float32Array> = []
  private frame = new Float32Array(FRAME_SAMPLES)
  private frameFill = 0
  private loudFrames = 0
  private utterance: Utterance | undefined
  private turn: Turn | undefined
  /** The app still has the Bot's voice queued. */
  private playing = false
  private muted = false
  private ended = false
  private readonly results: Array<Work> = []
  private nextWork = 0
  private startedAt = 0
  /** What was said, for the chat's "Voice chat" line. */
  private readonly lines: Array<{ who: "you" | "bot"; text: string }> = []

  constructor(private readonly deps: CallDeps) {}

  start(): void {
    this.startedAt = Date.now()
    this.setPhase("listening")
  }

  /** How long the call went and what was said (both sides). */
  summary(): { readonly durationMs: number; readonly lines: ReadonlyArray<{ readonly who: "you" | "bot"; readonly text: string }> } {
    return { durationMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt, lines: this.lines.map((l) => ({ ...l })) }
  }

  // ---------------------------------------------------------------- input

  audio(pcm16: Uint8Array): void {
    if (this.ended || this.muted) return
    const samples = fromPcm16(pcm16)
    let at = 0
    while (at < samples.length) {
      const take = Math.min(FRAME_SAMPLES - this.frameFill, samples.length - at)
      this.frame.set(samples.subarray(at, at + take), this.frameFill)
      this.frameFill += take
      at += take
      if (this.frameFill === FRAME_SAMPLES) {
        this.onFrame(this.frame)
        this.frame = new Float32Array(FRAME_SAMPLES)
        this.frameFill = 0
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted && this.utterance !== undefined) this.endUtterance()
  }

  /** The app played everything it was sent. */
  played(): void {
    this.playing = false
    if (this.turn === undefined && this.utterance === undefined) this.setPhase("listening")
    this.deliverResult()
  }

  hangup(): void {
    this.ended = true
    this.turn?.abort.abort()
    this.turn = undefined
    void this.utterance?.transcription.then((t) => t?.discard())
    this.utterance = undefined
  }

  private setPhase(phase: VoiceCallPhase) {
    if (this.phase === phase || this.ended) return
    this.phase = phase
    this.deps.send({ type: "phase", phase })
  }

  private onFrame(frame: Float32Array) {
    const level = frameLevels(frame, CALL_INPUT_SAMPLE_RATE)[0] ?? 0
    this.levels.push(level)
    if (this.levels.length > LEVEL_HISTORY_FRAMES) this.levels.shift()
    const threshold = speechThreshold(this.levels)
    const current = this.utterance
    if (current !== undefined) {
      this.hear(current, frame)
      current.quietFrames = level >= threshold ? 0 : current.quietFrames + 1
      if (current.quietFrames >= END_QUIET_FRAMES || current.totalSamples >= MAX_UTTERANCE_SAMPLES) this.endUtterance()
      return
    }
    const overBot = this.playing || this.turn !== undefined
    const needed = overBot ? START_FRAMES_OVER_BOT : START_FRAMES
    const loud = level >= (overBot ? threshold * OVER_BOT_LEVEL_FACTOR : threshold)
    this.loudFrames = loud ? this.loudFrames + 1 : 0
    this.preRoll.push(frame)
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
    if (this.loudFrames >= needed) this.startUtterance()
  }

  // ---------------------------------------------------------------- the owner speaking

  private startUtterance() {
    this.loudFrames = 0
    if (this.turn !== undefined || this.playing) this.bargeIn()
    const heard = [...this.preRoll]
    this.preRoll.length = 0
    const utterance: Utterance = {
      transcription: this.deps.transcribe().catch((error) => {
        this.deps.log("voice call: transcription did not open", { error: String(error) })
        return undefined
      }),
      pending: heard,
      pendingSamples: heard.reduce((n, f) => n + f.length, 0),
      totalSamples: heard.reduce((n, f) => n + f.length, 0),
      quietFrames: 0,
      busy: Promise.resolve(),
      latestText: "",
    }
    this.utterance = utterance
    this.setPhase("hearing")
  }

  private hear(utterance: Utterance, frame: Float32Array) {
    utterance.pending.push(frame)
    utterance.pendingSamples += frame.length
    utterance.totalSamples += frame.length
    if (utterance.pendingSamples < PARTIAL_EVERY_SAMPLES) return
    const samples = concat(utterance.pending)
    utterance.pending = []
    utterance.pendingSamples = 0
    utterance.busy = utterance.busy.then(async () => {
      const transcription = await utterance.transcription
      if (transcription === undefined || this.utterance !== utterance) return
      const text = await transcription.append(samples).catch(() => utterance.latestText)
      if (text !== utterance.latestText && this.utterance === utterance && text !== "") {
        utterance.latestText = text
        this.deps.send({ type: "you", text, final: false })
      }
    })
  }

  private endUtterance() {
    const utterance = this.utterance
    if (utterance === undefined) return
    this.utterance = undefined
    const rest = concat(utterance.pending)
    utterance.pending = []
    void utterance.busy.then(async () => {
      const transcription = await utterance.transcription
      const text = transcription === undefined ? "" : (await transcription.finish(rest).catch(() => utterance.latestText)).trim()
      if (this.ended) return
      if (text === "") {
        if (this.turn === undefined && this.utterance === undefined) this.setPhase(this.playing ? "speaking" : "listening")
        this.deliverResult()
        return
      }
      this.deps.send({ type: "you", text, final: true })
      this.lines.push({ who: "you", text })
      this.remember({ role: "user", content: text })
      void this.runTurn(text)
    })
  }

  /** The owner talks over the Bot: stop speaking and thinking at once. */
  private bargeIn() {
    const turn = this.turn
    this.turn = undefined
    turn?.abort.abort()
    if (turn !== undefined && turn.said !== "") this.remember({ role: "assistant", content: JSON.stringify({ action: "talk", say: `${turn.said} …`, instruction: "" }) })
    if (this.playing || turn !== undefined) this.deps.send({ type: "stop" })
    this.playing = false
  }

  // ---------------------------------------------------------------- the Bot speaking

  private remember(message: ChatMessage) {
    this.history.push(message)
    if (this.history.length > HISTORY_MESSAGES) this.history.splice(0, this.history.length - HISTORY_MESSAGES)
  }

  private async runTurn(words: string | undefined) {
    if (this.ended) return
    const turn: Turn = { abort: new AbortController(), said: "" }
    this.turn?.abort.abort()
    this.turn = turn
    this.setPhase("thinking")
    const startedAt = performance.now()
    let firstAudioAt: number | undefined
    const chunker = new SentenceChunker()
    let speaking: Promise<void> = Promise.resolve()
    let line: { who: "bot"; text: string } | undefined
    const say = (sentence: string) => {
      // the next sentence is synthesized while this one plays
      const audio = this.deps.speak(sentence).catch((error) => {
        this.deps.log("voice call: Kokoro failed", { error: String(error) })
        return new Float32Array(0)
      })
      speaking = speaking.then(async () => {
        const samples = await audio
        if (this.turn !== turn || samples.length === 0) return
        firstAudioAt ??= performance.now()
        turn.said = turn.said === "" ? sentence : `${turn.said} ${sentence}`
        if (line === undefined) {
          line = { who: "bot", text: sentence }
          this.lines.push(line)
        } else line.text = `${line.text} ${sentence}`
        this.playing = true
        this.deps.sendAudio(toPcm16(samples))
        this.deps.send({ type: "bot", text: sentence })
        this.setPhase("speaking")
      })
    }
    let reply: VoiceReply | undefined
    try {
      const system = await this.deps.systemPrompt()
      for await (const event of this.deps.reply([{ role: "system", content: system }, ...this.history], turn.abort.signal)) {
        if (this.turn !== turn) return
        if (event.type === "say") for (const sentence of chunker.push(event.text)) say(sentence)
        else reply = event.reply
      }
      const rest = chunker.flush()
      if (rest !== undefined) say(rest)
      await speaking
    } catch (error) {
      if (this.turn !== turn) return
      this.deps.log("voice call: no reply", { error: String(error) })
      this.deps.send({ type: "error", message: "I lost my train of thought there." })
    }
    if (this.turn !== turn) return
    this.turn = undefined
    this.deps.log("voice call: replied", {
      action: reply?.action,
      firstAudioMs: firstAudioAt === undefined ? undefined : Math.round(firstAudioAt - startedAt),
    })
    if (reply !== undefined) {
      this.remember({ role: "assistant", content: JSON.stringify(reply) })
      if (reply.action === "delegate" && reply.instruction !== "") this.startWork(reply.instruction, words ?? "")
    }
    if (this.utterance === undefined) this.setPhase(this.playing ? "speaking" : "listening")
    this.deliverResult()
  }

  // ---------------------------------------------------------------- work for the Bot

  private startWork(instruction: string, words: string) {
    const id = `work-${++this.nextWork}`
    this.deps.send({ type: "work", id, instruction, done: false })
    void this.deps.delegate({ instruction, words }).then(
      (answer) => answer,
      (error): Answer => ({ text: `It could not be done: ${error instanceof Error ? error.message : String(error)}` }),
    ).then((answer) => {
      if (this.ended) return
      this.deps.send({ type: "work", id, instruction, done: true })
      this.results.push({ id, instruction, answer })
      this.deliverResult()
    })
  }

  /** A result is told at the next quiet moment (nobody speaking, nothing playing). */
  private deliverResult() {
    if (this.ended || this.turn !== undefined || this.utterance !== undefined || this.playing) return
    const work = this.results.shift()
    if (work === undefined) return
    this.remember({ role: "user", content: `RESULT from your full self (the work: "${work.instruction}"):\n${work.answer.text}` })
    work.answer.told?.()
    void this.runTurn(undefined)
  }
}
