/**
 * Compile-time contract between `OpenBotRpcs` (contracts) and the service shapes (ports/services.ts):
 * every RPC payload can be passed to its service method, and every service result fits the RPC
 * success schema. If contracts drift, `tsc` fails here.
 */
import { describe, expect, test } from "bun:test"
import type { OpenBotRpcs, OpenBotRpcTag } from "@openbot/contracts"
import type { Effect, Stream } from "effect"
import type { Rpc, RpcGroup } from "effect/rpc"
import type {
  ApprovalService,
  AttachmentService,
  BotService,
  ComputerPort,
  ConversationService,
  HarnessRegistry,
  LiveHub,
  MemoryService,
  NodeAdmin,
  NodeDirectory,
  Orchestrator,
  RoutineScheduler,
  SettingsService,
  SkillService,
  UsageService,
} from "../../src/ports/index.ts"

type R<T extends OpenBotRpcTag> = Rpc.ExtractTag<RpcGroup.Rpcs<typeof OpenBotRpcs>, T>
type In<T extends OpenBotRpcTag> = Rpc.Payload<R<T>>
type Out<T extends OpenBotRpcTag> = Rpc.Success<R<T>>
type Svc<S extends { readonly Service: unknown }> = S["Service"]

type Success<F> = F extends (...args: Array<any>) => Effect.Effect<infer A, any, any> ? A
  : F extends Effect.Effect<infer A, any, any> ? A
  : never
type StreamItem<F> = F extends (...args: Array<any>) => Stream.Stream<infer A, any, any> ? A : never
/** Element type of a streaming RPC's success. */
type Elem<S> = S extends Stream.Stream<infer A, any, any> ? A : S

/** `true` only when A is assignable to B (and neither collapsed to `never`, which would be vacuous). */
type Assignable<A, B> = [A] extends [never] ? false : [B] extends [never] ? false : [A] extends [B] ? true : false
const check = <T extends true>(_: T) => _

// ---- payload → service input
check<Assignable<In<"bots.create">, Parameters<Svc<typeof BotService>["create"]>[0]>>(true)
check<Assignable<In<"bots.update">["patch"], Parameters<Svc<typeof BotService>["update"]>[1]>>(true)
check<Assignable<In<"messages.send">, Parameters<Svc<typeof Orchestrator>["send"]>[0]>>(true)
check<Assignable<In<"messages.lookupSend">, Parameters<Svc<typeof Orchestrator>["lookupSend"]>[0]>>(true)
check<Assignable<In<"messages.react">, Parameters<Svc<typeof Orchestrator>["react"]>[0]>>(true)
check<Assignable<In<"turns.interrupt">, Parameters<Svc<typeof Orchestrator>["interrupt"]>[0]>>(true)
check<Assignable<In<"conversations.subscribe">, Parameters<Svc<typeof LiveHub>["subscribeConversation"]>[0]>>(true)
check<Assignable<In<"roster.subscribe">, Parameters<Svc<typeof LiveHub>["subscribeRoster"]>[0]>>(true)
check<Assignable<In<"conversations.history">, Parameters<Svc<typeof ConversationService>["history"]>[0]>>(true)
check<Assignable<In<"conversations.createGroup">, Parameters<Svc<typeof ConversationService>["createGroup"]>[0]>>(true)
check<Assignable<In<"conversations.setMembers">, Parameters<Svc<typeof ConversationService>["setMembers"]>[0]>>(true)
check<Assignable<In<"conversations.markRead">, Parameters<Svc<typeof ConversationService>["markRead"]>[0]>>(true)
check<Assignable<In<"requests.respond">, Parameters<Svc<typeof ApprovalService>["respond"]>[0]>>(true)
check<Assignable<In<"requests.listPending">, Parameters<Svc<typeof ApprovalService>["listPending"]>[0]>>(true)
check<Assignable<In<"routines.list">, Parameters<Svc<typeof RoutineScheduler>["list"]>[0]>>(true)
check<Assignable<In<"routines.create">, Parameters<Svc<typeof RoutineScheduler>["create"]>[1]>>(true)
check<Assignable<In<"routines.update">, Parameters<Svc<typeof RoutineScheduler>["update"]>[1]>>(true)
check<Assignable<In<"memory.putFact">["fact"], Parameters<Svc<typeof MemoryService>["putFact"]>[2]>>(true)
check<Assignable<In<"memory.deleteFact">["factId"], Parameters<Svc<typeof MemoryService>["deleteFact"]>[2]>>(true)
check<Assignable<In<"skills.upsert">, Parameters<Svc<typeof SkillService>["upsert"]>[1]>>(true)
check<Assignable<In<"skills.delete">["name"], Parameters<Svc<typeof SkillService>["delete"]>[0]>>(true)
check<Assignable<In<"settings.update">["patch"], Parameters<Svc<typeof SettingsService>["update"]>[0]>>(true)
check<Assignable<In<"rules.list">, Parameters<Svc<typeof SettingsService>["listRules"]>[0]>>(true)
check<Assignable<In<"rules.upsert">["rule"], Parameters<Svc<typeof SettingsService>["upsertRule"]>[0]>>(true)
check<Assignable<In<"usage.byBot">, Parameters<Svc<typeof UsageService>["byBot"]>[0]>>(true)
check<Assignable<In<"nodes.setCapabilities">["approved"], Parameters<Svc<typeof NodeAdmin>["setCapabilities"]>[1]>>(true)
check<Assignable<In<"harnesses.models">["kind"], Parameters<Svc<typeof HarnessRegistry>["get"]>[0]>>(true)

