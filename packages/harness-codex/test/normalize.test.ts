import { describe, expect, test } from "bun:test"
import type { HarnessEvent, HarnessItem, TurnId } from "@openbot/contracts"
import {
  CONNECTED_APP_ACTIVITY,
  HarnessEvent as HarnessEventSchema,
  LOCAL_NODE_ID,
  MESSAGING_ACTIVITY,
  THINKING_ACTIVITY,
} from "@openbot/contracts"
import { Schema } from "effect"
import { CodexNormalizer, stripShellWrapper, turnErrorOf } from "../src/normalize.ts"
import { loadFixture, ofTag, replayFixture, turnId } from "./support.ts"

type Upsert = Extract<HarnessEvent, { _tag: "ItemUpserted" }>

const upserts = (events: ReadonlyArray<HarnessEvent>, turn: TurnId) =>
  ofTag(events, "ItemUpserted").filter((e) => e.turnId === turn)
/** The last version of every item of `turn`, in first-seen order. */
const finalItems = (
  events: ReadonlyArray<HarnessEvent>,
  turn: TurnId,
): ReadonlyArray<HarnessItem & { key: string }> => {
  const byKey = new Map<string, HarnessItem>()
  for (const e of upserts(events, turn)) byKey.set(e.key, e.item)
  return [...byKey.entries()].map(([key, item]) => ({ ...item, key }))
}
const terminalOf = (events: ReadonlyArray<HarnessEvent>, turn: TurnId) =>
  events.find(
    (e) => (e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted") && e.turnId === turn,
  )

describe("normalizer on the recorded codex-basic fixture", () => {
  const replay = replayFixture(loadFixture("codex-basic.jsonl"))
  const [A, B, C, D, E, F] = replay.turns as [TurnId, TurnId, TurnId, TurnId, TurnId, TurnId]

  test("six turns, each started once and ended once, in order", () => {
    expect(replay.turns.length).toBe(6)
    for (const turn of replay.turns) {
      expect(ofTag(replay.events, "TurnStarted").filter((e) => e.turnId === turn).length).toBe(1)
      const ends = replay.events.filter(
        (e) =>
          (e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted") && e.turnId === turn,
      )
      expect(ends.length).toBe(1)
      // No item of the turn after its end.
      const endIndex = replay.events.indexOf(ends[0]!)
      expect(replay.events.slice(endIndex + 1).some((e) => e._tag === "ItemUpserted" && e.turnId === turn)).toBe(false)
    }
    expect(terminalOf(replay.events, E)?._tag).toBe("TurnInterrupted")
    for (const turn of [A, B, C, D, F]) expect(terminalOf(replay.events, turn)?._tag).toBe("TurnCompleted")
  })

  test("every event encodes with the contracts schema", () => {
    const encode = Schema.encodeUnknownSync(HarnessEventSchema)
    for (const event of replay.events) expect(() => encode(event)).not.toThrow()
  })

  test("A: streamed reasoning summary and message, final versions not streaming", () => {
    const items = finalItems(replay.events, A)
    expect(items).toEqual([
      {
        _tag: "Reasoning",
        key: expect.stringMatching(/:rs_0$/),
        text: "**Greeting** The user says hello; reply briefly.",
        streaming: false,
        source: "summary",
      },
      {
        _tag: "Message",
        key: expect.stringMatching(/:msg_0$/),
        role: "bot",
        text: "Hello from the scripted Codex.",
        streaming: false,
      },
    ])
    const streamed = upserts(replay.events, A)
      .filter((e) => e.item._tag === "Message")
      .map((e) => e.item)
    expect(streamed.map((item) => item._tag === "Message" && item.text)).toEqual([
      "Hello ",
      "Hello from the ",
      "Hello from the scripted Codex.",
      "Hello from the scripted Codex.",
    ])
    expect(streamed.slice(0, -1).every((item) => item._tag === "Message" && item.streaming)).toBe(true)
  })

  test("B: an approved command, with its output and exit code", () => {
    const tool = finalItems(replay.events, B).find((i) => i._tag === "ToolCall")
    expect(tool).toMatchObject({
      _tag: "ToolCall",
      toolName: "exec_command",
      kind: "shell",
      status: "completed",
      title: "touch approved.txt && echo openbot-fixture",
      inputSummary: "touch approved.txt && echo openbot-fixture",
      outputPreview: "openbot-fixture\n",
      command: { command: "touch approved.txt && echo openbot-fixture", cwd: "<CWD>", exitCode: 0 },
      nodeId: LOCAL_NODE_ID,
    })
    const first = upserts(replay.events, B).find((e) => e.item._tag === "ToolCall")
    expect(first?.item).toMatchObject({ status: "running" })
    expect(
      ofTag(replay.events, "Activity").some((a) => a.label === "Running a command" && a.toolKind === "shell"),
    ).toBe(true)
  })

  test("C: a declined command stays declined", () => {
    const tool = finalItems(replay.events, C).find((i) => i._tag === "ToolCall")
    expect(tool).toMatchObject({ toolName: "exec_command", status: "declined", inputSummary: "rm -f approved.txt" })
    expect(finalItems(replay.events, C).find((i) => i._tag === "Message")).toMatchObject({ text: "OK, left it alone." })
  })

  test("D: OpenBot MCP tool calls are named mcp__openbot__* with their results", () => {
    const tools = finalItems(replay.events, D).filter((i) => i._tag === "ToolCall")
    expect(tools).toEqual([
      expect.objectContaining({
        toolName: "mcp__openbot__whoami",
        title: "Whoami",
        kind: "mcp",
        status: "completed",
        mcp: { server: "openbot", tool: "whoami" },
        outputPreview: "node=fixture-node",
        output: { text: "node=fixture-node" },
      }),
      expect.objectContaining({
        toolName: "mcp__openbot__remember",
        title: "Remember",
        status: "completed",
        inputSummary: '{"note":"likes blue"}',
        input: { note: "likes blue" },
        outputPreview: "remembered: likes blue",
      }),
    ])
  })

  test("E: an interrupted turn finalizes its streaming text as aborted", () => {
    const message = finalItems(replay.events, E).find((i) => i._tag === "Message")
    expect(message).toMatchObject({ text: "wave 1, ", streaming: false, aborted: true })
  })

  test("F: the question turn ends with the answer", () => {
    expect(finalItems(replay.events, F).find((i) => i._tag === "Message")).toMatchObject({ text: "Blue it is." })
  })

  test("usage is reported once per turn from the cumulative totals (no double counting)", () => {
    const usage = ofTag(replay.events, "Usage")
    expect(usage.map((u) => [u.turnId, u.usage.inputTokens, u.usage.outputTokens])).toEqual([
      [A, 10, 5],
      [B, 20, 10],
      [C, 20, 10],
      [D, 20, 10],
      [F, 20, 10],
    ])
    expect(usage.reduce((sum, u) => sum + u.usage.inputTokens, 0)).toBe(90)
    // Usage precedes the terminal event of its turn.
    const usageA = replay.events.findIndex((e) => e._tag === "Usage" && e.turnId === A)
    expect(usageA).toBeLessThan(replay.events.indexOf(terminalOf(replay.events, A)!))
  })

  test("context usage is the last call over the model window", () => {
    expect(replay.normalizer.contextUsage).toEqual({ usedTokens: 15, windowTokens: 258400 })
    expect(ofTag(replay.events, "ContextUsage").at(-1)).toEqual({
      _tag: "ContextUsage",
      usedTokens: 15,
      windowTokens: 258400,
    })
  })

  test("item keys are <nativeTurnId>:<itemId>", () => {
    for (const e of ofTag(replay.events, "ItemUpserted")) expect(e.key).toMatch(/^01a13f6b-[0-9a-f-]+:.+$/)
  })
})

describe("normalizer edge cases", () => {
  const t1 = turnId(1)
  const t2 = turnId(2)

  test("a notification before the turn/start response binds the expected turn", () => {
    const n = new CodexNormalizer()
    n.expectTurn(t1)
    const early = n.handle("turn/started", { turn: { id: "nat-1" } })
    expect(early).toEqual([{ _tag: "TurnStarted", turnId: t1 }])
    expect(n.bindTurn("nat-1", t1)).toEqual([])
    expect(n.nativeTurnOf(t1)).toBe("nat-1")
  })

  test("native turns nobody expected (manual compaction) are internal and report their end", () => {
    const ended: Array<string> = []
    const n = new CodexNormalizer({
      onInternalTurnEnd: (native, outcome) => void ended.push(`${native}:${outcome._tag}`),
    })
    expect(n.handle("turn/started", { turn: { id: "compact-1" } })).toEqual([])
    expect(n.handle("item/completed", { turnId: "compact-1", item: { type: "contextCompaction", id: "c1" } })).toEqual(
      [],
    )
    const usage = n.handle("thread/tokenUsage/updated", {
      turnId: "compact-1",
      tokenUsage: {
        total: { totalTokens: 100, inputTokens: 90, outputTokens: 10 },
        last: { totalTokens: 40, inputTokens: 30, outputTokens: 10 },
        modelContextWindow: 1000,
      },
    })
    expect(usage).toContainEqual({ _tag: "ContextUsage", usedTokens: 40, windowTokens: 1000 })
    expect(n.handle("turn/completed", { turn: { id: "compact-1", status: "completed" } })).toEqual([])
    expect(ended).toEqual(["compact-1:completed"])
    expect(n.activeTurn).toBeUndefined()
  })

  test("a failed turn maps codexErrorInfo; the last error notification fills a missing error", () => {
    const n = new CodexNormalizer()
    n.expectTurn(t1)
    n.handle("turn/started", { turn: { id: "nat-1" } })
    n.handle("error", {
      turnId: "nat-1",
      willRetry: false,
      error: { message: "Out of credits", codexErrorInfo: "usageLimitExceeded" },
    })
    const out = n.handle("turn/completed", { turn: { id: "nat-1", status: "failed", error: null } })
    expect(out.at(-1)).toEqual({
      _tag: "TurnFailed",
      turnId: t1,
      error: { code: "usage-limit", message: "Out of credits", retryable: false },
    })
    expect(turnErrorOf({ message: "x", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } })).toEqual({
      code: "network",
      message: "x",
      retryable: true,
    })
  })

  test("a retrying error shows as activity, not a failure", () => {
    const n = new CodexNormalizer()
    n.expectTurn(t1)
    n.handle("turn/started", { turn: { id: "nat-1" } })
    expect(n.handle("error", { turnId: "nat-1", willRetry: true, error: { message: "reconnecting" } })).toEqual([
      { _tag: "Activity", label: "Reconnecting…" },
    ])
  })

  test("finishTurn closes running tools and is idempotent", () => {
    const n = new CodexNormalizer()
    n.expectTurn(t1)
    n.handle("item/started", {
      turnId: "nat-1",
      item: { type: "commandExecution", id: "exec-1", command: "sleep 100", status: "inProgress" },
    })
    const out = n.finishTurn(t1, {
      _tag: "failed",
      error: { code: "closed", message: "Codex stopped", retryable: true },
    })
    expect(out.find((e) => e._tag === "ItemUpserted")).toMatchObject({
      item: { status: "failed", error: "Codex stopped" },
    })
    expect(out.at(-1)?._tag).toBe("TurnFailed")
    expect(n.finishTurn(t1, { _tag: "completed" })).toEqual([])
    // Late notifications of the ended turn are ignored.
    expect(
      n.handle("item/completed", { turnId: "nat-1", item: { type: "agentMessage", id: "m", text: "late" } }),
    ).toEqual([])
  })

  test("a turn/start folded into a native turn that OpenBot already ended is taken over", () => {
    const n = new CodexNormalizer()
    n.expectTurn(t1)
    n.bindTurn("nat-1", t1)
    n.finishTurn(t1, { _tag: "interrupted" })
    n.expectTurn(t2)
    expect(n.bindTurn("nat-1", t2)).toEqual([{ _tag: "TurnStarted", turnId: t2 }])
    const out = n.handle("turn/completed", { turn: { id: "nat-1", status: "completed" } })
    expect(out.at(-1)).toEqual({ _tag: "TurnCompleted", turnId: t2 })
  })

  test("file changes carry paths and diffs; patch updates refresh them", () => {
    const n = new CodexNormalizer({ hostNodeId: LOCAL_NODE_ID })
    n.expectTurn(t1)
    const started = n.handle("item/started", {
      turnId: "nat-1",
      item: {
        type: "fileChange",
        id: "fc-1",
        status: "inProgress",
        changes: [{ path: "/w/a.txt", kind: { type: "add" }, diff: "+hi" }],
      },
    })
    expect(started.find((e): e is Upsert => e._tag === "ItemUpserted")?.item).toMatchObject({
      toolName: "apply_patch",
      kind: "file-edit",
      title: "Create a.txt",
      fileChanges: [{ path: "/w/a.txt", kind: "add", diff: "+hi" }],
    })
    const info = n.toolInfo("nat-1", "fc-1")
    expect(info?.fileChanges.map((c) => c.path)).toEqual(["/w/a.txt"])
  })

  test("OpenBot node tools carry the node they ran on", () => {
    const n = new CodexNormalizer({ hostNodeId: LOCAL_NODE_ID })
    n.expectTurn(t1)
    const out = n.handle("item/started", {
      turnId: "nat-1",
      item: {
        type: "mcpToolCall",
        id: "m1",
        server: "openbot",
        tool: "shell",
        arguments: { command: "ls -la", node: "nod_2" },
      },
    })
    expect(out.find((e): e is Upsert => e._tag === "ItemUpserted")?.item).toMatchObject({
      kind: "shell",
      inputSummary: "ls -la",
      nodeId: "nod_2",
    })
  })

  test("activity phrases are human: bookkeeping and helpers read as thinking, messaging without 'bot', no tool names", () => {
    const PLUMBING = /\b(task|tasks|subagent|session|spawn|worker|tool|bot|agent|mcp|helper|delegat\w*)\b|_/i
    const labelOf = (item: Record<string, unknown>) => {
      const n = new CodexNormalizer({ hostNodeId: LOCAL_NODE_ID })
      n.expectTurn(t1)
      const out = n.handle("item/started", { turnId: "nat-1", item: { id: "i1", ...item } })
      return out.find((e) => e._tag === "Activity")?.label
    }
    const openbot = (tool: string) => labelOf({ type: "mcpToolCall", server: "openbot", tool, arguments: {} })
    const bookkeeping = [
      "start_task",
      "list_tasks",
      "check_task",
      "cancel_task",
      "remember",
      "forget",
      "recall_memory",
      "list_bots",
      "list_models",
      "create_routine",
      "update_routine",
      "list_routines",
      "list_sections",
      "create_section",
      "move_bot_to_section",
      "save_skill",
      "list_skills",
      "react",
      "create_bot",
      "update_bot",
      "list_nodes",
      "notify_user",
    ]
    for (const tool of bookkeeping) expect(openbot(tool)).toBe(THINKING_ACTIVITY)
    for (const tool of ["message_bot", "handoff_task", "post_to_group"]) expect(openbot(tool)).toBe(MESSAGING_ACTIVITY)
    expect(openbot("shell")).toBe("Running a command")
    expect(openbot("read_file")).toBe("Reading files")
    expect(openbot("browser")).toBe("Using the browser")
    expect(openbot("send_file")).toBe("Sending a file")
    expect(openbot("ask_user")).toBe("Asking you a question")
    expect(labelOf({ type: "mcpToolCall", server: "github", tool: "create_issue", arguments: {} })).toBe(
      CONNECTED_APP_ACTIVITY,
    )
    expect(
      labelOf({ type: "collabAgentToolCall", tool: "spawn_agent", prompt: "look around", status: "inProgress" }),
    ).toBe(THINKING_ACTIVITY)
    expect(labelOf({ type: "dynamicToolCall", tool: "some_tool", arguments: {}, status: "inProgress" })).toBe(
      THINKING_ACTIVITY,
    )
    expect(labelOf({ type: "reasoning", summary: [], content: [] })).toBe(THINKING_ACTIVITY)
    for (const tool of [
      ...bookkeeping,
      "message_bot",
      "handoff_task",
      "post_to_group",
      "send_file",
      "ask_user",
      "shell",
      "grep",
    ]) {
      expect(openbot(tool) ?? "").not.toMatch(PLUMBING)
    }
  })

  test("shell wrappers are stripped for display", () => {
    expect(stripShellWrapper("/usr/bin/bash -lc 'touch a && echo b'")).toBe("touch a && echo b")
    expect(stripShellWrapper(`bash -c "echo \\"x\\""`)).toBe(`echo "x"`)
    expect(stripShellWrapper("ls -la")).toBe("ls -la")
  })
})
