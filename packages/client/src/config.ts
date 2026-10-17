// Client configuration (architecture §4.10 client runtime). Held in a keep-alive atom so an app (or a
// test) can point the runtime at another brain by seeding the registry:
//   AtomRegistry.make({ initialValues: [[clientConfigAtom, { ...defaultClientConfig(), url }]] })
// Browser-safe: no Bun / node APIs. `location` is read lazily and only when it exists.
import type { Duration } from "effect"
import { Atom } from "effect/reactivity"

/** Exponential backoff with optional jitter (recovery-matrix.md §5: 250 ms → 10 s, jittered). */
export interface Backoff {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
  /** Spread each delay over [0.8, 1.2] × nominal so many tabs do not reconnect in lockstep. */
  readonly jitter: boolean
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 250, maxMs: 10_000, factor: 2, jitter: true }

/**
 * Delay before retry number `attempt` (1-based): `initial × factor^(attempt-1)`, capped at `max`,
 * then jittered. `attempt <= 0` means "no wait".
 */
export const backoffDelayMs = (backoff: Backoff, attempt: number, random: () => number = Math.random): number => {
  if (attempt <= 0) return 0
  const nominal = Math.min(backoff.maxMs, backoff.initialMs * Math.pow(backoff.factor, attempt - 1))
  if (!backoff.jitter) return nominal
  const r = random()
  return Math.round(Math.min(backoff.maxMs, nominal * (0.8 * (1 - r) + 1.2 * r)))
}

export interface ClientConfig {
  /** WebSocket URL of the brain's `/rpc` endpoint. Same origin by default (the session cookie rides along, D4.4). */
  readonly url: string
  /** RPC ping interval; a silent socket is dropped after the same duration (effect4-platform.md §4.5). */
  readonly pingInterval: Duration.Input
  /** How long a WebSocket may take to open before the attempt counts as failed. */
  readonly openTimeout: Duration.Input
  /** Socket reconnect backoff (owned by the RPC protocol). */
  readonly reconnect: Backoff
  /** Re-subscribe backoff for replica streams when no reconnect wakes them earlier. */
  readonly resubscribe: Backoff
}

/** Default `/rpc` URL: same origin as the page (ws/wss), or the default brain port outside a browser. */
export const defaultRpcUrl = (): string => {
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location
  if (loc && typeof loc.host === "string" && loc.host.length > 0) {
    return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/rpc`
  }
  return "ws://127.0.0.1:7420/rpc"
}

export const defaultClientConfig = (overrides?: Partial<ClientConfig>): ClientConfig => ({
  url: defaultRpcUrl(),
  pingInterval: "5 seconds",
  openTimeout: "10 seconds",
  reconnect: { initialMs: 250, maxMs: 5_000, factor: 2, jitter: true },
  resubscribe: DEFAULT_BACKOFF,
  ...overrides,
})

/**
 * The runtime's configuration. Changing it rebuilds the RPC runtime (new socket); every replica atom
 * then re-subscribes from its cached cursor.
 */
export const clientConfigAtom: Atom.Writable<ClientConfig> = Atom.make<ClientConfig>(defaultClientConfig()).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/clientConfig"),
)
