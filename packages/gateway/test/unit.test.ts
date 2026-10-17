import { describe, expect, test } from "bun:test"
import type { BotId, Routine, RoutineId } from "@openbot/contracts"
import { BotService, NodeDirectory, Notifier, RoutineScheduler, SkillService } from "@openbot/core"
import { makeBot, makeClaims } from "@openbot/core/testing"
import { NodeUnavailable, PathDenied } from "@openbot/node-protocol"
import { NodeUnavailable as ContractNodeUnavailable, InvalidInput, NotFound } from "@openbot/contracts"
import { Effect, Exit, Layer } from "effect"
import { botIdFromPath, callIdOf, DefaultToolkits } from "../src/McpGateway.ts"
import * as p from "../src/params.ts"
import {
  capText,
  errorResult,
  renderToolError,
  toWireResult,
  ToolRefusal,
  truncateUtf8,
  truncateUtf8Start,
  utf8Length,
} from "../src/results.ts"
import type { ToolCallContext } from "../src/tool.ts"
import { BotToolkit } from "../src/toolkits/bot.ts"
import { toBrowserAction } from "../src/toolkits/browser.ts"
import { resolveNodePath } from "../src/toolkits/node.ts"
import { textOf } from "./harness.ts"

describe("params", () => {
  const spec = p.params({
    name: p.text("n"),
    count: p.optional(p.number("c", { integer: true, min: 1, max: 3 }), 2),
    mode: p.optional(p.literals(["a", "b"])),
    tags: p.optional(p.array(p.string(), "t", { minItems: 1, maxItems: 2 })),
    nested: p.optional(p.object({ flag: p.boolean() })),
  })

  test("json schema uses the safe subset", () => {
    expect(spec.inputSchema).toMatchObject({ type: "object", required: ["name"] })
    expect((spec.inputSchema.properties.tags as Record<string, unknown>).items).toEqual({ type: "string" })
    expect((spec.inputSchema.properties.tags as Record<string, unknown>).maxItems).toBeUndefined()
    expect(p.findUnsafeSchemaKeywords(spec.inputSchema)).toEqual([])
  })

  test("decodes, applies defaults, coerces numeric strings, ignores unknown keys", () => {
    expect(spec.decode({ name: "x", extra: 1 })).toEqual({ ok: true, value: { name: "x", count: 2 } })
    expect(spec.decode({ name: "x", count: "3", nested: { flag: "true" } })).toEqual({
      ok: true,
      value: { name: "x", count: 3, nested: { flag: true } },
    })
  })

  test("refuses with model-readable messages", () => {
    expect(spec.decode({})).toEqual({ ok: false, error: "`name` is required" })
    expect(spec.decode({ name: "" })).toEqual({ ok: false, error: "`name` must not be empty" })
    expect(spec.decode({ name: "x", count: 9 })).toEqual({ ok: false, error: "`count` must be at most 3" })
    expect(spec.decode({ name: "x", mode: "c" })).toEqual({ ok: false, error: "`mode` must be one of: a, b" })
    expect(spec.decode({ name: "x", tags: ["a", "b", "c"] })).toEqual({ ok: false, error: "`tags` must have at most 2 items" })
    expect(spec.decode({ name: "x", nested: { flag: 3 } })).toEqual({ ok: false, error: "`nested.flag` must be true or false" })
    expect(spec.decode("nope")).toEqual({ ok: false, error: "Arguments must be an object" })
  })

  test("every default tool schema is harness-safe (R5) and described within 4,000 chars (R7)", () => {
    const names = new Set<string>()
    for (const tool of DefaultToolkits) {
      expect(names.has(tool.name)).toBe(false)
      names.add(tool.name)
      expect(p.findUnsafeSchemaKeywords(tool.params.inputSchema)).toEqual([])
      expect(tool.params.inputSchema.type).toBe("object")
      expect(tool.description.length).toBeLessThanOrEqual(4000)
      expect(tool.description.length).toBeGreaterThan(20)
    }
    expect([...names].sort()).toEqual(
      [
        "message_bot", "post_to_group", "react", "handoff_task", "list_bots", "list_models", "create_bot", "update_bot", "list_sections", "create_section", "rename_section", "delete_section", "move_bot_to_section", "ask_user", "request_approval", "notify_user", "send_file",
        "remember", "forget", "recall_memory", "create_routine", "update_routine", "list_routines", "save_skill",
        "list_skills", "list_nodes", "start_task", "list_tasks", "check_task", "cancel_task", "update_task", "shell", "read_file", "write_file", "edit_file", "list_dir", "glob", "grep",
        "browser",
      ].sort(),
    )
  })
})

