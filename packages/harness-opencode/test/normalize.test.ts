import type { HarnessEvent, HarnessItem, TurnId } from "@openbot/contracts"
import { HarnessEvent as HarnessEventSchema, MESSAGING_ACTIVITY, THINKING_ACTIVITY } from "@openbot/contracts"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { OpenCodeEvent } from "../src/client.ts"
import { classifyTool, eventSessionId, makeNormalizer, turnErrorOf } from "../src/normalize.ts"

interface Frame {
  readonly seq: number
  readonly source: string
  readonly payload: any
}

const frames: ReadonlyArray<Frame> = (await Bun.file(new URL("./fixtures/opencode-basic.jsonl", import.meta.url)).text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))

const SESSION = frames[0]!.payload.result.id as string

/** Replays the fixture: each `send` begins a new OpenBot turn. */
const replay = (opts?: { readonly window?: number }) => {
  const normalizer = makeNormalizer({ sessionID: SESSION, contextWindow: () => opts?.window })
  const turns: Array<Array<HarnessEvent>> = []
  let index = 0
  for (const frame of frames) {
    if (frame.source === "openbot.control") {
      if (frame.payload.action === "send") {
        normalizer.beginTurn(`trn_${++index}` as TurnId)
        turns.push([])
      }
      continue
    }
    const out = normalizer.apply(frame.payload as OpenCodeEvent)
    if (turns.length === 0 && out.length > 0) throw new Error("events before the first turn")
    turns[turns.length - 1]?.push(...out)
  }
  return { normalizer, turns }
}

/** Last upserted version of every item key in a turn. */
const finalItems = (events: ReadonlyArray<HarnessEvent>): Map<string, HarnessItem> => {
  const map = new Map<string, HarnessItem>()
  for (const e of events) if (e._tag === "ItemUpserted") map.set(e.key, e.item)
  return map
}
const ofTag = <T extends HarnessItem["_tag"]>(items: Map<string, HarnessItem>, tag: T) =>
  [...items.values()].filter((i): i is Extract<HarnessItem, { _tag: T }> => i._tag === tag)
const last = (events: ReadonlyArray<HarnessEvent>) => events[events.length - 1]

