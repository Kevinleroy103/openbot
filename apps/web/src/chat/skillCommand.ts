import { SkillName } from "@openbot/contracts"
import { Schema } from "effect"

const isSkillName = Schema.is(SkillName)

export const skillCommandLength = (
  text: string,
  skills: ReadonlyArray<{ readonly name: string }> | undefined,
): number => {
  const match = /^\s*\/(\S+)/.exec(text)
  return match !== null && isSkillName(match[1]) && skills?.some((s) => s.name === match[1]) === true
    ? match[0].length
    : 0
}
