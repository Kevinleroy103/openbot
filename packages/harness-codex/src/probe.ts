/**
 * Codex status and models without a model call (D2.6; sdk-codex.md §4.6): `initialize` (version
 * from `userAgent`), `account/read` (login) and `model/list`. The parsers are pure and treat every
 * OpenAI enum as an open string (a new `planType` must never break the probe, sdk-codex.md §6.4).
 */
import type { HarnessAccount, HarnessCapabilities, HarnessStatus, ModelInfo } from "@openbot/contracts"
import type { HarnessError } from "@openbot/core"
import { Clock, Duration, Effect } from "effect"
import type { AppServerConnection, CodexRuntime } from "./appServer.ts"
import { type CodexBinary, PINNED_CODEX_VERSION, versionProblems } from "./binary.ts"
import type { CodexAuthLink } from "./codexHome.ts"
import { type CodexPeerError, toHarnessError } from "./errors.ts"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined)

export const DISPLAY_NAME = "Codex"

export interface ParsedAccount {
  readonly auth: HarnessStatus["auth"]
  readonly problems: ReadonlyArray<string>
  /** The ChatGPT account (email, plan), when signed in with one. */
  readonly account?: HarnessAccount | undefined
}

const LOGIN_HINT = "Run `codex login` in a terminal (OpenBot shares that login), then check again."

/** `account/read` → auth state and label. Never includes a token. */
export const parseAccount = (result: unknown, authLink?: CodexAuthLink | undefined): ParsedAccount => {
  const record = isRecord(result) ? result : {}
  const account = isRecord(record.account) ? record.account : undefined
  if (account) {
    const type = str(account.type)
    if (type === "chatgpt") {
      const email = str(account.email)
      const plan = str(account.planType)
      const label = email
        ? plan ? `${email} (ChatGPT ${plan})` : email
        : plan
        ? `ChatGPT ${plan}`
        : "ChatGPT"
      const info: HarnessAccount = { ...(email ? { email } : {}), ...(plan ? { plan: `ChatGPT ${plan}` } : {}) }
      return { auth: { state: "signed-in", label }, problems: [], ...(email || plan ? { account: info } : {}) }
    }
    if (type === "apiKey") return { auth: { state: "signed-in", label: "OpenAI API key" }, problems: [] }
    if (type === "amazonBedrock") return { auth: { state: "signed-in", label: "Amazon Bedrock" }, problems: [] }
    return { auth: { state: "signed-in", ...(type ? { label: type } : {}) }, problems: [] }
  }
  if (record.requiresOpenaiAuth === false) return { auth: { state: "unknown" }, problems: [] }
  const problems = authLink === "own-file"
    ? ["Codex is not signed in (OpenBot's Codex profile has its own login file that is not valid)."]
    : ["Codex is not signed in. " + LOGIN_HINT]
  return { auth: { state: "signed-out" }, problems }
}

/** One `model/list` page → visible models. */
export const parseModels = (result: unknown): ReadonlyArray<ModelInfo> => {
  const record = isRecord(result) ? result : {}
  const out: Array<ModelInfo> = []
  for (const raw of Array.isArray(record.data) ? record.data : []) {
    if (!isRecord(raw) || raw.hidden === true) continue
    const id = str(raw.model) ?? str(raw.id)
    if (!id) continue
    const efforts = (Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts : [])
      .map((option) => (isRecord(option) ? str(option.reasoningEffort) : str(option)))
      .filter((effort): effort is string => effort !== undefined)
    out.push({
      id,
      label: str(raw.displayName) ?? id,
      ...(raw.isDefault === true ? { default: true } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
    })
  }
  return out
}

const MAX_MODEL_PAGES = 10

/** Every page of `model/list`. */
export const listModelsOn = (connection: Pick<AppServerConnection, "request">, timeout: Duration.Input) =>
  Effect.gen(function*() {
    const models: Array<ModelInfo> = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const result: unknown = yield* connection.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }, { timeout })
      for (const model of parseModels(result)) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
      }
      cursor = isRecord(result) ? str(result.nextCursor) : undefined
      if (!cursor) break
    }
    return models as ReadonlyArray<ModelInfo>
  })

export interface ProbeOptions {
  readonly runtime: CodexRuntime
  readonly binary: () => CodexBinary | undefined
  readonly capabilities: HarnessCapabilities
  readonly timeout?: Duration.Input | undefined
  /** How `auth.json` is linked in OpenBot's profile (after the last preparation). */
  readonly authLink?: (() => CodexAuthLink | undefined) | undefined
  /** Receives the models fetched alongside the probe (cache). */
  readonly onModels?: ((models: ReadonlyArray<ModelInfo>) => Effect.Effect<void>) | undefined
}

/** The probe. Never fails; problems are reported in `problems`. */
export const runProbe = (options: ProbeOptions): Effect.Effect<HarnessStatus> =>
  Effect.gen(function*() {
    const checkedAt = yield* Clock.currentTimeMillis
    const base = { kind: "codex", displayName: DISPLAY_NAME, capabilities: options.capabilities, checkedAt } as const
    const binary = options.binary()
    if (!binary) {
      return {
        ...base,
        installed: false,
        auth: { state: "unknown" },
        problems: [
          `Codex is not installed: the bundled @openai/codex ${PINNED_CODEX_VERSION} binary is missing and \`codex\` is not on PATH.`,
        ],
      } satisfies HarnessStatus
    }
    const timeout = options.timeout ?? Duration.seconds(30)
    const probed = yield* options.runtime.withConnection((connection) =>
      Effect.gen(function*() {
        const account: unknown = yield* connection.request("account/read", { refreshToken: false }, { timeout })
        const models = yield* listModelsOn(connection, timeout).pipe(
          Effect.map((list): ReadonlyArray<ModelInfo> | undefined => list),
          Effect.catch((error: CodexPeerError) =>
            Effect.logWarning(`Codex model/list failed during the probe: ${error._tag}`).pipe(Effect.as(undefined))
          ),
        )
        return { info: connection.info, account, models }
      }).pipe(Effect.mapError((error: CodexPeerError) => toHarnessError("other", error)))
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.sum(Duration.fromInputUnsafe(timeout), Duration.seconds(5)),
        orElse: () => Effect.fail<HarnessError | undefined>(undefined),
      }),
      Effect.result,
    )
    if (probed._tag === "Failure") {
      const error = probed.failure
      return {
        ...base,
        installed: error?.code !== "not-installed",
        auth: { state: "unknown" },
        problems: [error ? error.message : "Codex did not answer in time."],
      } satisfies HarnessStatus
    }
    const { info, account, models } = probed.success
    if (models && options.onModels) yield* options.onModels(models)
    const parsed = parseAccount(account, options.authLink?.())
    return {
      ...base,
      installed: true,
      ...(info.version ? { version: info.version } : {}),
      auth: parsed.auth,
      ...(parsed.account !== undefined ? { account: parsed.account } : {}),
      problems: [
        ...versionProblems(info.version),
        ...parsed.problems,
        ...(binary.source === "path" ? [`Using \`codex\` from PATH (${binary.path}), not the bundled build.`] : []),
      ],
    } satisfies HarnessStatus
  })
