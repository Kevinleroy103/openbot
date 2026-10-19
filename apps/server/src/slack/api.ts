/**
 * Slack Web API calls (D3.4): `POST <api>/<method>` with the token as a Bearer header and the
 * arguments form-encoded. `{ok: false, error}` becomes a `SlackApiError`; a 429 waits for
 * `Retry-After` (up to 30 s) and tries once more.
 */
import { InvalidInput, Unavailable } from "@openbot/contracts"

export const SLACK_API_URL = "https://slack.com/api"

export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    /** For `missing_scope`: the scope Slack wanted. */
    readonly needed?: string | undefined,
  ) {
    super(`Slack: ${code}${needed === undefined ? "" : ` (${needed})`}`)
  }
}

/** Key of the token's scopes (`x-oauth-scopes`) on a call's result. */
export const SCOPES = "__scopes"

export type SlackArgs = Record<string, string | number | boolean | undefined>

export interface SlackApi {
  readonly call: (token: string, method: string, args?: SlackArgs) => Promise<Record<string, any>>
}

const TIMEOUT_MS = 20_000
const MAX_RETRY_AFTER_S = 30

export const makeSlackApi = (options?: { readonly baseUrl?: string | undefined; readonly fetch?: typeof fetch | undefined }): SlackApi => {
  const base = (options?.baseUrl ?? SLACK_API_URL).replace(/\/+$/, "")
  const fetchImpl = options?.fetch ?? fetch
  const call = async (token: string, method: string, args: SlackArgs = {}, retried = false): Promise<Record<string, any>> => {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(args)) if (value !== undefined) body.set(key, String(value))
    let response: Response
    try {
      response = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      throw new SlackApiError(cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "unreachable")
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? "5")
      if (retried || !(wait <= MAX_RETRY_AFTER_S)) throw new SlackApiError("ratelimited")
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait) * 1000))
      return call(token, method, args, true)
    }
    if (!response.ok) throw new SlackApiError(`http_${response.status}`)
    const json = (await response.json().catch(() => undefined)) as Record<string, any> | undefined
    if (json === undefined) throw new SlackApiError("bad_response")
    if (json.ok !== true) throw new SlackApiError(String(json.error ?? "unknown_error"), typeof json.needed === "string" ? json.needed : undefined)
    // the token's scopes (Slack sends them on every call), for checking a new connection
    const scopes = response.headers.get("x-oauth-scopes")
    return scopes === null ? json : { ...json, [SCOPES]: scopes.split(",").map((scope) => scope.trim()).filter((scope) => scope !== "") }
  }
  return { call: (token, method, args) => call(token, method, args) }
}

const REJECTED = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission"])

/** What the owner or a Bot reads when a Slack call failed. */
export const describeSlackError = (error: unknown): InvalidInput | Unavailable => {
  if (!(error instanceof SlackApiError)) {
    return new Unavailable({ message: `Slack did not answer (${error instanceof Error ? error.message : String(error)}).` })
  }
  switch (error.code) {
    case "channel_not_found":
      return new InvalidInput({ message: "That Slack conversation was not found, or the owner can't see it." })
    case "not_in_channel":
      return new InvalidInput({ message: "The owner isn't in that channel." })
    case "thread_not_found":
    case "message_not_found":
      return new InvalidInput({ message: "That Slack message or thread was not found." })
    case "user_not_found":
      return new InvalidInput({ message: "That person was not found in Slack." })
    case "is_archived":
      return new InvalidInput({ message: "That channel is archived." })
    case "msg_too_long":
      return new InvalidInput({ message: "The message is too long for Slack." })
    case "missing_scope":
      return new Unavailable({
        message: `The Slack app lacks the "${error.needed ?? "?"}" permission: add it under OAuth & Permissions › User Token Scopes, reinstall the app and connect again.`,
      })
    case "ratelimited":
      return new Unavailable({ message: "Slack asked to slow down; try again in a minute." })
    case "timeout":
    case "unreachable":
      return new Unavailable({ message: "Slack did not answer; try again in a minute." })
    default:
      return REJECTED.has(error.code)
        ? new Unavailable({ message: "Slack no longer accepts OpenBot's token. Connect Slack again in Connect apps › Slack." })
        : new Unavailable({ message: `Slack refused (${error.code}).` })
  }
}
