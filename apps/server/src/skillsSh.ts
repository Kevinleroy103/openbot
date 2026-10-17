/**
 * `SkillDirectory` over skills.sh (D5.5): the two endpoints its `skills` CLI uses
 * (vendor/skills-cli `src/find.ts`, `src/blob.ts`):
 *
 * - `GET /api/search?q=<query>&limit=<n>` → `{ skills: [{ id: "owner/repo/skill", name, source, installs }] }`
 * - `GET /api/download/<owner>/<repo>/<skill>` → `{ files: [{ path, contents }], hash }` (404: unknown)
 *
 * Requests time out; any other failure is `Unavailable` (shown to the owner as "skills.sh did not answer").
 */
import { NotFound, type SkillSearchResult, Unavailable } from "@openbot/contracts"
import { SkillDirectory } from "@openbot/core"
import { Duration, Effect, Layer, Schema } from "effect"

export const SKILLS_SH_URL = "https://skills.sh"
const SEARCH_LIMIT = 20
const TIMEOUT = Duration.seconds(15)

const SearchResponse = Schema.Struct({
  skills: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    source: Schema.optionalKey(Schema.String),
    installs: Schema.optionalKey(Schema.Number),
  })),
})

const DownloadResponse = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, contents: Schema.String })),
  hash: Schema.optionalKey(Schema.String),
})

const unavailable = (what: string) => (cause: unknown) =>
  new Unavailable({ message: `skills.sh did not answer (${what}): ${cause instanceof Error ? cause.message : String(cause)}` })

/** GET `url` as JSON (`undefined` on 404). */
const getJson = (url: string, what: string, fetchImpl: typeof fetch) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(url, { signal, headers: { accept: "application/json" } })
      if (response.status === 404) return undefined
      if (response.status === 429) throw new Error("too many requests, try again in a minute")
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as unknown
    },
    catch: unavailable(what),
  }).pipe(
    Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new Unavailable({ message: `skills.sh did not answer in time (${what}).` })) }),
  )

export const makeSkillsSh = (options?: { readonly baseUrl?: string; readonly fetch?: typeof fetch }) => {
  const base = (options?.baseUrl ?? SKILLS_SH_URL).replace(/\/+$/, "")
  const fetchImpl = options?.fetch ?? fetch
  return SkillDirectory.of({
    search: (query) =>
      Effect.gen(function*() {
        const params = new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT) })
        const body = yield* getJson(`${base}/api/search?${params}`, "search", fetchImpl)
        const decoded = yield* Schema.decodeUnknownEffect(SearchResponse)(body ?? { skills: [] }).pipe(Effect.mapError(unavailable("search")))
        return decoded.skills.map((skill): SkillSearchResult => ({
          id: skill.id,
          name: skill.name,
          repo: skill.source ?? skill.id.split("/").slice(0, 2).join("/"),
          installs: skill.installs ?? 0,
        }))
      }),
    download: (id) =>
      Effect.gen(function*() {
        const path = id.split("/").map(encodeURIComponent).join("/")
        const body = yield* getJson(`${base}/api/download/${path}`, "download", fetchImpl)
        if (body === undefined) return yield* new NotFound({ entity: "skill", id })
        const decoded = yield* Schema.decodeUnknownEffect(DownloadResponse)(body).pipe(Effect.mapError(unavailable("download")))
        return { files: decoded.files, ...(decoded.hash === undefined ? {} : { hash: decoded.hash }) }
      }),
  })
}

export const SkillsShLive = (options?: { readonly baseUrl?: string }): Layer.Layer<SkillDirectory> =>
  Layer.succeed(SkillDirectory, makeSkillsSh(options))
