/**
 * Voice calls' files and processes (experiment): `<data>/voice` holds llama.cpp's server (`runner/`),
 * the voice model (`model/model.gguf`) and Kokoro (`voices/`). A call starts two processes: the
 * thinker (llama-server on a loopback port) and the speaker (Kokoro through sherpa-onnx, the library
 * voice input installed).
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { availableParallelism } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SttArchive } from "../stt/manifest.ts"
import { archiveFileName, downloadVerified, errorReason, killGroup, libraryPathWith, sharedLibraryName, unpackSingleFolder } from "../stt/engine.ts"
import type { VoiceManifest } from "./manifest.ts"
import type { SpeakerLaunch, SpeakerReply, SpeakerRequest } from "./speaker-protocol.ts"

export interface VoiceLayout {
  readonly root: string
  readonly runner: string
  readonly model: string
  readonly voices: string
  readonly work: string
  readonly marker: string
}

export const voiceLayout = (root: string): VoiceLayout => ({
  root,
  runner: path.join(root, "runner"),
  model: path.join(root, "model", "model.gguf"),
  voices: path.join(root, "voices"),
  work: path.join(root, "work"),
  marker: path.join(root, "installed.json"),
})

const SPEAKER_PROCESS_ENTRY = fileURLToPath(new URL("./speaker-process.ts", import.meta.url))
const STOP_GRACE_MS = 2_000
const STDERR_TAIL_CHARS = 2_000
const MAX_SPEAKER_THREADS = 4
const MAX_THINKER_THREADS = 8
const THINKER_CONTEXT_TOKENS = 8_192
const HEALTH_POLL_MS = 250

const markerOf = (runner: SttArchive, manifest: VoiceManifest) => [runner.sha256, manifest.model.file.sha256, manifest.voices.archive.sha256].join(",")

export const isVoiceInstalled = async (layout: VoiceLayout, runner: SttArchive, manifest: VoiceManifest): Promise<boolean> => {
  try {
    return (await readFile(layout.marker, "utf8")).trim() === markerOf(runner, manifest)
  } catch {
    return false
  }
}

export const downloadVoice = async (
  layout: VoiceLayout,
  runner: SttArchive,
  manifest: VoiceManifest,
  onProgress: (downloadedBytes: number, downloadBytes: number) => void,
  signal: AbortSignal,
): Promise<void> => {
  await rm(layout.root, { recursive: true, force: true })
  await mkdir(layout.work, { recursive: true })
  const downloadBytes = runner.bytes + manifest.model.file.bytes + manifest.voices.archive.bytes
  let completedBytes = 0
  const fetchOne = async (archive: SttArchive) => {
    const file = path.join(layout.work, archiveFileName(archive))
    await downloadVerified(archive, file, (received) => onProgress(completedBytes + received, downloadBytes), signal)
    completedBytes += archive.bytes
    return file
  }
  try {
    await unpackSingleFolder(await fetchOne(runner), layout.runner, path.join(layout.work, "staging"))
    await unpackSingleFolder(await fetchOne(manifest.voices.archive), layout.voices, path.join(layout.work, "staging"))
    const model = await fetchOne(manifest.model.file)
    await mkdir(path.dirname(layout.model), { recursive: true })
    await rename(model, layout.model)
    await rm(layout.work, { recursive: true, force: true })
    await writeFile(layout.marker, markerOf(runner, manifest))
  } catch (error) {
    await rm(layout.root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------- processes

interface Child {
  readonly pid: number
  readonly stop: () => Promise<void>
  readonly alive: () => boolean
}

const stopChild = async (child: Bun.Subprocess) => {
  killGroup(child.pid, "SIGTERM")
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)])
  if (!exited) killGroup(child.pid, "SIGKILL")
  await child.exited
}

const collectStderr = (child: Bun.Subprocess<"ignore", "ignore", "pipe">) => {
  let tail = ""
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS)
  })().catch(() => undefined)
  return () => tail
}

export interface Speaker extends Child {
  readonly sampleRate: number
  readonly speak: (text: string, sid: number, speed?: number) => Promise<Float32Array>
}

/** Kokoro in its own process (`sherpaLibrary`: voice input's libsherpa-onnx-c-api). */
export const startSpeaker = (input: { readonly layout: VoiceLayout; readonly manifest: VoiceManifest; readonly sherpaLibDir: string; readonly startupTimeoutMs: number; readonly speakTimeoutMs: number }): Promise<Speaker> =>
  new Promise((resolveStarted, rejectStarted) => {
    const voices = input.manifest.voices
    const launch: SpeakerLaunch = {
      library: path.join(input.sherpaLibDir, sharedLibraryName()),
      model: path.join(input.layout.voices, voices.model),
      voices: path.join(input.layout.voices, voices.voices),
      tokens: path.join(input.layout.voices, voices.tokens),
      dataDir: path.join(input.layout.voices, voices.dataDir),
      lexicon: path.join(input.layout.voices, voices.lexicon),
      lang: voices.lang,
      threads: Math.max(1, Math.min(MAX_SPEAKER_THREADS, availableParallelism())),
    }
    const waiting = new Map<number, (outcome: Float32Array | Error) => void>()
    let nextId = 0
    let broken = false
    let sampleRate = 0
    const child = Bun.spawn([process.execPath, SPEAKER_PROCESS_ENTRY, JSON.stringify(launch)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      detached: true,
      serialization: "advanced",
      env: { ...process.env, LD_LIBRARY_PATH: libraryPathWith(input.sherpaLibDir) },
      ipc: (message: SpeakerReply) => {
        if (message.type === "ready") {
          clearTimeout(startupTimer)
          sampleRate = message.sampleRate
          resolveStarted({ ...speaker, sampleRate })
          return
        }
        if (message.type === "failed") {
          broken = true
          rejectStarted(new Error(message.message))
          return
        }
        const settle = waiting.get(message.id)
        waiting.delete(message.id)
        settle?.(message.type === "spoken" ? message.samples : new Error(message.message))
      },
    })
    const stderrTail = collectStderr(child)
    const startupTimer = setTimeout(() => {
      broken = true
      killGroup(child.pid, "SIGKILL")
      rejectStarted(new Error(`Kokoro did not start within ${input.startupTimeoutMs / 1000} s.`))
    }, input.startupTimeoutMs)
    void child.exited.then((exitCode) => {
      clearTimeout(startupTimer)
      broken = true
      const tail = stderrTail().trim()
      const exited = new Error(`Kokoro exited with code ${exitCode}.${tail === "" ? "" : ` ${errorReason(tail)}`}`)
      for (const settle of waiting.values()) settle(exited)
      waiting.clear()
      rejectStarted(exited)
    })
    const speak = (text: string, sid: number, speed = 1) =>
      new Promise<Float32Array>((resolve, reject) => {
        if (broken) return reject(new Error("Kokoro is not running."))
        const id = nextId++
        const timer = setTimeout(() => {
          broken = true
          killGroup(child.pid, "SIGKILL")
        }, input.speakTimeoutMs)
        waiting.set(id, (outcome) => {
          clearTimeout(timer)
          if (outcome instanceof Error) reject(outcome)
          else resolve(outcome)
        })
        const request: SpeakerRequest = { id, text, sid, speed }
        child.send(request)
      })
    const speaker: Omit<Speaker, "sampleRate"> = {
      pid: child.pid,
      speak,
      stop: async () => {
        broken = true
        await stopChild(child)
      },
      alive: () => !broken && child.exitCode === null,
    }
  })

