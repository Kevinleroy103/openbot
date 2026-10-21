/**
 * One voice call (experiment): the owner's microphone in, the Bot's voice out. The Bot itself does
 * the thinking and the talking; the call only hears (Parakeet) and speaks (Kokoro).
 *
 * - Turn taking by loudness (voice input's segmenter levels, 30 ms frames): an utterance starts after
 *   a short run of speech (longer, and louder, while the Bot's voice is still playing) and ends after
 *   ~0.65 s of quiet. Captions follow as Parakeet hears it.
 * - What the owner said goes to the Bot (`ask`); what the Bot writes comes back as it is written
 *   (`botText`) and is spoken sentence by sentence. If the Bot hasn't started talking after a moment,
 *   a short filler ("One sec.") keeps the line from going dead.
 * - The owner talking over the Bot stops its voice at once: what it was saying is dropped (the Bot
 *   keeps working; its next message is spoken) and the app drops audio it has not played yet.
 */
import type { VoiceCallPhase, VoiceServerMessage } from "@openbot/contracts"
import { frameLevels, speechThreshold } from "../stt/segmenter.ts"
import { SentenceChunker, speakable } from "./speech.ts"

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
const FILLER_AFTER_MS = 1_500
const STILL_WORKING_AFTER_MS = 10_000
/** Said when the Bot is slow to start talking (not its words: kept out of the transcript). */
export const FILLERS = ["One sec.", "Mm-hm, one moment.", "Let me see.", "Give me a second.", "Sure, one sec.", "Okay, let me check."]
const STILL_WORKING = "Still on it."
/** A Bot reply that says nothing. */
const SILENT = "NO_REPLY"

/** One utterance's transcription (voice input's dictation session). */
export interface Transcription {
  readonly append: (samples: Float32Array) => Promise<string>
  readonly finish: (samples: Float32Array) => Promise<string>
  readonly discard: () => void
}

export interface CallDeps {
  readonly transcribe: () => Promise<Transcription>
  /** Speech for `text` at the call's output rate. */
  readonly speak: (text: string) => Promise<Float32Array>
  /** What the owner said, for the Bot (`first`: the call's first words). */
  readonly ask: (words: string, first: boolean) => void
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

/** One message of the Bot's, as it is written. */
interface BotMessage {
  readonly chunker: SentenceChunker
  /** How much of its text was taken. */
  seen: number
  /** Talked over: the rest of it is not spoken. */
  dropped: boolean
  /** Its line in the call's transcript, once something was said. */
  line?: { who: "bot"; text: string } | undefined
}

export interface CallLine {
  readonly who: "you" | "bot"
  readonly text: string
}

export class VoiceCall {
  private phase: VoiceCallPhase = "connecting"
  private readonly levels: Array<number> = []
  private readonly preRoll: Array<Float32Array> = []
  private frame = new Float32Array(FRAME_SAMPLES)
  private frameFill = 0
  private loudFrames = 0
  private utterance: Utterance | undefined
  /** The app still has the Bot's voice queued. */
  private playing = false
  private muted = false
  private ended = false
  private startedAt = 0
  /** What was said, for the chat's "Voice chat" line. */
  private readonly lines: Array<{ who: "you" | "bot"; text: string }> = []
  private readonly messages = new Map<string, BotMessage>()
  /** Speech in order; bumping `generation` drops what is still queued. */
  private speaking: Promise<void> = Promise.resolve()
  private generation = 0
  /** Sentences synthesized or playing. */
  private inFlight = 0
  /** Waiting for the Bot to start talking after the owner's last words. */
  private waiting = false
  private asked = 0
  private fillers: Array<ReturnType<typeof setTimeout>> = []
  private lastFiller = -1

  constructor(private readonly deps: CallDeps) {}

  start(): void {
    this.startedAt = Date.now()
    this.setPhase("listening")
  }

  /** How long the call went and what was said (both sides). */
  summary(): { readonly durationMs: number; readonly lines: ReadonlyArray<CallLine> } {
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
    this.settle()
  }

  hangup(): void {
    if (this.ended) return
    this.ended = true
    this.generation++
    this.clearFillers()
    void this.utterance?.transcription.then((t) => t?.discard())
    this.utterance = undefined
  }

  // ---------------------------------------------------------------- the Bot

