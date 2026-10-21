// Voice calls (experiment): turn taking, speaking sentence by sentence, handing work to the Bot and being
// talked over, with stand-ins for Parakeet, the voice model and Kokoro.
import { describe, expect, test } from "bun:test"
import type { VoiceServerMessage } from "@openbot/contracts"
import { CALL_INPUT_SAMPLE_RATE, type CallDeps, toPcm16, VoiceCall } from "../src/voice/call.ts"
import type { ChatMessage, ReplyEvent, VoiceReply } from "../src/voice/reply.ts"

const tone = (seconds: number, amplitude = 0.3) => {
  const samples = new Float32Array(Math.round(CALL_INPUT_SAMPLE_RATE * seconds))
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / CALL_INPUT_SAMPLE_RATE)
  return toPcm16(samples)
}
const quiet = (seconds: number) => tone(seconds, 0.001)

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10)
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

const makeCall = (script: {
  readonly heard: ReadonlyArray<string>
  readonly replies: ReadonlyArray<VoiceReply>
  readonly speakMs?: number
  readonly answer?: Promise<string>
}) => {
  const sent: Array<VoiceServerMessage> = []
  const audio: Array<number> = []
  const prompts: Array<ReadonlyArray<ChatMessage>> = []
  const delegated: Array<{ instruction: string; words: string }> = []
  let heard = 0
  let replied = 0
  const deps: CallDeps = {
    transcribe: async () => {
      const text = script.heard[heard++] ?? ""
      return { append: async () => text.split(" ")[0] ?? "", finish: async () => text, discard: () => undefined }
    },
    reply: (messages, signal) => {
      prompts.push(messages)
      const reply = script.replies[replied++]!
      return (async function*(): AsyncGenerator<ReplyEvent> {
        for (const word of reply.say.split(/(?<= )/)) {
          if (signal.aborted) return
          await Bun.sleep(5)
          yield { type: "say", text: word }
        }
        yield { type: "done", reply }
      })()
    },
    speak: async (text) => {
      await Bun.sleep(script.speakMs ?? 1)
      return new Float32Array(text.length * 10)
    },
    delegate: async (work) => {
      delegated.push(work)
      return script.answer ?? "done"
    },
    systemPrompt: async () => "You are Otto's voice.",
    send: (message) => sent.push(message),
    sendAudio: (pcm) => audio.push(pcm.length),
    log: () => undefined,
  }
  const call = new VoiceCall(deps)
  call.start()
  return { call, sent, audio, prompts, delegated }
}

describe("a voice call", () => {
  test("hears a sentence, answers sentence by sentence, then listens again", async () => {
    const { call, sent, audio, prompts } = makeCall({
      heard: ["How's it going?"],
      replies: [{ action: "talk", say: "Pretty good. Just finished the roles plan.", instruction: "" }],
    })
    await say(call, quiet(0.5))
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => sent.some((m) => m.type === "bot" && m.text === "Just finished the roles plan."), "the reply")
    call.played()
    await until(() => sent.at(-1)?.type === "phase", "listening")
    expect(sent.filter((m) => m.type === "you" && m.final)).toEqual([{ type: "you", text: "How's it going?", final: true }])
    expect(sent.filter((m) => m.type === "bot").map((m) => m.type === "bot" && m.text)).toEqual(["Pretty good.", "Just finished the roles plan."])
    expect(audio).toHaveLength(2)
    expect(sent.filter((m) => m.type === "phase").map((m) => m.type === "phase" && m.phase)).toEqual(["listening", "hearing", "thinking", "speaking", "listening"])
    expect(prompts[0]).toEqual([{ role: "system", content: "You are Otto's voice." }, { role: "user", content: "How's it going?" }])
  })

  test("work goes to the Bot with the owner's words, and its answer is told at the next quiet moment", async () => {
    let answer!: (text: string) => void
    const { call, sent, delegated, prompts } = makeCall({
      heard: ["Did Anthony reply on Slack?"],
      replies: [
        { action: "delegate", say: "On it.", instruction: "Check Slack for Anthony's reply." },
        { action: "talk", say: "He says the plan looks good.", instruction: "" },
      ],
      answer: new Promise((resolve) => {
        answer = resolve
      }),
    })
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => delegated.length === 1, "the delegation")
    expect(delegated).toEqual([{ instruction: "Check Slack for Anthony's reply.", words: "Did Anthony reply on Slack?" }])
    expect(sent).toContainEqual({ type: "work", id: "work-1", instruction: "Check Slack for Anthony's reply.", done: false })
    call.played()
    answer("Anthony: plan looks good, ship Thursday.")
    await until(() => sent.some((m) => m.type === "bot" && m.text === "He says the plan looks good."), "the result told")
    expect(sent).toContainEqual({ type: "work", id: "work-1", instruction: "Check Slack for Anthony's reply.", done: true })
    expect(prompts[1]!.at(-1)).toEqual({ role: "user", content: "RESULT from your full self (the work: \"Check Slack for Anthony's reply.\"):\nAnthony: plan looks good, ship Thursday." })
  })

  test("talking over the Bot stops it; a quiet murmur while it speaks does not", async () => {
    const { call, sent } = makeCall({
      heard: ["Tell me everything.", "Wait, stop."],
      replies: [
        { action: "talk", say: "First thing. Second thing. Third thing. Fourth thing.", instruction: "" },
        { action: "talk", say: "Sure.", instruction: "" },
      ],
      speakMs: 30,
    })
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => sent.some((m) => m.type === "bot"), "speaking")
    // its own voice leaking back quietly is not the owner
    await say(call, tone(0.5, 0.004))
    expect(sent.some((m) => m.type === "stop")).toBe(false)
    await say(call, tone(0.6))
    expect(sent).toContainEqual({ type: "stop" })
    await say(call, quiet(0.8))
    await until(() => sent.some((m) => m.type === "bot" && m.text === "Sure."), "the second reply")
    expect(sent.filter((m) => m.type === "bot").map((m) => m.type === "bot" && m.text)).not.toContain("Fourth thing.")
  })
})
