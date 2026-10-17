// Background task tools (D5.7): start_task / list_tasks / check_task / cancel_task / update_task over the real
// gateway, the task session's reduced toolkit, and a task token's context (origin conversation, no
// current-turn substitution, `taskId` on calls and approvals).
import { afterEach, describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID, type Task, type TaskId } from "@openbot/contracts"
import { BackgroundTasksFake, conversationId, makeTask, makeTurn, OrchestratorFake, turnId } from "@openbot/core/testing"
import type { ExecEvent } from "@openbot/node-protocol"
import { Effect, Stream } from "effect"
import { describeTask, formatSpan } from "../src/toolkits/tasks.ts"
import { BOT_A, type Harness, orchestratorCalls, setNodeClient, startHarness, textOf } from "./harness.ts"

let h: Harness
afterEach(async () => {
  await h?.close()
})

/** Words the model must not pick up from tool results and repeat to the owner. */
const PLUMBING = /\b(task|tasks|background|worker|session|subagent|spawn|tsk_)\b/i

const started = () => h.run(Effect.flatMap(BackgroundTasksFake, (fake) => fake.started))
const putTask = (task: Task, steps?: Parameters<BackgroundTasksFake["Service"]["put"]>[1]) =>
  h.run(Effect.flatMap(BackgroundTasksFake, (fake) => fake.put(task, steps)))

