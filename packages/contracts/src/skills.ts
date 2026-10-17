// Skills library (D5.5): one library at `<data>/skills-lib` in Claude plugin layout
// (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`), mounted per harness. v1 has no per-bot subsets.
import { Schema } from "effect"
import { Millis, Slug } from "./base.ts"

/** Directory name under `skills/`; lower-case slug. */
export const SkillName = Slug.pipe(Schema.brand("SkillName"))
export type SkillName = typeof SkillName.Type

export const Skill = Schema.Struct({
  name: SkillName,
  /** Frontmatter `description`: when the harness should use the skill. */
  description: Schema.String,
  /** SKILL.md body (markdown, without frontmatter). */
  body: Schema.String,
  updatedAt: Millis,
})
export type Skill = typeof Skill.Type

export const SkillInput = Schema.Struct({ name: SkillName, description: Schema.String, body: Schema.String })
export type SkillInput = typeof SkillInput.Type
