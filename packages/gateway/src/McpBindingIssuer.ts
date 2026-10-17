/**
 * `McpBindingIssuerLive` (architecture §3.4, §4.6, §7): mints a per-run bearer token, stores only
 * its SHA-256 hash with the claims in `McpTokenRepo`, and revokes it when the caller's scope closes
 * (the runner's session scope). The binding URL is `<InternalAddress.baseUrl>/mcp/<botId>`
 * (interfaces §8.11); the token travels only in `headers` (never on argv).
 */
import { InternalAddress, type McpBinding, McpBindingIssuer, type McpClaims, McpTokenRepo } from "@openbot/core"
import { randomToken, sha256Hex } from "@openbot/node-protocol"
import { Clock, Effect, Layer } from "effect"

/** 256-bit tokens, base64url (43 chars, no `.`: never mistaken for a session token). */
export const MCP_TOKEN_BYTES = 32

/** `Authorization` header value for a token. */
export const bearerHeader = (token: string): string => `Bearer ${token}`

/** Extracts the bearer token of a request (`Authorization: Bearer <token>`); undefined when absent. */
export const bearerTokenOf = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  if (header === null) return undefined
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1]
}

/** Hex SHA-256 of a token (what `McpTokenRepo` stores). */
export const hashMcpToken = (token: string): Effect.Effect<string> => sha256Hex(token)

/** The gateway URL of a bot on the internal listener. */
export const mcpUrlFor = (baseUrl: string, botId: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/mcp/${encodeURIComponent(botId)}`

export interface McpBindingIssuerOptions {
  /** Absolute token lifetime; default none (tokens live as long as the issuing scope). */
  readonly ttlMs?: number | undefined
}

/** Builds the issuer service over `McpTokenRepo` and `InternalAddress`. */
export const makeMcpBindingIssuer = (
  options?: McpBindingIssuerOptions,
): Effect.Effect<McpBindingIssuer["Service"], never, McpTokenRepo | InternalAddress> =>
  Effect.gen(function*() {
    const repo = yield* McpTokenRepo
    const address = yield* InternalAddress
    const issue = Effect.fn("McpBindingIssuer.issue")(function*(claims: McpClaims) {
      const token = randomToken(MCP_TOKEN_BYTES)
      const hash = yield* hashMcpToken(token)
      const now = yield* Clock.currentTimeMillis
      yield* Effect.acquireRelease(
        repo.put({
          hash,
          claims,
          createdAt: now,
          expiresAt: options?.ttlMs === undefined ? undefined : now + options.ttlMs,
          revoked: false,
        }).pipe(Effect.orDie),
        () =>
          repo.revoke(hash).pipe(
            Effect.catchCause((cause) => Effect.logWarning("McpBindingIssuer: revoking a token failed", cause)),
          ),
      )
      const baseUrl = yield* address.baseUrl
      const binding: McpBinding = {
        name: "openbot",
        url: mcpUrlFor(baseUrl, claims.botId),
        headers: { Authorization: bearerHeader(token) },
      }
      return binding
    })
    return McpBindingIssuer.of({ issue })
  })

/** `McpBindingIssuer` implementation (interfaces §2.1). */
export const McpBindingIssuerLive: Layer.Layer<McpBindingIssuer, never, McpTokenRepo | InternalAddress> = Layer.effect(
  McpBindingIssuer,
  makeMcpBindingIssuer(),
)

/** Same, with options (e.g. a token TTL). */
export const McpBindingIssuerLayer = (
  options: McpBindingIssuerOptions,
): Layer.Layer<McpBindingIssuer, never, McpTokenRepo | InternalAddress> =>
  Layer.effect(McpBindingIssuer, makeMcpBindingIssuer(options))
