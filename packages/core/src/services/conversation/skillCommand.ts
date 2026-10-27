import { SkillName } from "@openbot/contracts"
import { Schema } from "effect"

const isSkillName = Schema.is(SkillName)

/**
 * The owner's `/skill-name` command (D5.5): a message that starts with `/` and the name of one of the
 * Bot's skills asks the Bot to use that skill, even one marked `disable-model-invocation`. The chat
 * keeps what the owner typed; Claude gets its own skill command, other harnesses an instruction with
 * the skill inline. Anything else, a `/path` or a skill the Bot doesn't have, is an ordinary message.
 */
const COMMAND = /^\/(\S+)(?=\s|$)[ \t]*([\s\S]*)$/

export interface SkillCommand {
  readonly name: string
  /** What the owner wrote after the command (may be empty). */
  readonly rest: string
}

export const parseSkillCommand = (text: string, skills: ReadonlyArray<string>): SkillCommand | undefined => {
  const match = COMMAND.exec(text.trimStart())
  if (match === null || !isSkillName(match[1]) || !skills.includes(match[1])) return undefined
  return { name: match[1]!, rest: match[2]!.trim() }
}

/** The command as an instruction with the skill inline (its mounts may hide an owner-only skill). */
export const renderSkillCommand = (
  command: SkillCommand,
  skill: { readonly body: string; readonly dir: string },
): string =>
  [
    `The owner started your "${command.name}" skill (they typed /${command.name}): follow its instructions below. They asked for it by name, so it applies even if the skill says it is not for you to start on your own.`,
    command.rest === ""
      ? "They gave no details: start the skill, and ask for what it needs."
      : `Their request: ${command.rest}`,
    `Base directory for this skill: ${skill.dir}`,
    "",
    skill.body.trim(),
  ].join("\n")
