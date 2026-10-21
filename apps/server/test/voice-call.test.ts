// Voice calls (experiment): turn taking, the owner's words going to the Bot, what the Bot writes being
// spoken as it streams, fillers while it is slow to start, and being talked over. Stand-ins for
// Parakeet and Kokoro; the Bot is played by the test.
import { describe, expect, test } from "bun:test"
import type { VoiceServerMessage } from "@openbot/contracts"
import { CALL_INPUT_SAMPLE_RATE, type CallDeps, FILLERS, toPcm16, VoiceCall } from "../src/voice/call.ts"

const tone = (seconds: number, amplitude = 0.3) => {
  const samples = new Float32Array(Math.round(CALL_INPUT_SAMPLE_RATE * seconds))
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / CALL_INPUT_SAMPLE_RATE)
  return toPcm16(samples)
}
const quiet = (seconds: number) => tone(seconds, 0.001)

const until = async (check: () => boolean, label: string, timeoutMs = 2_000) => {
  for (let waited = 0; waited < timeoutMs && !check(); waited += 10) await Bun.sleep(10)
  if (!check()) throw new Error(`timed out: ${label}`)
}

/** Feeds audio in 100 ms chunks, the way the app sends it. */
const say = async (call: VoiceCall, pcm: Uint8Array) => {
  const chunk = CALL_INPUT_SAMPLE_RATE * 0.1 * 2
  for (let at = 0; at < pcm.length; at += chunk) {
    call.audio(pcm.subarray(at, at + chunk))
    await Bun.sleep(1)
  }
}

const makeCall = (heard: ReadonlyArray<string>, speakMs = 1) => {
  const sent: Array<VoiceServerMessage> = []
  const audio: Array<number> = []
  const asked: Array<{ words: string; first: boolean }> = []
  let next = 0
  const deps: CallDeps = {
    transcribe: async () => {
      const text = heard[next++] ?? ""
      return { append: async () => text.split(" ")[0] ?? "", finish: async () => text, discard: () => undefined }
    },
    speak: async (text) => {
      await Bun.sleep(speakMs)
      return new Float32Array(text.length * 10)
    },
    ask: (words, first) => void asked.push({ words, first }),
    send: (message) => sent.push(message),
    sendAudio: (pcm) => audio.push(pcm.length),
    log: () => undefined,
  }
  const call = new VoiceCall(deps)
  call.start()
  const spoken = () => sent.flatMap((m) => (m.type === "bot" ? [m.text] : []))
  return { call, sent, audio, asked, spoken }
}

/** The Bot writing a message, a few words at a time. */
const stream = async (call: VoiceCall, id: string, text: string) => {
  const words = text.split(/(?<= )/)
  let so = ""
  for (const word of words) {
    so += word
    call.botText(id, so, false)
    await Bun.sleep(2)
  }
  call.botText(id, so, true)
}

describe("a voice call", () => {
  test("the owner's words go to the Bot; what it writes is spoken sentence by sentence as it streams", async () => {
    const { call, sent, audio, asked, spoken } = makeCall(["How's it going?", "And tomorrow?"])
    await say(call, quiet(0.5))
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    expect(asked).toEqual([{ words: "How's it going?", first: true }])
    expect(sent).toContainEqual({ type: "you", text: "How's it going?", final: true })
    await stream(call, "m1", "Pretty **good**. Just finished the roles plan")
    await until(() => spoken().length === 2, "spoken")
    expect(spoken()).toEqual(["Pretty good.", "Just finished the roles plan."])
    expect(audio).toHaveLength(2)
    call.botDone(false)
    call.played()
    await until(() => sent.at(-1)?.type === "phase", "listening")
    expect(sent.filter((m) => m.type === "phase").map((m) => m.type === "phase" && m.phase)).toEqual(["listening", "hearing", "thinking", "speaking", "listening"])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 2, "asked again")
    expect(asked[1]).toEqual({ words: "And tomorrow?", first: false })
    expect(call.summary().lines).toEqual([
      { who: "you", text: "How's it going?" },
      { who: "bot", text: "Pretty good. Just finished the roles plan." },
      { who: "you", text: "And tomorrow?" },
    ])
  })

  test("while the Bot is slow to start, a short filler keeps the line alive (not in the transcript)", async () => {
    const { call, asked, spoken } = makeCall(["What's on my calendar?"])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    await until(() => spoken().length === 1, "a filler", 3_000)
    expect(FILLERS).toContain(spoken()[0]!)
    call.played()
    await stream(call, "m1", "Two meetings tomorrow.")
    await until(() => spoken().length === 2, "the answer")
    expect(call.summary().lines.map((l) => l.text)).toEqual(["What's on my calendar?", "Two meetings tomorrow."])
  })

  test("a silent reply says nothing; a failed turn says so", async () => {
    const { call, asked, spoken } = makeCall(["Thanks."])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    await stream(call, "m1", "NO_REPLY")
    call.botDone(true)
    await until(() => spoken().length === 1, "the apology")
    expect(spoken()).toEqual(["Sorry, I couldn't do that just now."])
  })

  test("talking over the Bot stops its voice and drops the rest of that message; a quiet murmur does not", async () => {
    const { call, sent, asked, spoken } = makeCall(["Tell me everything.", "Wait, stop."], 30)
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    void stream(call, "m1", "First thing. Second thing. Third thing. Fourth thing. Fifth thing. Sixth thing.")
    await until(() => spoken().length >= 1, "speaking")
    // its own voice leaking back quietly is not the owner
    await say(call, tone(0.5, 0.004))
    expect(sent.some((m) => m.type === "stop")).toBe(false)
    await say(call, tone(0.6))
    expect(sent).toContainEqual({ type: "stop" })
    await say(call, quiet(0.8))
    await until(() => asked.length === 2, "asked again")
    await Bun.sleep(150)
    expect(spoken()).not.toContain("Sixth thing.")
    // the Bot's next message is spoken
    await stream(call, "m2", "Sure, stopping.")
    await until(() => spoken().includes("Sure, stopping."), "the next message")
  })
})
