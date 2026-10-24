// Policy + audit wrapper shared by every bot-originated handler.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import type { PolicyRefused } from "@openbot/node-protocol"
import type { AuditLogShape } from "./AuditLog.ts"
import type { NodeAction } from "./config.ts"
import type { NodePolicyShape, PolicyCheck } from "./NodePolicy.ts"

export interface Guard {
  <A, E, R>(
    check: PolicyCheck,
    run: Effect.Effect<A, E, R>,
    describe?: (a: A) => { readonly exitCode?: number | null | undefined },
  ): Effect.Effect<A, E | PolicyRefused, R>
  /** policy + audit "refused" only; use when the work outlives the call (sessions) */
  readonly check: (check: PolicyCheck) => Effect.Effect<void, PolicyRefused>
  readonly audit: AuditLogShape
}

const errorText = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  if (e && typeof e === "object" && "_tag" in e) {
    const reason = (e as { reason?: unknown }).reason
    return `${String((e as { _tag: unknown })._tag)}${typeof reason === "string" ? `: ${reason}` : ""}`
  }
  return e instanceof Error ? e.message : String(e)
}

export const makeGuard = (policy: NodePolicyShape, audit: AuditLogShape): Guard => {
  const decide = (input: PolicyCheck) =>
    policy.check(input).pipe(
      Effect.tapError((e) =>
        audit.record({
          inv: input.inv,
          action: input.action,
          target: input.target,
          decision: "refused",
          by: "node",
          error: e.reason,
        }),
      ),
    )
  const guard = (<A, E, R>(
    input: PolicyCheck,
    run: Effect.Effect<A, E, R>,
    describe?: (a: A) => { readonly exitCode?: number | null | undefined },
  ) =>
    Effect.gen(function* () {
      const decision = yield* decide(input)
      const start = yield* Clock.currentTimeMillis
      return yield* run.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const end = yield* Clock.currentTimeMillis
            yield* audit.record({
              inv: input.inv,
              action: input.action as NodeAction,
              target: input.target,
              decision: decision.asked ? "approved" : "allowed",
              by: decision.by,
              outcome: Exit.isSuccess(exit) ? "ok" : "error",
              exitCode: Exit.isSuccess(exit) && describe ? describe(exit.value).exitCode : undefined,
              durationMs: end - start,
              error: Exit.isFailure(exit) ? errorText(exit.cause) : undefined,
            })
          }),
        ),
      )
    })) as Guard
  return Object.assign(guard, {
    check: (input: PolicyCheck) =>
      Effect.gen(function* () {
        const decision = yield* decide(input)
        yield* audit.record({
          inv: input.inv,
          action: input.action,
          target: input.target,
          decision: decision.asked ? "approved" : "allowed",
          by: decision.by,
        })
      }),
    audit,
  })
}
