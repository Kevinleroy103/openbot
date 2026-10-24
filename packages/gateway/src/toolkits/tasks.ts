/**
 * TaskToolkit (docs/decisions.md D5.7): background work a bot runs in parallel while it stays free
 * to chat. `start_task` → `BackgroundTasks.start` · `list_tasks` → `BackgroundTasks.list` ·
 * `check_task` → `BackgroundTasks.find` · `cancel_task` → `BackgroundTasks.find` + `cancel` ·
 * `update_task` → `BackgroundTasks.find` + `update`.
 *
 * Not offered in a task's own session (`claims.taskId`): a task does its work itself.
 *
 * Results are plain content the model can act on. They avoid plumbing words ("task", "worker",
 * "session", ids) the model could repeat to the owner; descriptions explain the mechanism to the
 * model and state the rule, never example phrases.
 */
import { isTerminalTaskStatus, type Task, TASK_BRIEF_MAX_CHARS, TASK_TITLE_MAX_CHARS } from "@openbot/contracts"
import { BackgroundTasks, type ToolContext } from "@openbot/core"
import { Clock, Effect } from "effect"
import * as p from "../params.ts"
import { linesResult, textResult, ToolRefusal } from "../results.ts"
import { type AnyTool, defineTool, type ToolAvailability } from "../tool.ts"

export type TaskToolkitServices = BackgroundTasks

/** Task tools (and asking the owner) are not offered inside a task's own session. */
export const notInTask = ({ claims }: ToolAvailability): boolean => claims.taskId === undefined

/** "12 s", "3 min", "1 h 5 min". */
export const formatSpan = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

const quoted = (title: string) => `"${title}"`

const capChars = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** One line per task: title, state, time. */
export const describeTask = (task: Task, now: number): string => {
  const title = quoted(task.title)
  switch (task.status) {
    case "queued":
      return `${title} — waiting to start (others are still running)`
    case "running": {
      const since = formatSpan(now - (task.startedAt ?? task.createdAt))
      const latest = task.waiting === true ? "waiting for the owner's approval" : task.progress
      return `${title} — running for ${since}${latest === undefined ? "" : ` (latest: ${latest})`}`
    }
    case "succeeded":
      return `${title} — finished ${formatSpan(now - (task.endedAt ?? task.updatedAt))} ago`
    case "failed":
      return `${title} — could not be finished ${formatSpan(now - (task.endedAt ?? task.updatedAt))} ago: ${task.error ?? "unknown error"}`
    case "cancelled":
      return `${title} — stopped ${formatSpan(now - (task.endedAt ?? task.updatedAt))} ago${task.stoppedBy === "owner" ? " by the owner" : ""}`
  }
}

/** The bot's task named `ref`, or a refusal that lists what there is. */
const findTask = (ctx: ToolContext, ref: string) =>
  Effect.gen(function* () {
    const tasks = yield* BackgroundTasks
    return yield* tasks.find(ctx.claims.botId, ref).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.gen(function* () {
          const recent = yield* tasks.list({ botId: ctx.claims.botId, limit: 10 })
          const titles = recent.map((t) => quoted(t.title)).join(", ")
          return yield* new ToolRefusal({
            message: `Nothing called ${quoted(ref.trim())} is running or recently finished.${titles === "" ? "" : ` Recent work: ${titles}.`}`,
          })
        }),
      ),
    )
  })

const startTask = defineTool({
  name: "start_task",
  toolset: "bot",
  description:
    'Start a piece of work that runs in parallel, so you stay available to the owner and your team while it runs. Use it for work likely to take more than about a minute or many tool steps (research, long builds, processing many files); quick things you just do directly. The work runs with your tools, files and memory and sees the recent messages of this conversation, so keep the brief short: one to a few sentences saying what to do and what done looks like, plus only what the recent messages do not already say. Returns at once. The result comes back to you later in this conversation as a message whose first line is [Result of "<title>"]; then tell the owner what came out of it in your own words. While it runs, pass the owner\'s feedback or changes on to it with update_task instead of waiting for it to finish or starting it over. Whenever you tell the owner about it, talk about the work itself, never about how it is run.',
  params: p.params({
    title: p.string(`A short name for the work (at most ${TASK_TITLE_MAX_CHARS} characters).`, {
      minLength: 1,
      maxLength: TASK_TITLE_MAX_CHARS,
    }),
    brief: p.string(
      "One to a few sentences: what to do and what done looks like. The work already sees the recent messages of this conversation, your files and your memory; add only what they do not say.",
      { minLength: 1, maxLength: TASK_BRIEF_MAX_CHARS },
    ),
  }),
  annotations: { title: "Start parallel work", destructiveHint: false, openWorldHint: false },
  available: notInTask,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const task = yield* (yield* BackgroundTasks).start(ctx.tool, { title: args.title, brief: args.brief })
      // Plain content, then the rule (no example phrase): the model replies right after reading this.
      const rule = "If you reply now, talk about the work itself, not about how it is run."
      return textResult(
        task.status === "queued"
          ? `${quoted(task.title)} starts as soon as some of your other work finishes. Its result will come back to you here as a message when it is done. ${rule}`
          : `${quoted(task.title)} is underway. Its result will come back to you here as a message when it is done. ${rule}`,
      )
    }),
})

