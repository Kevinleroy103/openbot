/**
 * The narrow slice of `@opencode/client` (2.0.29 Promise API) the adapter uses, declared
 * STRUCTURALLY so no SDK type leaves this package (AGENTS.md). {@link makeOpenCodeClient} checks at
 * compile time that the real client returned by `OpenCode.make` is assignable to
 * {@link OpenCodeApi}; tests provide a scripted fake of the same shape.
 *
 * Events are typed loosely ({@link OpenCodeEvent}): the server's event set changes between minor
 * versions, so the normalizer decodes each frame on its own and skips unknown types
 * (sdk-opencode.md §7.2, "Forward compatibility").
 */
import { OpenCode } from "@opencode/client"

/** Per-call options (the client's `RequestOptions` subset OpenBot uses). */
export interface CallOptions {
  readonly signal?: AbortSignal
}

type Call<I, O> = (input: I, options?: CallOptions) => Promise<O>

/** Native permission rule (`{action, resource, effect}`; glob wildcards; last match wins). */
export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** `ModelRef` as used by `session.create` / `switchModel`. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** Location of a directory-scoped call. */
export interface LocationRef {
  readonly location: { readonly directory: string }
}

/** Session metadata (JSON; OpenBot writes `{openbot: {botId, conversationId, sessionKey}}`). */
export type SessionMetadata = Readonly<Record<string, Readonly<Record<string, string>>>>

/** A remote MCP server registration (`mcp.add` `config`). */
export interface RemoteMcpConfig {
  readonly type: "remote"
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly oauth?: false
  readonly codemode?: boolean
}

/** `mcp.list` entry: `connected` | `pending` | `disabled` | `failed{error}` | `needs_auth{error?}`. */
export interface McpServerStatus {
  readonly name: string
  readonly status: { readonly status: string; readonly error?: string }
}

/** `model.list` entry (fields OpenBot reads). */
export interface ModelEntry {
  readonly providerID: string
  readonly id: string
  readonly name: string
  readonly variants?: ReadonlyArray<{ readonly id: string }>
  readonly limit?: { readonly context?: number }
  readonly enabled?: boolean
  readonly status?: string
}

export interface OpenCodeApi {
  readonly server: {
    readonly info: (options?: CallOptions) => Promise<{ readonly version: string }>
  }
  readonly event: {
    readonly subscribe: (options?: {
      readonly signal?: AbortSignal
      readonly onActivity?: () => void
    }) => AsyncIterable<OpenCodeEvent>
  }
  readonly session: {
    readonly create: Call<{
      readonly title?: string
      readonly location?: { readonly directory: string }
      readonly metadata?: SessionMetadata
      readonly permissions?: ReadonlyArray<PermissionRule>
      readonly model?: ModelRef
    }, { readonly id: string }>
    readonly get: Call<{ readonly sessionID: string }, { readonly id: string; readonly location?: { readonly directory: string } }>
    readonly update: Call<{
      readonly sessionID: string
      readonly metadata?: SessionMetadata
      readonly permissions?: ReadonlyArray<PermissionRule>
    }, unknown>
    readonly switchModel: Call<{ readonly sessionID: string; readonly model: ModelRef }, unknown>
    readonly prompt: Call<{
      readonly sessionID: string
      readonly text: string
      readonly delivery?: "steer" | "queue"
      readonly files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>
    }, unknown>
    readonly interrupt: Call<{ readonly sessionID: string }, { readonly interrupted: boolean }>
    readonly compact: Call<{ readonly sessionID: string }, unknown>
    readonly instructions: {
      readonly entry: {
        readonly list: Call<{ readonly sessionID: string }, ReadonlyArray<{ readonly key: string; readonly value: unknown }>>
        readonly put: Call<{ readonly sessionID: string; readonly key: string; readonly value: string }, unknown>
        readonly remove: Call<{ readonly sessionID: string; readonly key: string }, unknown>
      }
    }
    readonly form: {
      readonly reply: Call<{
        readonly sessionID: string
        readonly formID: string
        readonly answer: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>
      }, unknown>
      readonly cancel: Call<{ readonly sessionID: string; readonly formID: string; readonly message?: string }, unknown>
    }
  }
  readonly permission: {
    readonly reply: Call<{
      readonly sessionID: string
      readonly requestID: string
      readonly decision: "once" | "always" | "reject"
      readonly message?: string
    }, unknown>
  }
  readonly mcp: {
    readonly add: Call<LocationRef & { readonly server: string; readonly config: RemoteMcpConfig }, unknown>
    readonly remove: Call<LocationRef & { readonly server: string }, unknown>
    readonly list: Call<LocationRef, { readonly data: ReadonlyArray<McpServerStatus> }>
  }
  readonly model: {
    readonly list: Call<LocationRef, { readonly data: ReadonlyArray<ModelEntry> }>
    readonly default: Call<LocationRef, { readonly data: { readonly providerID: string; readonly id: string } | null }>
  }
  readonly integration: {
    readonly list: Call<LocationRef, { readonly data: ReadonlyArray<{ readonly name: string; readonly connections: ReadonlyArray<unknown> }> }>
  }
}

/** One SSE frame from `GET /api/event`. `data` is decoded tolerantly by the normalizer. */
export interface OpenCodeEvent {
  readonly type: string
  readonly id?: string | undefined
  readonly data?: unknown
}

/** HTTP Basic credentials, UTF-8 safe (`btoa` breaks non-ASCII passwords; t3code OpenCode2Client). */
export const basicAuthorization = (password: string, username = "opencode"): string =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`

/** Builds the real Promise client for a spawned (or external) `opencode serve`. */
export const makeOpenCodeClient = (options: { readonly baseUrl: string; readonly password: string }): OpenCodeApi => {
  // Compile-time check: the real client satisfies the structural slice.
  const client: OpenCodeApi = OpenCode.make({
    baseUrl: options.baseUrl,
    headers: { authorization: basicAuthorization(options.password) },
  })
  return client
}

/**
 * True for a "not found" failure: a declared 404 is thrown as an `Error` named after its `_tag`
 * (`SessionNotFoundError`, verified against 2.0.6), an undeclared one as `ClientError` with
 * `cause.status === 404`.
 */
export const isNotFoundError = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false
  const e = cause as { readonly name?: unknown; readonly _tag?: unknown; readonly cause?: { readonly status?: unknown } }
  const tag = typeof e._tag === "string" ? e._tag : typeof e.name === "string" ? e.name : ""
  return /NotFound/.test(tag) || e.cause?.status === 404
}

/** Best-effort message of a client failure (never includes credentials). */
export const describeClientError = (cause: unknown): string => {
  if (cause instanceof Error) {
    const status = (cause as { cause?: { status?: unknown } }).cause?.status
    return typeof status === "number" ? `${cause.message} (HTTP ${status})` : cause.message
  }
  if (typeof cause === "object" && cause !== null) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === "string") return message
    try {
      return JSON.stringify(cause).slice(0, 300)
    } catch {
      return String(cause)
    }
  }
  return String(cause)
}