// ---- service result → RPC success
check<Assignable<Success<Svc<typeof BotService>["create"]>, Out<"bots.create">>>(true)
check<Assignable<Success<Svc<typeof BotService>["readContext"]>, Out<"bots.readContext">>>(true)
check<Assignable<Success<Svc<typeof BotService>["reorderSections"]>, Out<"sections.reorder">>>(true)
check<Assignable<Success<Svc<typeof Orchestrator>["send"]>, Out<"messages.send">>>(true)
check<Assignable<Success<Svc<typeof Orchestrator>["lookupSend"]>, Out<"messages.lookupSend">>>(true)
check<Assignable<Success<Svc<typeof Orchestrator>["interrupt"]>, Out<"turns.interrupt">>>(true)
check<Assignable<StreamItem<Svc<typeof LiveHub>["subscribeConversation"]>, Elem<Out<"conversations.subscribe">>>>(true)
check<Assignable<StreamItem<Svc<typeof LiveHub>["subscribeRoster"]>, Elem<Out<"roster.subscribe">>>>(true)
check<Assignable<Success<Svc<typeof ConversationService>["history"]>, Out<"conversations.history">>>(true)
check<Assignable<Success<Svc<typeof ApprovalService>["respond"]>, Out<"requests.respond">>>(true)
check<Assignable<Success<Svc<typeof RoutineScheduler>["runNow"]>, Out<"routines.runNow">>>(true)
check<Assignable<Success<Svc<typeof RoutineScheduler>["runs"]>, Out<"routines.runs">>>(true)
check<Assignable<Success<Svc<typeof MemoryService>["get"]>, Out<"memory.get">>>(true)
check<Assignable<Success<Svc<typeof MemoryService>["setIndex"]>, Out<"memory.setIndex">>>(true)
check<Assignable<Success<Svc<typeof SkillService>["upsert"]>, Out<"skills.upsert">>>(true)
check<Assignable<Success<Svc<typeof SettingsService>["update"]>, Out<"settings.update">>>(true)
check<Assignable<Success<Svc<typeof SettingsService>["upsertRule"]>, Out<"rules.upsert">>>(true)
check<Assignable<Success<Svc<typeof UsageService>["byBot"]>, Out<"usage.byBot">>>(true)
check<Assignable<Success<Svc<typeof AttachmentService>["upload"]>, Out<"attachments.upload">>>(true)
check<Assignable<Success<Svc<typeof NodeDirectory>["list"]>, Out<"nodes.list">>>(true)
check<Assignable<Success<Svc<typeof NodeAdmin>["createPairingCode"]>, Out<"nodes.createPairingCode">>>(true)
check<Assignable<Success<Svc<typeof ComputerPort>["ensure"]>, Out<"computer.ensure">>>(true)

describe("service shapes", () => {
  test("type-level RPC ↔ service checks compile (see file)", () => {
    expect(true).toBe(true)
  })
})
