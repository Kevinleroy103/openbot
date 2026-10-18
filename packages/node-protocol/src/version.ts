// Protocol version, versioned capability names and well-known constants (headers, close codes, TTLs).

/** One integer for the envelope + contract. The brain supports N and N-1. */
export const PROTOCOL_VERSION = 1
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1

/** Pick the highest version both sides support, or `undefined` if the ranges do not overlap. */
export const negotiateProtocol = (
  ours: { readonly min: number; readonly max: number },
  theirs: { readonly min: number; readonly max: number },
): number | undefined => {
  const hi = Math.min(ours.max, theirs.max)
  const lo = Math.max(ours.min, theirs.min)
  return hi >= lo ? hi : undefined
}

// ---------------------------------------------------------------- capabilities
/** Versioned capability names advertised in `node.hello`. */
export const Capabilities = {
  fs: "fs@1",
  shell: "shell@1",
  pty: "pty@1",
  tunnel: "tunnel@1",
  browser: "browser@1",
  desktop: "desktop@1",
  /** the computer's own screen (macOS), shared by its bots and the owner */
  screen: "screen@1",
  codexExecServer: "codex.exec-server@1",
  claudeCli: "claude.cli@1",
  opencodeServe: "opencode.serve@1",
} as const
export type KnownCapability = (typeof Capabilities)[keyof typeof Capabilities]

export interface ParsedCapability {
  readonly name: string
  readonly version: number
}

/** `"browser@1"` → `{name: "browser", version: 1}`; a bare name means version 1. Invalid → undefined. */
export const parseCapability = (capability: string): ParsedCapability | undefined => {
  const m = /^([a-z][a-z0-9.-]*)(?:@([1-9][0-9]*))?$/.exec(capability)
  if (!m) return undefined
  return { name: m[1]!, version: m[2] === undefined ? 1 : Number(m[2]) }
}

export const formatCapability = (c: ParsedCapability): string => `${c.name}@${c.version}`

/** True when `capabilities` contains `name` at `minVersion` or later. */
export const hasCapability = (capabilities: ReadonlyArray<string>, name: string, minVersion = 1): boolean =>
  capabilities.some((c) => {
    const p = parseCapability(c)
    return p !== undefined && p.name === name && p.version >= minVersion
  })

/**
 * effective = declared ∩ approved. A capability is effective when the node declares it and the user approved
 * the same name at the same or a higher version. Declared-but-unapproved names come back in `pending`
 * (new capabilities need approval in Settings › Computers; fewer never needs approval).
 */
export const effectiveCapabilities = (
  declared: ReadonlyArray<string>,
  approved: ReadonlyArray<string>,
): { readonly effective: ReadonlyArray<string>; readonly pending: ReadonlyArray<string> } => {
  const effective: Array<string> = []
  const pending: Array<string> = []
  for (const d of declared) {
    const p = parseCapability(d)
    if (!p) continue
    const ok = approved.some((a) => {
      const q = parseCapability(a)
      return q !== undefined && q.name === p.name && q.version >= p.version
    })
    ;(ok ? effective : pending).push(formatCapability(p))
  }
  return { effective, pending }
}

// ---------------------------------------------------------------- routes, headers, close codes, TTLs
export const Routes = {
  /** Node control socket (WebSocket upgrade, signed). */
  control: "/node",
  /** Node-dialed data streams (`/node/stream/:id`, one-time bearer token). */
  stream: (streamId: string) => `/node/stream/${encodeURIComponent(streamId)}`,
  streamPattern: "/node/stream/:id",
  /** Pairing (`POST`, JSON `PairRequest` → `PairResponse`). */
  pair: "/node/pair",
} as const

export const ProtocolHeaders = {
  /** `Authorization: OpenBot-Node v1 id=…,ts=…,nonce=…,sig=…` on the control upgrade. */
  authorization: "authorization",
  /** The node's protocol version range `min-max` (informational, sent on the upgrade). */
  protocol: "x-openbot-protocol",
  /** Stamped by the brain mux onto every request the node sends. Never trusted from the node. */
  nodeId: "x-openbot-node-id",
  /** Prefix reserved for brain-stamped headers; the brain mux strips anything the node sends under it. */
  reservedPrefix: "x-openbot-",
} as const

export const CloseCodes = {
  /** Node revoked or its key is unknown. The node must not redial until re-paired. */
  revoked: 4401,
  /** The node failed `node.hello` (brain signature or protocol mismatch). */
  helloFailed: 4403,
  /** Protocol version ranges do not overlap. */
  protocolMismatch: 4426,
  /** The brain asked the node to reconnect (e.g. a newer connection replaced this one). */
  replaced: 4000,
} as const

/** Data-stream tokens: 128-bit, single use, expire 30 s after minting. */
export const STREAM_TOKEN_TTL_MS = 30_000
/** Signed upgrade: maximum allowed |now - ts|; also the replay-cache TTL. */
export const UPGRADE_SKEW_MS = 60_000
/** Pairing codes: 8 base32 characters, single use, 10 minutes. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000
/** Brain-side `RpcClient(NodeRpcs)` ping timeout (any decoded frame counts as liveness). */
export const BRAIN_CLIENT_PING_TIMEOUT_MS = 15_000
/**
 * Brain-side liveness: a control connection on which no frame at all arrived for this long is
 * half-open (node asleep, NAT/Wi-Fi drop without a FIN) and is dropped, so the node goes offline.
 * Both sides ping every 5 s, so 20 s of silence is four missed pings. Mirrors the node's watchdog.
 */
export const BRAIN_LIVENESS_TIMEOUT_MS = 20_000
/** Node redial backoff. */
export const REDIAL = { initialMs: 250, maxMs: 30_000, resetAfterMs: 10_000 } as const

/** Exponential backoff with ±50 % jitter (`random` in [0, 1)). */
export const redialDelayMs = (attempt: number, random: number): number => {
  const base = Math.min(REDIAL.initialMs * 2 ** Math.max(0, attempt), REDIAL.maxMs)
  return Math.round(base * (0.5 + random / 2))
}