describe("results", () => {
  test("utf8 truncation never splits characters", () => {
    const s = "a😀b😀c"
    for (let n = 0; n <= utf8Length(s); n++) {
      expect(utf8Length(truncateUtf8(s, n))).toBeLessThanOrEqual(n)
      expect(utf8Length(truncateUtf8Start(s, n))).toBeLessThanOrEqual(n)
      expect(truncateUtf8(s, n)).not.toContain("\uFFFD")
    }
  })

  test("capText keeps head and tail within the budget", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n")
    const capped = capText(text, 2000, "saved at /x.log")
    expect(capped.truncated).toBe(true)
    expect(utf8Length(capped.text)).toBeLessThanOrEqual(2000)
    expect(capped.text).toStartWith("row 0\n")
    expect(capped.text).toEndWith("row 4999")
    expect(capped.text).toContain("saved at /x.log")
  })

  test("toWireResult strips structuredContent, caps text and enforces ERROR: on errors", () => {
    const sneaky = { content: [{ type: "text", text: "hi" }], structuredContent: { a: 1 } } as never
    expect(toWireResult(sneaky)).toEqual({ content: [{ type: "text", text: "hi" }] })
    const err = toWireResult({
      isError: true,
      content: [{ type: "text", text: "boom" }, { type: "image", data: "x", mimeType: "image/png" }],
    })
    expect(err).toEqual({ isError: true, content: [{ type: "text", text: "ERROR: boom" }] })
    const big = toWireResult({ content: [{ type: "text", text: "x".repeat(50_000) }] })
    expect(utf8Length(big.content[0]!.type === "text" ? big.content[0]!.text : "")).toBeLessThanOrEqual(10_000)
    expect(toWireResult({ content: [] })).toEqual({ content: [{ type: "text", text: "(no output)" }] })
    expect(errorResult("ERROR: once").content[0]).toEqual({ type: "text", text: "ERROR: once" })
  })

  test("renderToolError covers contract, node-protocol and gateway errors", () => {
    expect(renderToolError(new InvalidInput({ message: "Bot messaging is turned off" }))).toBe("ERROR: Bot messaging is turned off")
    expect(renderToolError(new NotFound({ entity: "bot", id: "Zed" }))).toBe("ERROR: bot Zed was not found")
    expect(renderToolError(new ContractNodeUnavailable({ nodeId: "n" as never, message: "Node Laptop is offline" }))).toBe(
      "ERROR: Node Laptop is offline",
    )
    expect(renderToolError(new NodeUnavailable({ nodeId: "n1", reason: "gone" }))).toBe("ERROR: Node n1 is offline: gone")
    expect(renderToolError(new PathDenied({ path: "/x", reason: "deny-list" }))).toBe("ERROR: Access to /x is denied: deny-list")
    expect(renderToolError(new ToolRefusal({ message: "nope" }))).toBe("ERROR: nope")
    expect(renderToolError(new Error("secret internals"))).toBe("ERROR: Internal error")
  })
})

describe("helpers", () => {
  test("botIdFromPath / callIdOf", () => {
    expect(botIdFromPath("/mcp/bot_1")).toBe("bot_1")
    expect(botIdFromPath("/internal/mcp/bot%201/")).toBe("bot 1")
    expect(botIdFromPath("/rpc")).toBeUndefined()
    expect(callIdOf({ "claudecode/toolUseId": "toolu_1", progressToken: 1 })).toBe("toolu_1")
    expect(callIdOf({ callId: "call_9" })).toBe("call_9")
    expect(callIdOf({ "ai.opencode/sessionID": "ses_1" })).toBeUndefined()
  })

  test("resolveNodePath", () => {
    expect(resolveNodePath("/w/bot", undefined)).toBe("/w/bot")
    expect(resolveNodePath("/w/bot/", "src/a.ts")).toBe("/w/bot/src/a.ts")
    expect(resolveNodePath("/w/bot", "./a")).toBe("/w/bot/a")
    expect(resolveNodePath("/w/bot", "/etc/hosts")).toBe("/etc/hosts")
    expect(resolveNodePath("/w/bot", "~/x")).toBe("~/x")
    expect(resolveNodePath("C:\\w\\bot", "a.txt")).toBe("C:\\w\\bot\\a.txt")
  })

  test("toBrowserAction maps flat args", async () => {
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromiseExit(e)
    expect(await run(toBrowserAction({ action: "navigate", url: "https://x" }))).toEqual(Exit.succeed({ _tag: "navigate", url: "https://x" }))
    expect(await run(toBrowserAction({ action: "click", x: 1, y: 2 }))).toEqual(Exit.succeed({ _tag: "click", x: 1, y: 2 }))
    expect(await run(toBrowserAction({ action: "tabs" }))).toEqual(Exit.succeed({ _tag: "tabs", op: "list" }))
    expect(Exit.isFailure(await run(toBrowserAction({ action: "click", ref: undefined })))).toBe(true)
  })
})

// ---------------------------------------------------------------------------- bot tools, called directly

