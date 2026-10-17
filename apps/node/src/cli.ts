// openbot-node: the node daemon CLI (docs/architecture.md §4.7, D1.2–D1.4).
//
//   openbot-node pair <brain-url> <code>   generate a key, POST /node/pair, pin the brain key
//   openbot-node run                       dial the brain and serve this machine's hands
//   openbot-node status                    identity, configuration and daemon state
//
// State lives in the node data dir (default `$XDG_DATA_HOME/openbot-node`): `identity.json` (0600),
// optional `config.json`, `audit/`, `browser-profile/`, `run/status.json` while the daemon runs.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"
import {
  DialOut,
  expandHome,
  makeKeyStore,
  makeNodeConfig,
  NODE_DAEMON_VERSION,
  NodeActions,
  NodeInfo,
  pairNode,
  RemoteNodeLive,
  type DialState,
  type NodeAction,
  type NodeConfigInput,
  type NodeConfigShape,
  type NodeIdentity,
} from "@openbot/node-daemon"
import { base64UrlDecode, NodeRoot, PolicyCeiling, PROTOCOL_VERSION, type NodeRoot as NodeRootType } from "@openbot/node-protocol"

export const USAGE = `openbot-node ${NODE_DAEMON_VERSION}: the OpenBot node daemon (the "hands")

Usage:
  openbot-node pair <brain-url> <code> [--force]   pair this machine with a brain (code from Settings › Computers)
  openbot-node run [options]                       connect to the brain and serve tools
  openbot-node status [--json]                     show identity, configuration and daemon state
  openbot-node version

Options:
  --data-dir <dir>        node state directory (env OPENBOT_NODE_DIR; default $XDG_DATA_HOME/openbot-node)
  --root <path[:ro]>      workspace root (repeatable; default ~/openbot); ':ro' makes it read-only
  --ceiling <level>       never | ask | always: the most this node allows without asking (default always)
  --browser <path>        Chromium/Chrome executable (default: detected on PATH)
  --no-browser            do not offer the browser capability
  --headless / --headful  force the browser mode (default: headless; with desktops, each bot's
                          browser runs on the bot's own screen)
  --no-desktop            do not offer per-bot desktops (desktop@1; needs Xvfb, x11vnc, xdotool,
                          xfwm4 or openbox, ImageMagick; env OPENBOT_DESKTOP_PATH adds program dirs)
  --log-level <level>     debug | info | warn | error (default info)
  --force                 pair: replace an existing identity
  --json                  status: machine-readable output

Optional <data-dir>/config.json:
  {"roots": ["~/openbot", {"id": "docs", "path": "~/Documents", "mode": "ro"}], "ceiling": "ask",
   "actions": {"run-command": "ask", "computer": "ask"}, "denyGlobs": ["**/*.pem"], "browser": {"enabled": true, "headless": "auto"},
   "desktop": {"enabled": true, "width": 1920, "height": 1200}}
`

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
  exitCode: Schema.Number,
}) {}

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export const processIo: CliIo = {
  env: process.env,
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
}

// ---------------------------------------------------------------- data dir, config file, status file
export const defaultDataDir = (env: CliIo["env"]): string =>
  env.OPENBOT_NODE_DIR
    ? path.resolve(expandHome(env.OPENBOT_NODE_DIR))
    : path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "openbot-node")