const listTasks = defineTool({
  name: "list_tasks",
  toolset: "bot",
  description:
    "List your work running in parallel and what finished recently: title, state and how long it has been running.",
  params: p.params({}),
  annotations: { title: "List parallel work", readOnlyHint: true, openWorldHint: false },
  available: notInTask,
  idempotent: false,
  handler: (_args, ctx) =>
    Effect.gen(function* () {
      const tasks = yield* (yield* BackgroundTasks).list({ botId: ctx.claims.botId, limit: 20 })
      const now = yield* Clock.currentTimeMillis
      return linesResult(
        tasks.map((t) => describeTask(t, now)),
        "Nothing is running and nothing finished recently.",
      )
    }),
})

const checkTask = defineTool({
  name: "check_task",
  toolset: "bot",
  description:
    "Check one piece of your parallel work: its state, the latest progress and what it has produced so far (or its result when it is done). `task` is its title.",
  params: p.params({ task: p.text("The title of the work (or its id).") }),
  annotations: { title: "Check parallel work", readOnlyHint: true, openWorldHint: false },
  available: notInTask,
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const found = yield* findTask(ctx.tool, args.task)
      const detail = yield* (yield* BackgroundTasks).get(found.id)
      const task = detail.task
      const now = yield* Clock.currentTimeMillis
      const lines = [describeTask(task, now)]
      if (task.stepCount !== undefined && task.stepCount > 0) lines.push(`Steps so far: ${task.stepCount}.`)
      if (task.status === "succeeded") {
        lines.push(`Result:\n${capChars(task.result ?? "(no written result)", 6_000)}`)
      } else {
        const partial = [...detail.steps]
          .reverse()
          .find((s) => s.kind === "message" && s.role === "bot" && s.text.trim() !== "")
        if (partial !== undefined && partial.kind === "message")
          lines.push(`What it has so far:\n${capChars(partial.text.trim(), 3_000)}`)
      }
      if (!isTerminalTaskStatus(task.status))
        lines.push("Its result will come back to you as a message when it is done.")
      return textResult(lines.join("\n"))
    }),
})

const cancelTask = defineTool({
  name: "cancel_task",
  toolset: "bot",
  description:
    "Stop one piece of your parallel work, by title. Only that work stops; your conversations and your other work continue.",
  params: p.params({ task: p.text("The title of the work to stop (or its id).") }),
  annotations: { title: "Stop parallel work", destructiveHint: true, openWorldHint: false },
  available: notInTask,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const found = yield* findTask(ctx.tool, args.task)
      if (isTerminalTaskStatus(found.status)) {
        return textResult(`${quoted(found.title)} is already over; there is nothing to stop.`)
      }
      const task = yield* (yield* BackgroundTasks).cancel(found.id, "bot")
      return textResult(
        isTerminalTaskStatus(task.status) ? `Stopped ${quoted(task.title)}.` : `${quoted(task.title)} is stopping.`,
      )
    }),
})

const updateTask = defineTool({
  name: "update_task",
  toolset: "bot",
  description:
    "Pass feedback, corrections or changes on to a piece of your parallel work that is still running: it takes them into account in the work in progress, without starting over. Use it whenever the owner's new input concerns work that is running, instead of waiting for it to finish or starting it again. If the work is already over you are told so; then start it again with the change if it is still needed. `task` is its title. Whenever you tell the owner about it, talk about the change itself, never about how it is passed on.",
  params: p.params({
    task: p.text("The title of the work (or its id)."),
    message: p.string(
      "What to change or take into account, in a few sentences; the work does not see messages that came after it started, so include what it needs.",
      { minLength: 1, maxLength: TASK_BRIEF_MAX_CHARS },
    ),
  }),
  annotations: { title: "Update parallel work", destructiveHint: false, openWorldHint: false },
  available: notInTask,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const found = yield* findTask(ctx.tool, args.task)
      const { task, delivery } = yield* (yield* BackgroundTasks).update(ctx.tool, {
        taskId: found.id,
        message: args.message,
      })
      const rule = "If you reply now, talk about the change itself, not about how it is passed on."
      switch (delivery) {
        case "steered":
          return textResult(
            `${quoted(task.title)} has your update and is taking it into account now. Its result will come back to you here when it is done. ${rule}`,
          )
        case "queued":
          return textResult(
            task.status === "queued"
              ? `${quoted(task.title)} has not started yet; it will start with your update. ${rule}`
              : `${quoted(task.title)} will take your update right after what it is doing now, and goes on from there with it. Its result will come back to you here when it is done. ${rule}`,
          )
        case "finished": {
          const now = yield* Clock.currentTimeMillis
          const how = isTerminalTaskStatus(task.status)
            ? ` (${describeTask(task, now).slice(quoted(task.title).length + 3)})`
            : ""
          return textResult(
            `${quoted(task.title)} is already over${how}, so it cannot take this update. If the change is still needed, start the work again with it.`,
          )
        }
      }
    }),
})

/** Every task tool. */
export const TaskToolkit: ReadonlyArray<AnyTool<TaskToolkitServices>> = [
  startTask,
  listTasks,
  checkTask,
  cancelTask,
  updateTask,
]
