// The app's connection to the owner's OpenBot: its origin and a session token of its own, kept in
// the iOS keychain (expo-secure-store). The owner connects with the code shown under Settings ›
// iPhone app (`openbot://connect?origin=…&code=…`, scanned or pasted) or with the login link OpenBot
// printed (`https://box/?token=…`); either is traded for a session (`POST /api/auth/app-login`),
// sent as `Authorization: Bearer`.
import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

export interface Connection {
  /** `https://host[:port]`, no trailing slash */
  readonly origin: string
  readonly sessionToken: string
}

export type ConnectInput =
  | { readonly origin: string; readonly token: string }
  | { readonly origin: string; readonly code: string }

const KEY = "openbot.connection.v1"

const store = {
  get: (): Promise<string | null> =>
    Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.getItem(KEY) ?? null) : SecureStore.getItemAsync(KEY),
  set: (value: string): Promise<void> =>
    Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.setItem(KEY, value)) : SecureStore.setItemAsync(KEY, value),
  remove: (): Promise<void> =>
    Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.removeItem(KEY)) : SecureStore.deleteItemAsync(KEY),
}

export const loadConnection = async (): Promise<Connection | undefined> => {
  try {
    const raw = await store.get()
    if (!raw) return undefined
    const c = JSON.parse(raw) as Partial<Connection>
    return typeof c.origin === "string" && typeof c.sessionToken === "string" ? { origin: c.origin, sessionToken: c.sessionToken } : undefined
  } catch {
    return undefined
  }
}

export const saveConnection = (c: Connection): Promise<void> => store.set(JSON.stringify(c))
export const clearConnection = (): Promise<void> => store.remove()

const originOf = (raw: string): string | undefined => {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** What the owner pasted or scanned → where to connect and with what; a string says what is wrong. */
export const parseConnectInput = (text: string): ConnectInput | string => {
  const trimmed = text.trim()
  if (trimmed === "") return "Paste the link or scan the code first."
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return "That isn't a link. Copy the whole link, starting with https://."
  }
  if (url.protocol === "openbot:") {
    const origin = originOf(url.searchParams.get("origin") ?? "")
    const code = url.searchParams.get("code")
    if (!origin || !code) return "That code is incomplete. Show a new one under Settings › iPhone app."
    return { origin, code }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "That isn't an OpenBot link."
  const token = url.searchParams.get("token")
  if (!token) return "That link has no login token. Use the login link OpenBot printed, or the code under Settings › iPhone app."
  return { origin: url.origin, token }
}

/** Trades the code or token for a session of the app's own. Throws with a message for the owner. */
export const connect = async (input: ConnectInput): Promise<Connection> => {
  let res: Response
  try {
    res = await fetch(`${input.origin}/api/auth/app-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("code" in input ? { code: input.code } : { token: input.token }),
    })
  } catch {
    throw new Error(`Can't reach ${new URL(input.origin).host}. Is this phone on the same network (Tailscale) as OpenBot?`)
  }
  const body = (await res.json().catch(() => ({}))) as { sessionToken?: string; error?: string }
  if (!res.ok || typeof body.sessionToken !== "string") throw new Error(body.error ?? `OpenBot answered ${res.status}.`)
  return { origin: input.origin, sessionToken: body.sessionToken }
}

/** The session as a bearer token, for the RPC socket, images and fetches. */
export const sessionHeaders = (c: Connection): Record<string, string> => ({ authorization: `Bearer ${c.sessionToken}` })

/**
 * A URL that signs a web view in with the app's own session and opens `path` (a hash route of the
 * web app): a one-time code from `POST /api/auth/web-code`.
 */
export const webPageUrl = async (c: Connection, path: string): Promise<string> => {
  const res = await fetch(`${c.origin}/api/auth/web-code`, { method: "POST", headers: sessionHeaders(c) })
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
  if (!res.ok || typeof body.code !== "string") throw new Error(body.error ?? `OpenBot answered ${res.status}.`)
  return `${c.origin}/api/auth/login?code=${encodeURIComponent(body.code)}&next=${encodeURIComponent(path)}`
}