describe("task tools in the bot's main session", () => {
  test("start_task starts in the current conversation and answers in plain words", async () => {
    h = await startHarness()
    // the bot's running turn is in a group: the work's origin is that group
    const group = conversationId("cnv_group")
    await h.run(Effect.flatMap(OrchestratorFake, (fake) => fake.setActiveTurn(BOT_A, makeTurn({ id: turnId("trn_g"), conversationId: group, botId: BOT_A }))))
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["start_task", "list_tasks", "check_task", "cancel_task", "ask_user"]))

    const result = await client.callTool({
      name: "start_task",
      arguments: { title: "HN digest", brief: "Summarize the top 10 Hacker News stories." },
      _meta: { "claudecode/toolUseId": "toolu_t1" },
    })
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('"HN digest"')
    expect(text).not.toMatch(PLUMBING)
    const [first] = await started()
    expect(first?.task.conversationId).toBe(group)
    expect(first?.ctx.turnId).toBe(turnId("trn_g"))
    expect(first?.task.brief).toBe("Summarize the top 10 Hacker News stories.")

    const refused = await client.callTool({ name: "start_task", arguments: { title: "x" } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("brief")
  })

  test("list_tasks, check_task and cancel_task (by title) — only that work stops", async () => {
    h = await startHarness()
    const now = Date.now()
    await putTask(makeTask({ id: "tsk_a" as TaskId, botId: BOT_A, title: "HN digest", status: "running", startedAt: now - 125_000, createdAt: 2, progress: "Reading the front page", stepCount: 4 }), [
      { id: "ent_m" as never, conversationId: conversationId("cnv_x"), revision: 0, createdAt: 1, updatedAt: 1, author: { kind: "bot", botId: BOT_A }, kind: "message", role: "bot", text: "Found 7 stories so far", attachments: [], streaming: true },
    ])
    await putTask(makeTask({ id: "tsk_b" as TaskId, botId: BOT_A, title: "Release notes", status: "running", startedAt: now, createdAt: 1 }))
    await putTask(makeTask({ id: "tsk_c" as TaskId, botId: BOT_A, title: "Old report", status: "succeeded", result: "All green.", endedAt: now - 60_000, createdAt: 0 }))
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)

    const list = textOf(await client.callTool({ name: "list_tasks", arguments: {} }))
    expect(list).toContain('"HN digest" — running for 2 min (latest: Reading the front page)')
    expect(list).toContain('"Old report" — finished 1 min ago')
    expect(list).not.toMatch(PLUMBING)

    const check = textOf(await client.callTool({ name: "check_task", arguments: { task: "hn digest" } }))
    expect(check).toContain("Steps so far: 4.")
    expect(check).toContain("Found 7 stories so far")
    expect(check).not.toMatch(PLUMBING)
    const done = textOf(await client.callTool({ name: "check_task", arguments: { task: "Old report" } }))
    expect(done).toContain("Result:\nAll green.")

    const missing = await client.callTool({ name: "check_task", arguments: { task: "nope" } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('Nothing called "nope"')

    const stopped = textOf(await client.callTool({ name: "cancel_task", arguments: { task: "HN digest" } }))
    expect(stopped).toBe('Stopped "HN digest".')
    const cancelled = await h.run(Effect.flatMap(BackgroundTasksFake, (fake) => fake.cancelled))
    expect(cancelled).toEqual([{ taskId: "tsk_a" as TaskId, by: "bot" }])
    const again = textOf(await client.callTool({ name: "cancel_task", arguments: { task: "Old report" } }))
    expect(again).toContain("already over")
  })

  test("start_task asks for a short brief: the work sees the recent conversation", async () => {
    h = await startHarness()
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const tool = (await client.listTools()).tools.find((t) => t.name === "start_task")!
    expect(tool.description).toContain("sees the recent messages of this conversation")
    expect(tool.description).toContain("keep the brief short")
    expect(tool.description).not.toMatch(/does not see this conversation|must say everything|complete brief/)
    const brief = (tool.inputSchema.properties as Record<string, { description?: string }>).brief?.description ?? ""
    expect(brief).toContain("One to a few sentences")
    expect(brief).not.toMatch(/without this conversation|Everything needed/)
    expect(tool.description).toContain("update_task")
  })

  test("update_task passes a change on to running work; work that is over says so plainly", async () => {
    h = await startHarness()
    const now = Date.now()
    await putTask(makeTask({ id: "tsk_r" as TaskId, botId: BOT_A, title: "Architecture film", status: "running", startedAt: now - 60_000, createdAt: 3 }))
    await putTask(makeTask({ id: "tsk_q" as TaskId, botId: BOT_A, title: "Release notes", status: "queued", createdAt: 2 }))
    await putTask(makeTask({ id: "tsk_d" as TaskId, botId: BOT_A, title: "Old report", status: "succeeded", result: "All green.", endedAt: now - 60_000, createdAt: 1 }))
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const tool = (await client.listTools()).tools.find((t) => t.name === "update_task")
    expect(tool?.description).toContain("instead of waiting for it to finish or starting it again")

    const running = await client.callTool({ name: "update_task", arguments: { task: "architecture film", message: "The globe at the start is off screen; center it." } })
    expect(running.isError).toBeFalsy()
    expect(textOf(running)).toContain('"Architecture film" has your update')
    expect(textOf(running)).not.toMatch(PLUMBING)
    const queued = textOf(await client.callTool({ name: "update_task", arguments: { task: "Release notes", message: "Mention the new sidebar." } }))
    expect(queued).toContain("it will start with your update")
    expect(queued).not.toMatch(PLUMBING)
    const over = await client.callTool({ name: "update_task", arguments: { task: "Old report", message: "Add charts." } })
    expect(over.isError).toBeFalsy()
    expect(textOf(over)).toContain('"Old report" is already over (finished 1 min ago), so it cannot take this update')
    expect(textOf(over)).toContain("start the work again")
    expect(textOf(over)).not.toMatch(PLUMBING)
    const updates = await h.run(Effect.flatMap(BackgroundTasksFake, (fake) => fake.updates))
    expect(updates).toEqual([
      { taskId: "tsk_r" as TaskId, message: "The globe at the start is off screen; center it." },
      { taskId: "tsk_q" as TaskId, message: "Mention the new sidebar." },
    ])
    const missing = await client.callTool({ name: "update_task", arguments: { task: "nope", message: "x" } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('Nothing called "nope"')
  })
})

describe("a task's own session", () => {
  test("offers no task tools and cannot ask the owner; keeps its origin conversation; approvals carry the task", async () => {
    h = await startHarness()
    const origin = conversationId("cnv_origin")
    // the bot's MAIN session is busy elsewhere: a task call must not follow it
    await h.run(Effect.flatMap(OrchestratorFake, (fake) => fake.setActiveTurn(BOT_A, makeTurn({ id: turnId("trn_main"), conversationId: conversationId("cnv_elsewhere"), botId: BOT_A }))))
    const client = await h.connect((await h.issue({
      toolsets: ["bot", "node"],
      conversationId: origin,
      sessionKey: `${BOT_A}:${origin}`,
      taskId: "tsk_42" as TaskId,
    })).binding)
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const hidden of ["start_task", "list_tasks", "check_task", "cancel_task", "update_task", "ask_user", "request_approval"]) {
      expect(names).not.toContain(hidden)
    }
    expect(names).toEqual(expect.arrayContaining(["message_bot", "send_file", "shell", "remember"]))

    await client.callTool({ name: "message_bot", arguments: { to: "Beta", text: "found it" } })
    const call = h.messagingCalls.at(-1)!
    expect(call.claims.conversationId).toBe(origin)
    expect(call.claims.taskId).toBe("tsk_42" as TaskId)

    const execEvents: ReadonlyArray<ExecEvent> = [
      { _tag: "Started", pid: 1, pgid: 1 },
      { _tag: "Exit", code: 0, signal: null, timedOut: false, durationMs: 1 },
    ]
    await setNodeClient(h, LOCAL_NODE_ID, { "shell.exec": () => Stream.fromIterable(execEvents) })
    const shell = await client.callTool({ name: "shell", arguments: { command: "ls" } })
    expect(shell.isError).toBeFalsy()
    expect(await orchestratorCalls(h)).toContain(`approveToolCall:${BOT_A}:shell:tsk_42`)
  })
})

test("formatting helpers", () => {
  expect(formatSpan(12_000)).toBe("12 s")
  expect(formatSpan(3 * 60_000)).toBe("3 min")
  expect(formatSpan(65 * 60_000)).toBe("1 h 5 min")
  const now = 10_000_000
  expect(describeTask(makeTask({ status: "queued" }), now)).toContain("waiting to start")
  expect(describeTask(makeTask({ status: "running", startedAt: now - 5_000, waiting: true }), now)).toContain("waiting for the owner's approval")
  expect(describeTask(makeTask({ status: "failed", error: "boom", endedAt: now }), now)).toContain("could not be finished 0 s ago: boom")
  expect(describeTask(makeTask({ status: "cancelled", stoppedBy: "owner", endedAt: now }), now)).toContain("stopped 0 s ago by the owner")
})
