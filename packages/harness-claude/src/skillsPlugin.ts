/**
 * A Bot's own Claude plugin of its skills (D5.5): `<botDir>/skills-plugin/<hash>/` with
 * `.claude-plugin/plugin.json` and one `skills/<name>` symlink per skill into the shared library, so
 * the Bot sees exactly its skills (and library edits right away). The folder is named by the skill
 * set and built once (in a temporary folder, then renamed), so sessions opening together share it.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const SKILLS_PLUGIN_NAME = "openbot-skills"

/** The plugin folder for `skills` (those still in the library); undefined when none is left. */
export const botSkillsPlugin = (input: {
  /** `<botDir>/skills-plugin` */
  readonly root: string
  /** The library root (`<data>/skills-lib`). */
  readonly library: string
  readonly skills: ReadonlyArray<string>
}): string | undefined => {
  const skills = [...new Set(input.skills)].sort().filter((name) => existsSync(join(input.library, "skills", name, "SKILL.md")))
  if (skills.length === 0) return undefined
  const dir = join(input.root, createHash("sha256").update(skills.join("\n")).digest("hex").slice(0, 16))
  if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir
  const temp = `${dir}.tmp-${process.pid}-${Date.now()}`
  mkdirSync(join(temp, ".claude-plugin"), { recursive: true })
  writeFileSync(
    join(temp, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: SKILLS_PLUGIN_NAME, description: "This Bot's skills from the OpenBot library", version: "1.0.0" }, null, 2)}\n`,
  )
  mkdirSync(join(temp, "skills"))
  for (const name of skills) symlinkSync(join(input.library, "skills", name), join(temp, "skills", name), "dir")
  try {
    renameSync(temp, dir)
  } catch (error) {
    // another session built it meanwhile
    rmSync(temp, { recursive: true, force: true })
    if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) throw error
  }
  return dir
}
