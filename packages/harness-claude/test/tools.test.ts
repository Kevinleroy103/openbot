// Owner-visible activity phrases (D6.4, D5.7 product rule): the activity row never shows a tool name
// or plumbing words, whatever tool the bot calls.
import { describe, expect, test } from "bun:test"
import { CONNECTED_APP_ACTIVITY, type HarnessEvent, MESSAGING_ACTIVITY, THINKING_ACTIVITY } from "@openbot/contracts"
import { ClaudeEventPipeline } from "../src/normalize.ts"
import { classifyTool } from "../src/tools.ts"
import { turnId } from "./support.ts"

const PLUMBING = /\b(task|tasks|subagent|session|spawn|worker|tool|bot|agent|mcp|delegat\w*)\b|_/i

const BOOKKEEPING = [
  "start_task",
  "list_tasks",
  "check_task",
  "cancel_task",
  "remember",
  "forget",
  "recall_memory",
  "list_bots",
  "list_models",
  "list_nodes",
  "list_sections",
  "create_section",
  "rename_section",
  "delete_section",
  "move_bot_to_section",
  "create_routine",
  "update_routine",
  "list_routines",
  "save_skill",
  "list_skills",
  "react",
  "create_bot",
  "update_bot",
  "notify_user",
]

describe("activity phrases of tools", () => {
  test("OpenBot's bookkeeping tools read as thinking", () => {
    for (const tool of BOOKKEEPING) expect(classifyTool(`mcp__openbot__${tool}`, {}).activity).toBe(THINKING_ACTIVITY)
  })

  test("messaging a teammate or a group reads as sending a message (no 'bot')", () => {
    for (const tool of ["message_bot", "handoff_task", "post_to_group"]) {
      expect(classifyTool(`mcp__openbot__${tool}`, { to: "Ada", text: "hi" }).activity).toBe(MESSAGING_ACTIVITY)
    }
  })

  test("native helpers and unknown native tools read as thinking; other MCP servers as a connected app", () => {
    expect(classifyTool("Agent", { description: "Explore the repo", prompt: "…" }).activity).toBe(THINKING_ACTIVITY)
    expect(classifyTool("Task", { description: "Research" }).activity).toBe(THINKING_ACTIVITY)
    expect(classifyTool("TaskOutput", { task_id: "x" }).activity).toBe(THINKING_ACTIVITY)
    expect(classifyTool("ToolSearch", { query: "x" }).activity).toBe(THINKING_ACTIVITY)
    expect(classifyTool("mcp__github__create_issue", { title: "x" }).activity).toBe(CONNECTED_APP_ACTIVITY)
  })

  test("the human phrases of real work are kept", () => {
    expect(classifyTool("Bash", { command: "ls" }).activity).toBe("Running a command")
    expect(classifyTool("mcp__openbot__shell", { command: "ls" }).activity).toBe("Running a command")
    expect(classifyTool("mcp__openbot__read_file", { path: "a.md" }).activity).toBe("Reading files")
    expect(classifyTool("WebSearch", { query: "x" }).activity).toBe("Searching the web")
    expect(classifyTool("mcp__openbot__browser", { action: "navigate" }).activity).toBe("Using the browser")
    expect(classifyTool("mcp__openbot__send_file", { paths: ["a.png"] }).activity).toBe("Sending a file")
    expect(classifyTool("mcp__openbot__ask_user", { question: "?" }).activity).toBe("Asking you a question")
  })

  test("no activity phrase carries a tool name or a plumbing word", () => {
    const names = [
      ...BOOKKEEPING.map((t) => `mcp__openbot__${t}`),
      ...["message_bot", "handoff_task", "post_to_group", "send_file", "ask_user", "request_approval", "browser", "computer"].map((t) => `mcp__openbot__${t}`),
      ...["shell", "read_file", "write_file", "edit_file", "list_dir", "glob", "grep"].map((t) => `mcp__openbot__${t}`),
      "mcp__github__create_issue",
      "Agent",
      "Task",
      "TaskOutput",
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "AskUserQuestion",
      "ExitPlanMode",
      "Skill",
    ]
    for (const name of names) expect({ name, activity: classifyTool(name, {}).activity }).not.toMatchObject({ activity: expect.stringMatching(PLUMBING) })
  })

  test("the activity row says Thinking… while the bot starts parallel work (streamed tool call)", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    const events: Array<HarnessEvent> = [...pipeline.send(turnId(1), "u1")]
    events.push(...pipeline.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } }).events)
    events.push(
      ...pipeline.message({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__openbot__start_task", input: {} } },
      }).events,
    )
    const labels = events.flatMap((e) => (e._tag === "Activity" ? [e.label] : []))
    expect(labels).toEqual([THINKING_ACTIVITY])
  })
})
