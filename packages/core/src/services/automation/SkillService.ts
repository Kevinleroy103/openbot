/**
 * SkillService (D5.5, architecture §4.3): CRUD of the shared skills library over `SkillStore`
 * (`<data>/skills-lib/skills/<name>/SKILL.md`). A bot saving a skill (`save_skill`) appends a
 * `skill-saved` event in the conversation it works in.
 */
import type { Skill, SkillInput, SkillName } from "@openbot/contracts"
import { InvalidInput, NotFound, SkillName as SkillNameSchema } from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { type Actor, ConversationService, SkillService } from "../../ports/services.ts"
import { SkillStore } from "../../ports/stores.ts"
import { utf8Length } from "./text.ts"

export const SKILL_LIMITS = {
  descriptionChars: 1024,
  bodyBytes: 256 * 1024,
} as const

const isSkillName = Schema.is(SkillNameSchema)

export const makeSkillService = Effect.gen(function*() {
  const store = yield* SkillStore
  const conversations = yield* ConversationService

  const validate = (input: SkillInput) => {
    if (!isSkillName(input.name)) {
      return Effect.fail(new InvalidInput({ message: `Invalid skill name "${input.name}" (use a lower-case slug like "weekly-report").` }))
    }
    const description = input.description.trim()
    if (description.length === 0) {
      return Effect.fail(new InvalidInput({ message: "A skill needs a description of when to use it." }))
    }
    if ([...description].length > SKILL_LIMITS.descriptionChars) {
      return Effect.fail(new InvalidInput({ message: `The description is too long (max ${SKILL_LIMITS.descriptionChars} characters).` }))
    }
    if (input.body.trim().length === 0) return Effect.fail(new InvalidInput({ message: "A skill needs instructions (body)." }))
    if (utf8Length(input.body) > SKILL_LIMITS.bodyBytes) {
      return Effect.fail(new InvalidInput({ message: `The skill is too long (max ${SKILL_LIMITS.bodyBytes / 1024} KB).` }))
    }
    return Effect.succeed(description)
  }

  const upsert = (actor: Actor, input: SkillInput) =>
    Effect.gen(function*() {
      const description = yield* validate(input)
      const skill: Skill = { name: input.name, description, body: input.body, updatedAt: yield* Clock.currentTimeMillis }
      yield* store.put(skill).pipe(Effect.orDie)
      if (actor.kind === "bot") {
        yield* conversations.appendEvent({
          conversationId: actor.tool.claims.conversationId,
          author: { kind: "bot", botId: actor.tool.claims.botId },
          event: { type: "skill-saved", name: skill.name },
        }).pipe(
          Effect.asVoid,
          Effect.catch((error) => Effect.logWarning("SkillService: skill-saved event not written", error)),
        )
      }
      return skill
    })

  return SkillService.of({
    list: store.list.pipe(Effect.orDie),
    get: (name: SkillName) =>
      store.get(name).pipe(
        Effect.orDie,
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(new NotFound({ entity: "skill", id: name })),
          onSome: Effect.succeed,
        })),
      ),
    upsert,
    delete: (name) =>
      store.delete(name).pipe(
        Effect.orDie,
        Effect.flatMap((deleted) => (deleted ? Effect.void : Effect.fail(new NotFound({ entity: "skill", id: name })))),
      ),
  })
})

export const SkillServiceLive: Layer.Layer<SkillService, never, SkillStore | ConversationService> = Layer.effect(
  SkillService,
  makeSkillService,
)
