// Voice calls (experiment) with the real models: Kokoro says a question, the brain hears it with
// Parakeet over /ws/voice, the voice model answers and Kokoro speaks; then work is handed to the Bot
// (Fake harness) and its answer is read back. Needs an installed voice folder (OPENBOT_LIVE_VOICE_DIR)
// and voice input (OPENBOT_LIVE_STT_DIR). OPENBOT_LIVE_VOICE=1 to run.
import { describe, expect, test } from "bun:test"
import type { Bot, VoiceServerMessage } from "@openbot/contracts"
import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { SpeechToTextLive } from "../../src/stt/service.ts"
import { toPcm16 } from "../../src/voice/call.ts"
import { startSpeaker, voiceLayout } from "../../src/voice/engine.ts"
import { VOICE_MANIFEST } from "../../src/voice/manifest.ts"
import { transcriptOf } from "@openbot/contracts"
import { Ref } from "effect"
import { eventually, login, rpcClient, startServer, watchConversation } from "../helpers.ts"

const LIVE = process.env["OPENBOT_LIVE_VOICE"] === "1"
const VOICE_DIR = process.env["OPENBOT_LIVE_VOICE_DIR"] ?? join(homedir(), ".cache", "openbot-live-voice")
const STT_DIR = process.env["OPENBOT_LIVE_STT_DIR"] ?? join(homedir(), ".local", "share", "openbot", "stt")
const CHUNK_MS = 100

/** 24 kHz → 16 kHz, linear. */
const to16k = (samples: Float32Array): Float32Array => {
  const out = new Float32Array(Math.floor((samples.length * 2) / 3))
  for (let i = 0; i < out.length; i++) {
    const at = i * 1.5
    const lo = Math.floor(at)
    out[i] = samples[lo]! + (samples[Math.min(lo + 1, samples.length - 1)]! - samples[lo]!) * (at - lo)
  }
  return out
}

describe.skipIf(!LIVE)("a voice call with the real models", () => {
  test("hears, answers out loud, hands work to the Bot and reads its answer", async () => {
    const speaker = await startSpeaker({
      layout: voiceLayout(VOICE_DIR),
      manifest: VOICE_MANIFEST,
      sherpaLibDir: join(STT_DIR, "runtime", "lib"),
      startupTimeoutMs: 60_000,
      speakTimeoutMs: 30_000,
    })
    const question = toPcm16(to16k(await speaker.speak("Hey Otto, how's it going today?", 16)))
    const work = toPcm16(to16k(await speaker.speak("Can you check if Anthony replied on Slack about the roles plan?", 16)))
    await speaker.stop()

    const server = await startServer({
      server: { speechToText: SpeechToTextLive({ dir: STT_DIR }), voiceCalls: { dir: VOICE_DIR, sttDir: STT_DIR } },
    })
    try {
      const cookie = await login(server.base, server.ownerToken)
      const bot = await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        return (yield* client["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "live-voice-otto", introduce: false })) as Bot
      }))

      const messages: Array<{ readonly at: number; readonly message: VoiceServerMessage }> = []
      const audio: Array<{ readonly at: number; readonly bytes: number }> = []
      const socket = new WebSocket(`${server.wsBase}/ws/voice/${bot.id}`, { headers: { cookie, origin: server.base } } as never)
      socket.binaryType = "arraybuffer"
      socket.onmessage = (event) => {
        if (typeof event.data === "string") messages.push({ at: performance.now(), message: JSON.parse(event.data) as VoiceServerMessage })
        else audio.push({ at: performance.now(), bytes: (event.data as ArrayBuffer).byteLength })
      }
      const waitFor = async (check: () => boolean, label: string, timeoutMs = 60_000) => {
        const until = Date.now() + timeoutMs
        while (!check()) {
          if (Date.now() > until) throw new Error(`timed out: ${label}\n${JSON.stringify(messages.map((m) => m.message), null, 1)}`)
          await Bun.sleep(50)
        }
      }
      const silence = (seconds: number) => new Uint8Array(Math.round(16_000 * seconds) * 2)
      /** Sends audio in real time, the way a microphone does; returns when it was all sent. */
      const stream = async (pcm: Uint8Array) => {
        const chunk = (16_000 * CHUNK_MS / 1000) * 2
        for (let at = 0; at < pcm.length; at += chunk) {
          socket.send(pcm.subarray(at, at + chunk))
          await Bun.sleep(CHUNK_MS)
        }
        return performance.now()
      }

      await waitFor(() => messages.some((m) => m.message.type === "ready"), "ready", 120_000)
      await stream(silence(0.6))
      const spoke = await stream(question)
      void stream(silence(2))
      await waitFor(() => audio.length > 0, "the first answer")
      const heard = messages.find((m) => m.message.type === "you" && m.message.final)?.message
      const firstAudioMs = Math.round(audio[0]!.at - spoke)
      await waitFor(() => messages.some((m) => m.message.type === "phase" && m.message.phase === "speaking"), "speaking")
      await Bun.sleep(2_500)
      const said = messages.filter((m) => m.message.type === "bot").map((m) => (m.message as { text: string }).text)
      socket.send(JSON.stringify({ type: "played" }))
      console.log(`heard: ${JSON.stringify(heard)}\nsaid: ${JSON.stringify(said)}\nfirst audio ${firstAudioMs} ms after the question ended`)
      expect(heard).toMatchObject({ type: "you", final: true })
      expect((heard as { text: string }).text.toLowerCase()).toContain("going")
      expect(said.length).toBeGreaterThan(0)

      // work for the Bot
      const before = messages.length
      await stream(work)
      void stream(silence(2))
      await waitFor(() => messages.slice(before).some((m) => m.message.type === "work" && !m.message.done), "work handed over")
      const handed = messages.slice(before).find((m) => m.message.type === "work")!.message
      await waitFor(() => messages.slice(before).some((m) => m.message.type === "work" && m.message.done), "the Bot's answer", 90_000)
      socket.send(JSON.stringify({ type: "played" }))
      const answerAt = messages.length
      await waitFor(() => messages.slice(answerAt).some((m) => m.message.type === "bot"), "the answer read out")
      await Bun.sleep(2_000)
      const told = messages.slice(answerAt).filter((m) => m.message.type === "bot").map((m) => (m.message as { text: string }).text)
      console.log(`handed over: ${JSON.stringify(handed)}\ntold: ${JSON.stringify(told)}`)
      expect((handed as { instruction: string }).instruction.toLowerCase()).toContain("anthony")
      // the exchange happened on the call: once told, the chat keeps nothing of it
      const left = await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        const convo = yield* watchConversation(client, bot.directConversationId)
        const state = yield* eventually(Ref.get(convo.state), (s) => s.synchronized && !transcriptOf(s).some((e) => e.kind === "message"), { label: "no messages left", timeout: 10_000 })
        return transcriptOf(state).map((e) => e.kind)
      }).pipe(Effect.scoped))
      console.log(`left in the chat: ${JSON.stringify(left)}`)
      socket.send(JSON.stringify({ type: "hangup" }))
      socket.close()
    } finally {
      await server.close()
    }
  }, 300_000)
})
