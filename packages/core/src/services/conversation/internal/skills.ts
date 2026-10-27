import type { SkillName } from "@openbot/contracts"
import { Effect, Option } from "effect"
import type { SkillStore } from "../../../ports/stores.ts"
import { orDie } from "./util.ts"

/** The skills marked `disable-model-invocation` (D5.5): only the owner's `/name` command starts them. */
export const ownerOnlySkills = (store: SkillStore["Service"], skills: ReadonlyArray<SkillName>) =>
  Effect.filter(skills, (name) =>
    Effect.map(orDie(store.get(name)), (skill) => Option.isSome(skill) && skill.value.disableModelInvocation === true),
  )