describe("normalize (opencode-basic.jsonl)", () => {
  const { turns, normalizer } = replay({ window: 1000 })

  test("seven turns, each ending with exactly one terminal", () => {
    expect(turns).toHaveLength(7)
    for (const events of turns) {
      const terminals = events.filter((e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted")
      expect(terminals).toHaveLength(1)
      expect(terminals[0] as HarnessEvent | undefined).toBe(last(events))
    }
    expect(turns.slice(0, 6).every((t) => last(t)?._tag === "TurnCompleted")).toBe(true)
    expect(last(turns[6]!)?._tag).toBe("TurnInterrupted")
  })

  test("every emitted event is a valid contracts.HarnessEvent", () => {
    const encode = Schema.encodeUnknownSync(HarnessEventSchema)
    for (const events of turns) for (const e of events) expect(() => encode(e)).not.toThrow()
  })

  test("A: reasoning + text, streamed then final; usage per turn", () => {
    const events = turns[0]!
    const items = finalItems(events)
    const [message] = ofTag(items, "Message")
    expect(message).toMatchObject({ text: "Hello from the scripted OpenCode.", streaming: false, role: "bot" })
    const [reasoning] = ofTag(items, "Reasoning")
    expect(reasoning).toMatchObject({ text: "The user says hello. Keep it short.", streaming: false })
    const streamingUpserts = events.filter((e) => e._tag === "ItemUpserted" && e.item._tag === "Message" && e.item.streaming)
    expect(streamingUpserts.length).toBeGreaterThan(0)
    const usage = events.find((e) => e._tag === "Usage")
    expect(usage).toMatchObject({ usage: { inputTokens: 100, outputTokens: 10 }, turnId: "trn_1" })
    expect(events.find((e) => e._tag === "ContextUsage")).toMatchObject({ usedTokens: 110, windowTokens: 1000 })
    expect(events.some((e) => e._tag === "Activity" && e.label === "Typing…")).toBe(true)
  })

  test("B: auto-allowed read tool → completed with output", () => {
    const items = finalItems(turns[1]!)
    const [tool] = ofTag(items, "ToolCall")
    expect(tool).toMatchObject({ toolName: "read", kind: "file-read", status: "completed", inputSummary: "README.md", title: "Read README.md" })
    expect(tool!.outputPreview).toContain("The answer is 42.")
    const usage = turns[1]!.find((e) => e._tag === "Usage")
    expect(usage).toMatchObject({ usage: { inputTokens: 200, outputTokens: 20 } })
  })

  test("C: shell command with exit code", () => {
    const [tool] = ofTag(finalItems(turns[2]!), "ToolCall")
    expect(tool).toMatchObject({
      toolName: "shell",
      kind: "shell",
      status: "completed",
      inputSummary: "touch approved.txt && echo openbot-fixture",
      command: { command: "touch approved.txt && echo openbot-fixture", exitCode: 0 },
    })
  })

  test("D: rejected write → declined with the diff from permission.asked", () => {
    const [tool] = ofTag(finalItems(turns[3]!), "ToolCall")
    expect(tool).toMatchObject({ toolName: "write", kind: "file-write", status: "declined", error: "Unable to write denied.txt" })
    expect(tool!.fileChanges?.[0]).toMatchObject({ path: "denied.txt", kind: "add" })
    expect(tool!.fileChanges?.[0]?.diff).toContain("+should not exist")
  })

  test("E: question tool", () => {
    const [tool] = ofTag(finalItems(turns[4]!), "ToolCall")
    expect(tool).toMatchObject({ toolName: "question", kind: "question", status: "completed", inputSummary: "Which avatar color?" })
  })

  test("F: OpenBot MCP tool → mcp ref", () => {
    const [tool] = ofTag(finalItems(turns[5]!), "ToolCall")
    expect(tool).toMatchObject({ toolName: "openbot_whoami", kind: "mcp", status: "completed", mcp: { server: "openbot", tool: "whoami" } })
    expect(tool!.outputPreview).toBe("node=fixture-node")
  })

  test("G: interrupt marks the streamed text aborted", () => {
    const events = turns[6]!
    const [message] = ofTag(finalItems(events), "Message")
    expect(message).toMatchObject({ text: "wave 1, ", streaming: false, aborted: true })
    expect(last(events)).toEqual({ _tag: "TurnInterrupted", turnId: "trn_7" as TurnId })
    expect(normalizer.activeTurn()).toBeUndefined()
  })

  test("keys are stable and unique per native part", () => {
    const keys = turns.flatMap((t) => [...finalItems(t).keys()])
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((k) => k.startsWith("oc:"))).toBe(true)
  })

  test("host events are dropped and other sessions are ignored", () => {
    const n = makeNormalizer({ sessionID: SESSION })
    n.beginTurn("trn_x" as TurnId)
    expect(n.apply({ type: "mcp.status.changed", data: { server: "openbot" } })).toEqual([])
    expect(n.apply({ type: "session.text.started", data: { sessionID: "ses_other", assistantMessageID: "m", ordinal: 0 } })).toEqual([])
    expect(n.apply({ type: "session.execution.succeeded", data: { sessionID: "ses_other" } })).toEqual([])
    expect(n.activeTurn()).toBe("trn_x" as TurnId)
    expect(n.apply({ type: "some.future.event", data: { sessionID: SESSION } })).toEqual([])
    expect(n.apply({ type: "session.text.delta", data: "garbage" })).toEqual([])
  })

  test("no events without an active turn", () => {
    const n = makeNormalizer({ sessionID: SESSION })
    for (const frame of frames) if (frame.source === "opencode.event") expect(n.apply(frame.payload)).toEqual([])
  })

  test("failed execution → TurnFailed with a classified error; failTurn/interruptTurn", () => {
    const n = makeNormalizer({ sessionID: "ses_1" })
    n.beginTurn("trn_1" as TurnId)
    n.apply({ type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, delta: "partial" } })
    const out = n.apply({ type: "session.execution.failed", data: { sessionID: "ses_1", error: { type: "provider.rate_limit", message: "slow down", status: 429 } } })
    expect(out.find((e) => e._tag === "ItemUpserted")).toMatchObject({ item: { _tag: "Message", text: "partial", streaming: false } })
    expect(last(out)).toEqual({ _tag: "TurnFailed", turnId: "trn_1" as TurnId, error: { code: "provider.rate_limit", message: "slow down", retryable: true } })

    n.beginTurn("trn_2" as TurnId)
    expect(last(n.failTurn({ code: "closed", message: "gone", retryable: true }))).toMatchObject({ _tag: "TurnFailed", turnId: "trn_2" })
    expect(n.failTurn({ code: "closed", message: "gone", retryable: true })).toEqual([])
    n.beginTurn("trn_3" as TurnId)
    expect(n.interruptTurn()).toEqual([{ _tag: "TurnInterrupted", turnId: "trn_3" as TurnId }])
  })

  test("non-user interruption reasons fail the turn (retryable)", () => {
    const n = makeNormalizer({ sessionID: "ses_1" })
    n.beginTurn("trn_1" as TurnId)
    const out = n.apply({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "shutdown" } })
    expect(last(out)).toMatchObject({ _tag: "TurnFailed", error: { code: "interrupted:shutdown", retryable: true } })
  })
})