const BOT = "bot_alpha" as BotId
const claims = makeClaims({ botId: BOT })
const ctx: ToolCallContext = { tool: { claims, callId: "toolu_x" }, claims, sessionId: "s", progress: () => Effect.void }
const tool = (name: string) => BotToolkit.find((t) => t.name === name)!

const callTool = (name: string, args: unknown, layer: Layer.Layer<any>) => {
  const t = tool(name)
  const decoded = t.params.decode(args)
  if (!decoded.ok) throw new Error(decoded.error)
  return Effect.runPromise(
    t.handler(decoded.value, ctx).pipe(
      Effect.catch((e) => Effect.succeed(errorResult(renderToolError(e)))),
      Effect.provide(layer),
    ) as Effect.Effect<any>,
  )
}

const routine = (overrides?: Partial<Routine>): Routine => ({
  id: "rtn_1" as RoutineId,
  botId: BOT,
  name: "Standup",
  prompt: "Summarize",
  trigger: { type: "cron", schedule: "0 9 * * *", timezone: "Europe/Berlin" },
  enabled: true,
  output: "direct",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("bot tools", () => {
  test("create_routine builds a valid RoutineSpec with defaults", async () => {
    const created: Array<unknown> = []
    const layer = Layer.mock(RoutineScheduler, {
      create: (actor, input) =>
        Effect.sync(() => {
          created.push({ actor: actor.kind, ...input })
          return routine({ name: input.spec.name, trigger: input.spec.trigger })
        }),
    })
    const result = await callTool("create_routine", { name: "Daily", prompt: "Do it", schedule: "cron", cron: "0 8 * * 1-5" }, layer)
    expect(textOf(result)).toContain("Created routine Daily")
    expect(created).toEqual([
      {
        actor: "bot",
        botId: BOT,
        spec: {
          name: "Daily",
          prompt: "Do it",
          trigger: { type: "cron", schedule: "0 8 * * 1-5", timezone: "UTC" },
          enabled: true,
          output: "direct",
        },
      },
    ])
    const tooOften = await callTool("create_routine", { name: "x", prompt: "y", schedule: "interval", every_minutes: 1 }, layer)
    expect(textOf(tooOften)).toStartWith("ERROR: Invalid routine")
    const noCron = await callTool("create_routine", { name: "x", prompt: "y", schedule: "cron" }, layer)
    expect(textOf(noCron)).toBe("ERROR: `cron` is required when schedule is cron")
  })

  test("update_routine merges partial args over the current routine and only touches own routines", async () => {
    const updated: Array<unknown> = []
    const layer = Layer.mock(RoutineScheduler, {
      get: (id) => Effect.succeed(id === "rtn_other" ? routine({ id, botId: "bot_other" as BotId }) : routine({ id })),
      update: (_actor, input) =>
        Effect.sync(() => {
          updated.push(input)
          return routine({ ...input.spec })
        }),
    })
    await callTool("update_routine", { routine_id: "rtn_1", cron: "30 9 * * *", enabled: false }, layer)
    expect(updated).toEqual([
      {
        routineId: "rtn_1",
        spec: {
          name: "Standup",
          prompt: "Summarize",
          trigger: { type: "cron", schedule: "30 9 * * *", timezone: "Europe/Berlin" },
          enabled: false,
          output: "direct",
        },
      },
    ])
    const other = await callTool("update_routine", { routine_id: "rtn_other", enabled: false }, layer)
    expect(textOf(other)).toBe("ERROR: You can only change your own routines")
  })

  test("save_skill validates the slug; notify_user reports suppression", async () => {
    const skills = Layer.mock(SkillService, {
      upsert: (_actor, input) => Effect.succeed({ ...input, updatedAt: 0 }),
    })
    expect(textOf(await callTool("save_skill", { name: "Bad Name", description: "d", body: "b" }, skills))).toStartWith(
      "ERROR: Invalid skill",
    )
    expect(textOf(await callTool("save_skill", { name: "weekly-report", description: "d", body: "b" }, skills))).toBe(
      "Saved skill weekly-report.",
    )

    const muted = Layer.mergeAll(
      Layer.mock(Notifier, { notify: () => Effect.succeed(undefined) }),
      Layer.mock(BotService, { get: () => Effect.succeed(makeBot({ id: BOT, name: "Alpha" })) }),
    )
    expect(textOf(await callTool("notify_user", { text: "done" }, muted))).toContain("muted notifications")
  })

  test("refusals from services surface as ERROR text", async () => {
    const layer = Layer.mergeAll(
      Layer.mock(NodeDirectory, { list: Effect.succeed([]) }),
      Layer.mock(RoutineScheduler, { get: () => Effect.fail(new NotFound({ entity: "routine", id: "rtn_9" })) }),
    )
    expect(textOf(await callTool("update_routine", { routine_id: "rtn_9", enabled: true }, layer))).toBe(
      "ERROR: routine rtn_9 was not found",
    )
    expect(textOf(await callTool("list_nodes", {}, layer))).toBe("No nodes are available to you.")
  })
})