  /** A message of the Bot's as it is written (`text` so far; `final` once it is complete). */
  botText(messageId: string, text: string, final: boolean): void {
    if (this.ended) return
    let message = this.messages.get(messageId)
    if (message === undefined) {
      message = { chunker: new SentenceChunker(), seen: 0, dropped: false }
      this.messages.set(messageId, message)
    }
    if (message.dropped || (text.length <= message.seen && !final)) return
    const fresh = text.slice(message.seen)
    message.seen = Math.max(message.seen, text.length)
    for (const sentence of message.chunker.push(fresh)) this.say(sentence, message)
    if (final) {
      const rest = message.chunker.flush()
      if (rest !== undefined && rest !== SILENT) this.say(rest, message)
    }
  }

  /** The Bot's turn for the owner's words ended (`failed`: it couldn't answer). */
  botDone(failed: boolean): void {
    if (this.ended) return
    if (failed && this.waiting) this.say("Sorry, I couldn't do that just now.")
    this.waiting = false
    this.clearFillers()
    this.settle()
  }

  private say(sentence: string, message?: BotMessage) {
    const text = speakable(sentence)
    if (text === "") return
    const generation = this.generation
    if (message !== undefined) {
      // the Bot is talking: no filler needed
      this.waiting = false
      this.clearFillers()
    }
    this.inFlight++
    const audio = this.deps.speak(text).catch((error) => {
      this.deps.log("voice call: Kokoro failed", { error: String(error) })
      return new Float32Array(0)
    })
    this.speaking = this.speaking.then(async () => {
      const samples = await audio
      this.inFlight--
      if (generation !== this.generation || this.ended || samples.length === 0 || message?.dropped === true) return this.settle()
      if (message !== undefined) {
        if (message.line === undefined) {
          message.line = { who: "bot", text }
          this.lines.push(message.line)
        } else message.line.text = `${message.line.text} ${text}`
      }
      this.playing = true
      this.deps.sendAudio(toPcm16(samples))
      this.deps.send({ type: "bot", text })
      this.setPhase("speaking")
    })
  }

  private filler(text: string) {
    if (this.ended || this.utterance !== undefined || !this.waiting || this.inFlight > 0 || this.playing) return
    this.say(text)
  }

  private nextFiller(): string {
    let pick = Math.floor(Math.random() * FILLERS.length)
    if (pick === this.lastFiller) pick = (pick + 1) % FILLERS.length
    this.lastFiller = pick
    return FILLERS[pick]!
  }

  private clearFillers() {
    for (const timer of this.fillers) clearTimeout(timer)
    this.fillers = []
  }

  /** The phase once nothing is happening on the owner's side. */
  private settle() {
    if (this.ended || this.utterance !== undefined) return
    this.setPhase(this.playing || this.inFlight > 0 ? "speaking" : this.waiting ? "thinking" : "listening")
  }

  // ---------------------------------------------------------------- hearing the owner

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
    const overBot = this.playing || this.inFlight > 0
    const needed = overBot ? START_FRAMES_OVER_BOT : START_FRAMES
    const loud = level >= (overBot ? threshold * OVER_BOT_LEVEL_FACTOR : threshold)
    this.loudFrames = loud ? this.loudFrames + 1 : 0
    this.preRoll.push(frame)
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
    if (this.loudFrames >= needed) this.startUtterance()
  }

  private startUtterance() {
    this.loudFrames = 0
    if (this.playing || this.inFlight > 0) this.talkedOver()
    this.clearFillers()
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
      if (text === "") return this.settle()
      this.deps.send({ type: "you", text, final: true })
      this.lines.push({ who: "you", text })
      this.deps.ask(text, this.asked++ === 0)
      this.waiting = true
      this.clearFillers()
      this.fillers = [
        setTimeout(() => this.filler(this.nextFiller()), FILLER_AFTER_MS),
        setTimeout(() => this.filler(STILL_WORKING), STILL_WORKING_AFTER_MS),
      ]
      this.settle()
    })
  }

  /** The owner talks over the Bot: its voice stops at once, and what it was saying is dropped. */
  private talkedOver() {
    this.generation++
    for (const message of this.messages.values()) message.dropped = true
    this.deps.send({ type: "stop" })
    this.playing = false
  }
}
