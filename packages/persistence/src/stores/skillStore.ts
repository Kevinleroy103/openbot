/**
 * `SkillStore` on disk (D5.5): one library at `<data>/skills-lib` in Claude plugin layout, mounted
 * per harness:
 *
 * ```
 * skills-lib/.claude-plugin/plugin.json
 * skills-lib/skills/<name>/SKILL.md      Agent Skills frontmatter (name, description, metadata.modified) + body
 * ```
 *
 * The directory name is authoritative for the skill name. Unknown frontmatter keys (for example
 * `allowed-tools`, `disable-model-invocation`) and any other files in a skill directory are kept.
 */
import type { Millis, Skill, SkillName } from "@openbot/contracts"
import { type DataDirShape, joinPath, RepoError, SkillStore } from "@openbot/core"
import { Effect, Option } from "effect"
import { listDirectory, modifiedAt, readTextFile, removePath, writeFileAtomic } from "./files.ts"
import { formatTimestamp, metadataValue, parseFrontmatter, parseTimestamp, renderFrontmatter, scalar, updateFrontmatter } from "./frontmatter.ts"

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const SKILL_FILE = "SKILL.md"
export const PLUGIN_MANIFEST = joinPath(".claude-plugin", "plugin.json")

export const pluginManifest = {
  name: "openbot-skills",
  description: "Skills library shared by OpenBot bots",
  version: "1.0.0",
}

export const makeFileSkillStore = (dataDir: DataDirShape) =>
  Effect.gen(function*() {
    const root = dataDir.skillsLib
    const skillsDir = joinPath(root, "skills")
    const manifestPath = joinPath(root, PLUGIN_MANIFEST)

    const ensureManifest = (op: string) =>
      Effect.gen(function*() {
        if ((yield* readTextFile(op, manifestPath)) === undefined) {
          yield* writeFileAtomic(op, manifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`)
        }
      })

    const skillFile = (op: string, name: SkillName) =>
      SKILL_NAME.test(name)
        ? Effect.succeed(joinPath(skillsDir, name, SKILL_FILE))
        : Effect.fail(new RepoError({ op, message: `Invalid skill name: ${JSON.stringify(name)}` }))

    const readSkill = (op: string, name: SkillName): Effect.Effect<Option.Option<Skill>, RepoError> =>
      Effect.gen(function*() {
        const path = yield* skillFile(op, name)
        const text = yield* readTextFile(op, path)
        if (text === undefined) return Option.none()
        const frontmatter = parseFrontmatter(text)
        const updatedAt = parseTimestamp(metadataValue(frontmatter, "modified")) ?? (yield* modifiedAt(op, path)) ?? 0
        return Option.some<Skill>({
          name,
          description: scalar(frontmatter, "description") ?? "",
          body: frontmatter.body,
          updatedAt: updatedAt as Millis,
        })
      })

    // The library is mounted even when empty, so the manifest exists from the start.
    yield* ensureManifest("SkillStore.init")

    return SkillStore.of({
      root,
      list: Effect.gen(function*() {
        const names = (yield* listDirectory("SkillStore.list", skillsDir))
          .filter((e) => e.isDirectory && SKILL_NAME.test(e.name))
          .map((e) => e.name)
          .sort()
        const skills: Array<Skill> = []
        for (const name of names) {
          const skill = yield* readSkill("SkillStore.list", name as SkillName)
          if (Option.isSome(skill)) skills.push(skill.value)
        }
        return skills
      }),
      get: (name) => (SKILL_NAME.test(name) ? readSkill("SkillStore.get", name) : Effect.succeed(Option.none())),
      put: (skill) =>
        Effect.gen(function*() {
          const path = yield* skillFile("SkillStore.put", skill.name)
          yield* ensureManifest("SkillStore.put")
          const existing = yield* readTextFile("SkillStore.put", path)
          const frontmatter = updateFrontmatter(existing === undefined ? undefined : parseFrontmatter(existing), {
            scalars: [["name", skill.name], ["description", skill.description]],
            metadata: [["modified", formatTimestamp(skill.updatedAt)]],
            body: skill.body,
          })
          yield* writeFileAtomic("SkillStore.put", path, renderFrontmatter(frontmatter))
        }),
      delete: (name) =>
        SKILL_NAME.test(name) ? removePath("SkillStore.delete", joinPath(skillsDir, name)) : Effect.succeed(false),
    })
  })