const FileConfig = Schema.Struct({
  roots: Schema.optional(Schema.Array(Schema.Union([Schema.String, NodeRoot]))),
  ceiling: Schema.optional(PolicyCeiling),
  actions: Schema.optional(Schema.Record(Schema.String, PolicyCeiling)),
  askCommands: Schema.optional(Schema.Array(Schema.String)),
  denyCommands: Schema.optional(Schema.Array(Schema.String)),
  denyGlobs: Schema.optional(Schema.Array(Schema.String)),
  browser: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      executable: Schema.optional(Schema.String),
      headless: Schema.optional(Schema.Union([Schema.Literal("auto"), Schema.Boolean])),
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
      extraArgs: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  shell: Schema.optional(Schema.Struct({ program: Schema.optional(Schema.String), interactive: Schema.optional(Schema.String) })),
  desktop: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
      path: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
export type FileConfig = typeof FileConfig.Type

export const configPath = (dataDir: string) => path.join(dataDir, "config.json")
export const statusPath = (dataDir: string) => path.join(dataDir, "run", "status.json")

export const loadFileConfig = (dataDir: string): Effect.Effect<FileConfig, CliError> =>
  Effect.gen(function* () {
    const file = configPath(dataDir)
    if (!existsSync(file)) return {}
    const raw = yield* Effect.try({
      try: () => JSON.parse(readFileSync(file, "utf8")) as unknown,
      catch: (e) => new CliError({ message: `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 }),
    })
    return yield* Schema.decodeUnknownEffect(FileConfig)(raw).pipe(
      Effect.mapError((e) => new CliError({ message: `${file} is invalid: ${e.message}`, exitCode: 1 })),
    )
  })

/** `path`, `path:ro` or `path:rw`. */
export const parseRootFlag = (flag: string, index: number): NodeRootType => {
  const m = /^(.*):(ro|rw)$/.exec(flag)
  const p = m ? m[1]! : flag
  return { id: index === 0 ? "work" : `root${index + 1}`, path: path.resolve(expandHome(p)), mode: m ? (m[2] as "ro" | "rw") : "rw" }
}

export interface RunFlags {
  readonly roots?: ReadonlyArray<string> | undefined
  readonly ceiling?: string | undefined
  readonly browser?: string | undefined
  readonly noBrowser?: boolean | undefined
  readonly headless?: boolean | undefined
  readonly headful?: boolean | undefined
  readonly noDesktop?: boolean | undefined
}

/** File config, then flags on top. */
export const buildNodeConfig = (input: {
  readonly identity: Pick<NodeIdentity, "nodeId">
  readonly dataDir: string
  readonly file: FileConfig
  readonly flags: RunFlags
}): Effect.Effect<NodeConfigShape, CliError> =>
  Effect.gen(function* () {
    const { file, flags } = input
    let ceiling = file.ceiling
    if (flags.ceiling !== undefined) {
      if (!Schema.is(PolicyCeiling)(flags.ceiling)) {
        return yield* new CliError({ message: `--ceiling must be never, ask or always (got ${flags.ceiling})`, exitCode: 2 })
      }
      ceiling = flags.ceiling
    }
    const actions: Partial<Record<NodeAction, PolicyCeiling>> = {}
    for (const [k, v] of Object.entries(file.actions ?? {})) {
      if (!(NodeActions as ReadonlyArray<string>).includes(k)) {
        return yield* new CliError({ message: `config.json: unknown action "${k}" (known: ${NodeActions.join(", ")})`, exitCode: 1 })
      }
      actions[k as NodeAction] = v
    }
    const roots: ReadonlyArray<NodeRootType | string> | undefined =
      flags.roots && flags.roots.length > 0 ? flags.roots.map(parseRootFlag) : file.roots
    const headless = flags.headless ? true : flags.headful ? false : file.browser?.headless
    const config: NodeConfigInput = {
      nodeId: input.identity.nodeId,
      dataDir: input.dataDir,
      roots,
      denyGlobs: file.denyGlobs,
      policy: {
        ...(ceiling !== undefined ? { ceiling } : {}),
        actions,
        ...(file.askCommands ? { askCommands: file.askCommands } : {}),
        ...(file.denyCommands ? { denyCommands: file.denyCommands } : {}),
      },
      shell: file.shell,
      browser: {
        ...(file.browser?.enabled !== undefined ? { enabled: file.browser.enabled } : {}),
        ...(flags.noBrowser ? { enabled: false } : {}),
        ...((flags.browser ?? file.browser?.executable) ? { executable: expandHome(flags.browser ?? file.browser!.executable!) } : {}),
        ...(headless !== undefined ? { headless } : {}),
        ...(file.browser?.width !== undefined ? { width: file.browser.width } : {}),
        ...(file.browser?.height !== undefined ? { height: file.browser.height } : {}),
        ...(file.browser?.extraArgs ? { extraArgs: file.browser.extraArgs } : {}),
      },
      desktop: {
        ...(file.desktop?.enabled !== undefined ? { enabled: file.desktop.enabled } : {}),
        ...(flags.noDesktop ? { enabled: false } : {}),
        ...(file.desktop?.width !== undefined ? { width: file.desktop.width } : {}),
        ...(file.desktop?.height !== undefined ? { height: file.desktop.height } : {}),
        ...(file.desktop?.path ? { path: file.desktop.path.map(expandHome) } : {}),
      },
    }
    return makeNodeConfig(config)
  })

export interface StatusFile {
  readonly pid: number
  readonly nodeId: string
  readonly version: string
  readonly brainUrl: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly state: DialState
  readonly capabilities: ReadonlyArray<string>
}

export const readStatusFile = (dataDir: string): StatusFile | undefined => {
  try {
    return JSON.parse(readFileSync(statusPath(dataDir), "utf8")) as StatusFile
  } catch {
    return undefined
  }
}

const writeStatusFile = (dataDir: string, status: StatusFile) => {
  const file = statusPath(dataDir)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

export const pidAlive = (pid: number): boolean => {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"
  }
}

/** `SHA256:<first 16 hex>` of a base64url raw key, for humans comparing keys. */
export const keyFingerprint = (publicKey: string): string => {
  try {
    return `SHA256:${new Bun.CryptoHasher("sha256").update(base64UrlDecode(publicKey)).digest("hex").slice(0, 16)}`
  } catch {
    return "(invalid key)"
  }
}

const describeState = (s: DialState): string => {
  const at = (ms: number) => new Date(ms).toLocaleTimeString()
  switch (s._tag) {
    case "Connecting":
      return s.attempt === 0 ? "connecting" : `connecting (attempt ${s.attempt + 1})`
    case "Connected":
      return `connected since ${at(s.since)}, waiting for the brain's hello`
    case "Verified":
      return `online since ${at(s.since)} (protocol ${s.protocol})`
    case "Waiting":
      return `offline: ${s.reason || "connection closed"}${s.closeCode ? ` (${s.closeCode})` : ""}; retrying in ${s.delayMs} ms`
    case "Revoked":
      return "revoked by the brain: pair again"
  }
}

const loadIdentity = (dataDir: string) =>
  makeKeyStore(dataDir).load.pipe(Effect.mapError((e) => new CliError({ message: `cannot read ${e.path}: ${e.message}`, exitCode: 1 })))

const notPaired = (dataDir: string) =>
  new CliError({
    message: `This node is not paired yet (no identity in ${dataDir}).\nIn the brain, open Settings › Computers › Add computer, then run:\n  openbot-node pair <brain-url> <code>`,
    exitCode: 1,
  })

// ---------------------------------------------------------------- commands
export const pairCommand = (input: {
  readonly io: CliIo
  readonly dataDir: string
  readonly brainUrl: string
  readonly code: string
  readonly force: boolean
}): Effect.Effect<number, CliError> =>
  Effect.gen(function* () {
    const { io, dataDir } = input
    const keyStore = makeKeyStore(dataDir)
    const existing = yield* loadIdentity(dataDir)
    if (Option.isSome(existing) && !input.force) {
      return yield* new CliError({
        message: `Already paired as ${existing.value.nodeId} with ${existing.value.brainUrl}. Use --force to pair again (the old identity is replaced).`,
        exitCode: 1,
      })
    }
    const running = readStatusFile(dataDir)
    if (running && running.pid !== process.pid && pidAlive(running.pid)) {
      return yield* new CliError({ message: `The node daemon is running (pid ${running.pid}); stop it before pairing again.`, exitCode: 1 })
    }
    const identity = yield* pairNode({ brainUrl: input.brainUrl, code: input.code, keyStore }).pipe(
      Effect.mapError((e) => new CliError({ message: `Pairing failed: ${e.message}`, exitCode: 1 })),
    )
    io.out(`Paired with ${identity.brainUrl} as ${identity.nodeId}.`)
    io.out(`Brain key: ${keyFingerprint(identity.brainPublicKey)} (pinned)`)
    io.out(`Identity:  ${keyStore.path}`)
    io.out(`Start the node with: openbot-node run${input.dataDir !== defaultDataDir(io.env) ? ` --data-dir ${dataDir}` : ""}`)
    return 0
  })

export const runCommand = (input: { readonly io: CliIo; readonly dataDir: string; readonly flags: RunFlags }): Effect.Effect<number, CliError> =>
  Effect.gen(function* () {
    const { io, dataDir } = input
    const identity = Option.getOrUndefined(yield* loadIdentity(dataDir))
    if (!identity) return yield* notPaired(dataDir)
    const running = readStatusFile(dataDir)
    if (running && running.pid !== process.pid && pidAlive(running.pid)) {
      return yield* new CliError({ message: `The node daemon is already running (pid ${running.pid}).`, exitCode: 1 })
    }
    const file = yield* loadFileConfig(dataDir)
    const config = yield* buildNodeConfig({ identity, dataDir, file, flags: input.flags })

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(RemoteNodeLive({ node: config, dial: { identity } }))
        const dialOut = Context.get(ctx, DialOut)
        const info = Context.get(ctx, NodeInfo)
        io.out(`openbot-node ${config.version} · node ${identity.nodeId} · brain ${identity.brainUrl}`)
        io.out(`roots: ${config.roots.map((r) => `${r.path}${r.mode === "ro" ? " (read-only)" : ""}`).join(", ")}`)
        io.out(`capabilities: ${info.capabilities.join(", ")} · ceiling: ${config.policy.ceiling}`)

        const startedAt = Date.now()
        const status = (state: DialState) =>
          Effect.sync(() =>
            writeStatusFile(dataDir, {
              pid: process.pid,
              nodeId: identity.nodeId,
              version: config.version,
              brainUrl: identity.brainUrl,
              startedAt,
              updatedAt: Date.now(),
              state,
              capabilities: info.capabilities,
            }),
          ).pipe(Effect.ignore)
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(statusPath(dataDir), { force: true })))
        yield* Effect.forkScoped(Stream.runForEach(dialOut.changes, status))

        const final = yield* dialOut.done
        return yield* new CliError({
          message: `${describeState(final)}. Pair this machine again: openbot-node pair <brain-url> <code> --force`,
          exitCode: 3,
        })
      }),
    )
  })

export const statusCommand = (input: { readonly io: CliIo; readonly dataDir: string; readonly json: boolean }): Effect.Effect<number, CliError> =>
  Effect.gen(function* () {
    const { io, dataDir } = input
    const identity = Option.getOrUndefined(yield* loadIdentity(dataDir))
    const file = yield* loadFileConfig(dataDir)
    const config = identity ? yield* buildNodeConfig({ identity, dataDir, file, flags: {} }) : undefined
    const status = readStatusFile(dataDir)
    const running = status !== undefined && pidAlive(status.pid)
    if (input.json) {
      io.out(
        JSON.stringify(
          {
            version: NODE_DAEMON_VERSION,
            protocol: PROTOCOL_VERSION,
            dataDir,
            paired: identity !== undefined,
            ...(identity
              ? {
                  nodeId: identity.nodeId,
                  brainUrl: identity.brainUrl,
                  brainOrigin: identity.brainOrigin,
                  brainKey: keyFingerprint(identity.brainPublicKey),
                  pairedAt: identity.pairedAt,
                }
              : {}),
            ...(config
              ? {
                  roots: config.roots,
                  ceiling: config.policy.ceiling,
                  browser: config.browser.enabled ? (config.browser.executable ?? null) : null,
                  desktop: config.desktop.enabled,
                }
              : {}),
            daemon: running ? { pid: status.pid, startedAt: status.startedAt, state: status.state, capabilities: status.capabilities } : null,
          },
          null,
          2,
        ),
      )
      return identity ? 0 : 1
    }
    io.out(`openbot-node ${NODE_DAEMON_VERSION} (protocol ${PROTOCOL_VERSION})`)
    io.out(`data dir:  ${dataDir}`)
    if (!identity) {
      io.out("paired:    no. Run: openbot-node pair <brain-url> <code>")
      return 1
    }
    io.out(`node:      ${identity.nodeId}`)
    io.out(`brain:     ${identity.brainUrl} (origin ${identity.brainOrigin})`)
    io.out(`brain key: ${keyFingerprint(identity.brainPublicKey)} (pinned ${new Date(identity.pairedAt).toISOString()})`)
    if (config) {
      io.out(`roots:     ${config.roots.map((r) => `${r.path}${r.mode === "ro" ? " (ro)" : ""}`).join(", ")}`)
      io.out(`ceiling:   ${config.policy.ceiling}`)
      io.out(`browser:   ${config.browser.enabled ? (config.browser.executable ?? "not found") : "disabled"}`)
      io.out(`desktops:  ${config.desktop.enabled ? "on when Xvfb, x11vnc, xdotool, xfwm4/openbox and ImageMagick are installed" : "disabled"}`)
    }
    io.out(running ? `daemon:    running (pid ${status.pid}), ${describeState(status.state)}` : "daemon:    not running")
    return 0
  })

// ---------------------------------------------------------------- argv
const LOG_LEVELS = { debug: "Debug", info: "Info", warn: "Warn", error: "Error" } as const

export const runCli = (argv: ReadonlyArray<string>, io: CliIo = processIo): Effect.Effect<number> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...argv],
          allowPositionals: true,
          strict: true,
          options: {
            "data-dir": { type: "string" },
            root: { type: "string", multiple: true },
            ceiling: { type: "string" },
            browser: { type: "string" },
            "no-browser": { type: "boolean" },
            "no-desktop": { type: "boolean" },
            headless: { type: "boolean" },
            headful: { type: "boolean" },
            "log-level": { type: "string" },
            force: { type: "boolean" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
          },
        }),
      catch: (e) => new CliError({ message: `${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`, exitCode: 2 }),
    })
    const { values, positionals } = parsed
    const [command, ...rest] = positionals
    const dataDir = values["data-dir"] ? path.resolve(expandHome(values["data-dir"])) : defaultDataDir(io.env)
    if (values.help || command === "help") {
      io.out(USAGE)
      return 0
    }
    if (values.version || command === "version") {
      io.out(`openbot-node ${NODE_DAEMON_VERSION} (protocol ${PROTOCOL_VERSION})`)
      return 0
    }
    const level = values["log-level"]
    if (level !== undefined && !(level in LOG_LEVELS)) {
      return yield* new CliError({ message: `--log-level must be one of ${Object.keys(LOG_LEVELS).join(", ")}`, exitCode: 2 })
    }
    const withLevel = <A, E>(e: Effect.Effect<A, E>) =>
      Effect.provideService(e, References.MinimumLogLevel, LOG_LEVELS[(level ?? "info") as keyof typeof LOG_LEVELS])

    switch (command) {
      case "pair": {
        if (rest.length !== 2) return yield* new CliError({ message: `usage: openbot-node pair <brain-url> <code>`, exitCode: 2 })
        return yield* pairCommand({ io, dataDir, brainUrl: rest[0]!, code: rest[1]!, force: values.force ?? false })
      }
      case "run":
        return yield* withLevel(
          runCommand({
            io,
            dataDir,
            flags: {
              roots: values.root,
              ceiling: values.ceiling,
              browser: values.browser,
              noBrowser: values["no-browser"],
              headless: values.headless,
              headful: values.headful,
              noDesktop: values["no-desktop"],
            },
          }),
        )
      case "status":
        return yield* statusCommand({ io, dataDir, json: values.json ?? false })
      case undefined:
        io.out(USAGE)
        return 2
      default:
        return yield* new CliError({ message: `unknown command "${command}"\n\n${USAGE}`, exitCode: 2 })
    }
  }).pipe(
    Effect.catchTag("CliError", (e) =>
      Effect.sync(() => {
        io.err(`openbot-node: ${e.message}`)
        return e.exitCode
      }),
    ),
  )
