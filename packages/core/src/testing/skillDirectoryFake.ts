/**
 * In-memory `SkillDirectory` (skills.sh) for tests: fixed search hits and downloads by id; ids it
 * does not know are NotFound, and `offline: true` makes every call Unavailable.
 */
import { NotFound, type SkillSearchResult, Unavailable } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { type SkillDownload, SkillDirectory } from "../ports/SkillDirectory.ts"

export const SkillDirectoryFake = {
  layer: (options?: {
    readonly results?: ReadonlyArray<SkillSearchResult>
    readonly downloads?: Readonly<Record<string, SkillDownload>>
    readonly offline?: boolean
  }): Layer.Layer<SkillDirectory> =>
    Layer.succeed(
      SkillDirectory,
      SkillDirectory.of({
        search: (query) =>
          options?.offline === true
            ? Effect.fail(new Unavailable({ message: "skills.sh is offline" }))
            : Effect.succeed((options?.results ?? []).filter((r) => r.name.includes(query) || r.id.includes(query))),
        download: (id) => {
          if (options?.offline === true) return Effect.fail(new Unavailable({ message: "skills.sh is offline" }))
          const found = options?.downloads?.[id]
          return found === undefined ? Effect.fail(new NotFound({ entity: "skill", id })) : Effect.succeed(found)
        },
      }),
    ),
}
