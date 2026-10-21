/**
 * Voice calls (experiment): talk with a Bot. The Bot itself does the thinking and the talking; speech
 * in and out stays on the brain (Parakeet, Kokoro).
 *
 * The call runs over `/ws/voice/:botId`. App → brain: binary frames of 16 kHz mono PCM16 (the
 * microphone) and JSON `VoiceClientMessage`s. Brain → app: binary frames of `VOICE_OUTPUT_SAMPLE_RATE`
 * mono PCM16 (the Bot's voice) and JSON `VoiceServerMessage`s.
 */
import { Schema } from "effect"
import { NonNegativeInt } from "./base.ts"

export const VoiceCallStatus = Schema.Struct({
  state: Schema.Literals(["unsupported", "absent", "installing", "ready", "failed"]),
  /** What it runs ("Kokoro"). */
  model: Schema.String,
  downloadBytes: Schema.optionalKey(NonNegativeInt),
  downloadedBytes: Schema.optionalKey(NonNegativeInt),
  problem: Schema.optionalKey(Schema.String),
})
export type VoiceCallStatus = typeof VoiceCallStatus.Type

/** The Bot's voice, as the brain sends it. */
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000

/** Kokoro v1.0's English voices (`sid`: its speaker number). */
export const KOKORO_VOICES = [
  { id: "af_heart", sid: 3, label: "Heart" },
  { id: "af_bella", sid: 2, label: "Bella" },
  { id: "af_nicole", sid: 6, label: "Nicole" },
  { id: "af_sarah", sid: 9, label: "Sarah" },
  { id: "am_michael", sid: 16, label: "Michael" },
  { id: "am_fenrir", sid: 14, label: "Fenrir" },
  { id: "am_puck", sid: 18, label: "Puck" },
  { id: "am_eric", sid: 13, label: "Eric" },
  { id: "bf_emma", sid: 21, label: "Emma" },
  { id: "bf_isabella", sid: 22, label: "Isabella" },
  { id: "bm_george", sid: 26, label: "George" },
  { id: "bm_fable", sid: 25, label: "Fable" },
] as const
export type KokoroVoice = (typeof KOKORO_VOICES)[number]

/** A Bot's voice until it can be chosen: the same one every call, spread over the list. */
export const defaultVoiceFor = (botId: string): KokoroVoice => {
  let hash = 0
  for (const char of botId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return KOKORO_VOICES[hash % KOKORO_VOICES.length]!
}

/** What the call is doing (the call bar shows it). */
export type VoiceCallPhase = "connecting" | "listening" | "hearing" | "thinking" | "speaking"

export type VoiceServerMessage =
  /** The call is up: the Bot's voice comes at `sampleRate`. */
  | { readonly type: "ready"; readonly sampleRate: number; readonly voice: string }
  | { readonly type: "phase"; readonly phase: VoiceCallPhase }
  /** What the owner is saying (partial while they speak, then final). */
  | { readonly type: "you"; readonly text: string; readonly final: boolean }
  /** A sentence the Bot is saying now. */
  | { readonly type: "bot"; readonly text: string }
  /** The owner started talking over the Bot: drop the audio not yet played. */
  | { readonly type: "stop" }
  | { readonly type: "error"; readonly message: string }

export type VoiceClientMessage =
  | { readonly type: "mute"; readonly muted: boolean }
  /** Everything the brain sent has been played. */
  | { readonly type: "played" }
  | { readonly type: "hangup" }