export interface Thinker extends Child {
  /** `http://127.0.0.1:<port>`: llama-server's OpenAI-compatible API. */
  readonly url: string
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })

const runnerBinary = (layout: VoiceLayout): string => path.join(layout.runner, "llama-server")

/** llama-server with the voice model, on a free loopback port; resolves once it answers /health. */
export const startThinker = async (input: { readonly layout: VoiceLayout; readonly startupTimeoutMs: number }): Promise<Thinker> => {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const child = Bun.spawn([
    runnerBinary(input.layout),
    "-m", input.layout.model,
    "-ngl", "999",
    "-c", String(THINKER_CONTEXT_TOKENS),
    "--jinja",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--no-webui",
    "-t", String(Math.max(1, Math.min(MAX_THINKER_THREADS, availableParallelism()))),
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
    env: { ...process.env, LD_LIBRARY_PATH: libraryPathWith(input.layout.runner) },
  })
  const stderrTail = collectStderr(child)
  let exited = false
  void child.exited.then(() => {
    exited = true
  })
  const deadline = Date.now() + input.startupTimeoutMs
  for (;;) {
    if (exited) throw new Error(`The voice model exited while starting. ${errorReason(stderrTail())}`)
    if (Date.now() > deadline) {
      await stopChild(child)
      throw new Error(`The voice model did not start within ${input.startupTimeoutMs / 1000} s.`)
    }
    const healthy = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false)
    if (healthy) break
    await Bun.sleep(HEALTH_POLL_MS)
  }
  return {
    pid: child.pid,
    url,
    stop: () => stopChild(child),
    alive: () => !exited,
  }
}