const live: ReadonlyArray<OpenCodeEvent> = (await Bun.file(new URL("./fixtures/opencode-server-live.jsonl", import.meta.url)).text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))

describe("normalize (opencode-server-live.jsonl: real 2.0.6 server, real model)", () => {
  const sessionID = (live[0]!.data as { sessionID: string }).sessionID
  const n = makeNormalizer({ sessionID, contextWindow: () => 262_144 })
  n.beginTurn("trn_live" as TurnId)
  const events = live.flatMap((e) => n.apply(e))
  const items = finalItems(events)

  test("one completed turn: two reasoning blocks, the tool call, the final text", () => {
    expect(last(events)).toEqual({ _tag: "TurnCompleted", turnId: "trn_live" as TurnId, stopReason: "succeeded" })
    expect(events.filter((e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted")).toHaveLength(1)
    expect(ofTag(items, "Reasoning")).toHaveLength(2)
    expect(ofTag(items, "Reasoning").every((r) => !r.streaming && r.text.length > 0)).toBe(true)
    const [tool] = ofTag(items, "ToolCall")
    expect(tool).toMatchObject({ toolName: "openbot_ping", status: "completed", inputSummary: "{\"note\":\"x\"}" })
    expect(tool!.outputPreview).toContain("pong-from-openbot")
    const [message] = ofTag(items, "Message")
    expect(message!.text).toStartWith("It returned `pong-from-openbot")
    expect(message!.streaming).toBe(false)
  })

  test("usage sums both steps; context = last step / window", () => {
    expect(events.find((e) => e._tag === "Usage")).toMatchObject({
      usage: { inputTokens: 8_764, outputTokens: 69, cachedInputTokens: 9_664, reasoningTokens: 48 },
    })
    expect(n.contextUsage()).toEqual({ usedTokens: 104 + 9_152 + 50, windowTokens: 262_144 })
  })

  test("every emitted event is a valid contracts.HarnessEvent", () => {
    const encode = Schema.encodeUnknownSync(HarnessEventSchema)
    for (const e of events) expect(() => encode(e)).not.toThrow()
  })
})

describe("helpers", () => {
  test("classifyTool", () => {
    expect(classifyTool("shell").kind).toBe("shell")
    expect(classifyTool("edit").kind).toBe("file-edit")
    expect(classifyTool("webfetch").kind).toBe("web")
    expect(classifyTool("openbot-3f9a1c2b7d_shell")).toEqual({ kind: "shell", mcp: { server: "openbot", tool: "shell" } })
    expect(classifyTool("openbot-3f9a1c2b7d_list_bots")).toEqual({ kind: "mcp", mcp: { server: "openbot", tool: "list_bots" } })
    expect(classifyTool("todowrite").kind).toBe("other")
  })

  test("turnErrorOf", () => {
    expect(turnErrorOf({ type: "provider.auth", message: "bad key", status: 401 }).retryable).toBe(false)
    expect(turnErrorOf({ type: "provider.overloaded", message: "x", status: 529 }).retryable).toBe(true)
    expect(turnErrorOf(undefined)).toEqual({ code: "turn-failed", message: "OpenCode failed to respond.", retryable: false })
  })

  test("compacted: context usage becomes the summary estimate (unknown window → unknown)", () => {
    const n = makeNormalizer({ sessionID: "ses_1", contextWindow: (m) => (m.id === "big" ? 100_000 : undefined) })
    n.compacted(2_000, { providerID: "p", id: "big" })
    expect(n.contextUsage()).toEqual({ usedTokens: 2_000, windowTokens: 100_000 })
    n.compacted(500_000)
    expect(n.contextUsage()).toEqual({ usedTokens: 100_000, windowTokens: 100_000 })
    n.compacted(10, { providerID: "p", id: "unknown" })
    expect(n.contextUsage()).toBeUndefined()
  })

  test("eventSessionId reads forms too", () => {
    expect(eventSessionId({ type: "form.created", data: { form: { sessionID: "ses_9" } } })).toBe("ses_9")
    expect(eventSessionId({ type: "server.connected", data: {} })).toBeUndefined()
  })
})

describe("host node attribution", () => {
  const ev = (type: string, data: Record<string, unknown>): OpenCodeEvent =>
    ({ id: `evt_${type}_${String(data.id)}`, created: 1, type, data: { sessionID: "ses_h", assistantMessageID: "msg_1", ...data } }) as never

  test("gateway node tools without `node` run on the host node (B1 on a remote node)", () => {
    const normalizer = makeNormalizer({ sessionID: "ses_h", hostNodeId: "nod_remote" as never })
    normalizer.beginTurn("trn_1" as TurnId)
    const events = [
      ev("session.tool.input.started", { id: "c1", name: "openbot-3f9a1c2b7d_write_file" }),
      ev("session.tool.called", { id: "c1", name: "openbot-3f9a1c2b7d_write_file", input: { path: "a.txt", content: "x" } }),
      ev("session.tool.input.started", { id: "c2", name: "openbot-3f9a1c2b7d_shell" }),
      ev("session.tool.called", { id: "c2", name: "openbot-3f9a1c2b7d_shell", input: { command: "ls", node: "nod_other" } }),
      ev("session.tool.input.started", { id: "c3", name: "openbot-3f9a1c2b7d_list_bots" }),
      ev("session.tool.input.started", { id: "c4", name: "bash" }),
    ].flatMap((e) => normalizer.apply(e))
    const items = finalItems(events)
    const tool = (id: string) => [...items.entries()].find(([key]) => key.endsWith(id))?.[1] as { nodeId?: string } | undefined
    expect(tool("c1")?.nodeId).toBe("nod_remote")
    expect(tool("c2")?.nodeId).toBe("nod_other")
    expect(tool("c3")).toBeDefined()
    expect(tool("c3")?.nodeId).toBeUndefined()
    expect(tool("c4")?.nodeId).toBeUndefined()
  })
})

describe("activity phrases (D6.4: human, no plumbing)", () => {
  const PLUMBING = /\b(task|tasks|subagent|session|spawn|worker|tool|tools|bot|agent|mcp|delegat\w*)\b|_/i
  const ev = (type: string, data: Record<string, unknown>): OpenCodeEvent =>
    ({ id: `evt_${type}_${String(data.id)}`, created: 1, type, data: { sessionID: "ses_a", assistantMessageID: "msg_1", ...data } }) as never
  const labelOf = (name: string) => {
    const normalizer = makeNormalizer({ sessionID: "ses_a" })
    normalizer.beginTurn("trn_1" as TurnId)
    const out = normalizer.apply(ev("session.tool.input.started", { id: "c1", name }))
    return out.find((e) => e._tag === "Activity")?.label
  }
  const bookkeeping = [
    "start_task", "list_tasks", "check_task", "cancel_task", "remember", "forget", "recall_memory", "list_bots", "list_models",
    "create_routine", "update_routine", "list_routines", "list_sections", "create_section", "move_bot_to_section", "save_skill",
    "list_skills", "react", "create_bot", "update_bot", "list_nodes", "notify_user",
  ]

  test("OpenBot's bookkeeping tools and native helpers read as thinking; messaging reads as sending a message", () => {
    for (const tool of bookkeeping) expect(labelOf(`openbot-3f9a1c2b7d_${tool}`)).toBe(THINKING_ACTIVITY)
    for (const tool of ["message_bot", "handoff_task", "post_to_group"]) expect(labelOf(`openbot-3f9a1c2b7d_${tool}`)).toBe(MESSAGING_ACTIVITY)
    expect(labelOf("task")).toBe(THINKING_ACTIVITY)
    expect(labelOf("todowrite")).toBe(THINKING_ACTIVITY)
    expect(labelOf("bash")).toBe("Running a command")
    expect(labelOf("openbot-3f9a1c2b7d_shell")).toBe("Running a command")
    expect(labelOf("openbot-3f9a1c2b7d_browser")).toBe("Using the browser")
    expect(labelOf("openbot-3f9a1c2b7d_send_file")).toBe("Sending a file")
    expect(labelOf("openbot-3f9a1c2b7d_ask_user")).toBe("Asking you a question")
    expect(labelOf("webfetch")).toBe("Searching the web")
  })

  test("no phrase carries a tool name or a plumbing word", () => {
    const names = [
      ...[...bookkeeping, "message_bot", "handoff_task", "post_to_group", "send_file", "ask_user", "request_approval", "shell", "read_file", "grep"]
        .map((t) => `openbot-3f9a1c2b7d_${t}`),
      "task", "subagent", "agent", "bash", "read", "edit", "glob", "webfetch", "websearch", "todowrite", "question", "whatever",
    ]
    for (const name of names) expect(labelOf(name) ?? "").not.toMatch(PLUMBING)
  })
})
