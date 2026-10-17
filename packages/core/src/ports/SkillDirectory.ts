/**
 * SkillDirectory (D5.5): an outside skills catalog OpenBot imports from. v1 is skills.sh
 * (`/api/search`, `/api/download/<owner>/<repo>/<skill>`, the endpoints of its `skills` CLI);
 * implemented in the server (HTTP), faked in tests.
 */
import type { SkillSearchResult, Unavailable } from "@openbot/contracts"
import type { NotFound } from "@openbot/contracts"
import { Context, type Effect } from "effect"
import type { SkillFile } from "./stores.ts"

/** A downloaded skill: every file of its folder (SKILL.md included) and the snapshot hash. */
export interface SkillDownload {
  readonly files: ReadonlyArray<SkillFile>
  readonly hash?: string | undefined
}

export class SkillDirectory extends Context.Service<SkillDirectory, {
  /** Best matches first. */
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<SkillSearchResult>, Unavailable>
  /** `id` is `owner/repo/skill`. */
  readonly download: (id: string) => Effect.Effect<SkillDownload, NotFound | Unavailable>
}>()("openbot/core/SkillDirectory") {}
