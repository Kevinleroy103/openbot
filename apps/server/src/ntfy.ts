/** ntfy (D3.6): the owner's notifications on any phone with the ntfy app, pushed through push.ts. */
import { InvalidInput, NTFY_DISCONNECTED, NTFY_URL, type NtfyStatus } from "@openbot/contracts"
import { LiveHub } from "@openbot/core"
import { Context, Effect, Layer, Schema } from "effect"
import { ServerConfig } from "./config.ts"
import { clip, makePush, needsYou, notificationText, type PushService } from "./push.ts"

export interface NtfyConnect {
  readonly topic: string
  /** Absent or blank: ntfy.sh. */
  readonly server?: string | undefined
  readonly token?: string | undefined
}

export class Ntfy extends Context.Service<Ntfy, PushService<NtfyStatus, NtfyConnect>>()("openbot/server/Ntfy") {}

export interface NtfyOptions {
  /** Where the topic is kept (`DataDir.ntfy`). */
  readonly file: string
  readonly fetch?: typeof fetch | undefined
}

const NtfyTarget = Schema.Struct({
  server: Schema.String,
  topic: Schema.String,
  token: Schema.optionalKey(Schema.String),
})
type NtfyTarget = typeof NtfyTarget.Type

/** A topic ntfy accepts: letters, digits, `_` and `-`, up to 64. */
export const ntfyTopic = (text: string): string | undefined => {
  const topic = text.trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(topic) ? topic : undefined
}

/** An ntfy server's address (`https://ntfy.example.com`), without a trailing slash; blank is ntfy.sh. */
export const ntfyServer = (text: string | undefined): string | undefined => {
  const server = (text ?? "").trim().replace(/\/+$/, "")
  if (server === "") return NTFY_URL
  try {
    const url = new URL(server)
    return url.protocol === "http:" || url.protocol === "https:" ? server : undefined
  } catch {
    return undefined
  }
}

const ntfyTarget = (input: NtfyConnect): Effect.Effect<NtfyTarget, InvalidInput> => {
  const topic = ntfyTopic(input.topic)
  if (topic === undefined) {
    return Effect.fail(new InvalidInput({ message: "A topic is letters, digits, _ and -, up to 64 characters." }))
  }
  const server = ntfyServer(input.server)
  if (server === undefined) {
    return Effect.fail(new InvalidInput({ message: "The server is an address like https://ntfy.example.com." }))
  }
  const token = input.token?.trim() ?? ""
  return Effect.succeed({ server, topic, ...(token === "" ? {} : { token }) })
}

const refused = (response: Response) => {
  switch (response.status) {
    case 401:
    case 403:
      return "ntfy refused it: this server needs an access token that can publish to the topic."
    case 404:
      return "ntfy doesn't answer there: check the server address."
    case 413:
      return "ntfy found the notification too large."
    case 429:
      return "ntfy's limit for now was reached; notifications resume in a minute."
    default:
      return `ntfy refused it (HTTP ${response.status}).`
  }
}

export const makeNtfy = (options: NtfyOptions) =>
  Effect.gen(function* () {
    const push = yield* makePush({
      name: "ntfy",
      file: options.file,
      what: "topic",
      target: NtfyTarget,
      disconnected: NTFY_DISCONNECTED,
      show: (status, target) => ({ ...status, server: target.server, topic: target.topic }),
      body: (n, link) =>
        Effect.succeed({
          title: clip(n.title, 250),
          message: clip(notificationText(n), 3_500),
          ...(needsYou(n) ? { priority: 4 } : {}),
          ...(link === undefined ? {} : { click: link }),
        }),
      testBody: (link) => ({
        title: "OpenBot",
        message: "Connected. Your Bots' notifications will show up here.",
        ...(link === undefined ? {} : { click: link }),
      }),
      request: (target, body) => ({
        url: target.server,
        ...(target.token === undefined ? {} : { headers: { authorization: `Bearer ${target.token}` } }),
        json: { topic: target.topic, ...body },
      }),
      refused,
      fetch: options.fetch,
    })
    return Ntfy.of({ ...push, connect: (input) => Effect.flatMap(ntfyTarget(input), push.connect) })
  })

export const NtfyLive = (options: NtfyOptions): Layer.Layer<Ntfy, never, ServerConfig | LiveHub> =>
  Layer.effect(Ntfy, makeNtfy(options))
