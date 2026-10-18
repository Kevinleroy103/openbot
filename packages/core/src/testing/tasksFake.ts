/**
 * `BackgroundTasksFake` (D5.7): an in-memory `BackgroundTasks` for tests of its callers (the gateway's
 * task tools, the RPC edge). `start` records a running task; `cancel` stops it; nothing ever runs.
 * The control tag lets a test read what was started and set a task's state.
 */
import type { BotId, Task, TaskId, TranscriptEntry } from "@openbot/contracts"
import { InvalidInput, isTerminalTaskStatus, NotFound } from "@openbot/contracts"
import { Clock, Context, Effect, Layer, Stream } from "effect"
import { BackgroundTasks, type ToolContext } from "../ports/services.ts"

export interface StartedTask {
  readonly ctx: ToolContext
  readonly task: Task
}

export class BackgroundTasksFake extends Context.Service<BackgroundTasksFake, {
  readonly started: Effect.Effect<ReadonlyArray<StartedTask>>
  /** Inserts or replaces a task (and optionally its steps). */
  readonly put: (task: Task, steps?: ReadonlyArray<TranscriptEntry>) => Effect.Effect<void>
  readonly cancelled: Effect.Effect<ReadonlyArray<{ readonly taskId: TaskId; readonly by: string }>>
  /** Updates passed on with `update`, in order. */
  readonly updates: Effect.Effect<ReadonlyArray<{ readonly taskId: TaskId; readonly message: string }>>
}>()("openbot/core/testing/BackgroundTasksFake") {
  static readonly layer = (options?: { readonly maxRunning?: number }): Layer.Layer<BackgroundTasks | BackgroundTasksFake> =>
    Layer.effectContext(
      Effect.sync(() => {
        const tasks = new Map<TaskId, Task>()
        const steps = new Map<TaskId, ReadonlyArray<TranscriptEntry>>()
        const started: Array<StartedTask> = []
        const cancelled: Array<{ readonly taskId: TaskId; readonly by: string }> = []
        const updates: Array<{ readonly taskId: TaskId; readonly message: string }> = []
        let n = 0
        const read = (taskId: TaskId) => {
          const task = tasks.get(taskId)
          return task === undefined ? Effect.fail(new NotFound({ entity: "task", id: taskId })) : Effect.succeed(task)
        }
        const list = (botId: BotId) => [...tasks.values()].filter((t) => t.botId === botId).sort((a, b) => b.createdAt - a.createdAt)
        const service = BackgroundTasks.of({
          start: (ctx, input) =>
            Effect.gen(function*() {
              if (ctx.taskId !== undefined) return yield* new InvalidInput({ message: "Not from a task." })
              if (input.title.trim() === "" || input.brief.trim() === "") return yield* new InvalidInput({ message: "Title and brief are required." })
              const now = yield* Clock.currentTimeMillis
              const running = list(ctx.claims.botId).filter((t) => t.status === "running").length
              const task: Task = {
                id: `tsk_fake${++n}` as TaskId,
                botId: ctx.claims.botId,
                conversationId: ctx.claims.conversationId,
                title: input.title.trim(),
                brief: input.brief.trim(),
                status: running >= (options?.maxRunning ?? 3) ? "queued" : "running",
                createdAt: now + n,
                updatedAt: now + n,
                ...(running >= (options?.maxRunning ?? 3) ? {} : { startedAt: now }),
              }
              tasks.set(task.id, task)
              started.push({ ctx, task })
              return task
            }),
          list: ({ botId, limit }) => Effect.sync(() => list(botId).slice(0, limit ?? 50)),
          get: (taskId) => Effect.map(read(taskId), (task) => ({ task, steps: steps.get(taskId) ?? [] })),
          find: (botId, ref) =>
            Effect.suspend(() => {
              const key = ref.trim().toLowerCase()
              const found = list(botId).find((t) => t.id === ref.trim() || t.title.toLowerCase() === key)
              return found === undefined ? Effect.fail(new NotFound({ entity: "task", id: ref })) : Effect.succeed(found)
            }),
          cancel: (taskId, by) =>
            Effect.gen(function*() {
              const task = yield* read(taskId)
              if (isTerminalTaskStatus(task.status)) return task
              cancelled.push({ taskId, by })
              const now = yield* Clock.currentTimeMillis
              const next: Task = { ...task, status: "cancelled", stoppedBy: by, endedAt: now, updatedAt: now }
              tasks.set(taskId, next)
              return next
            }),
          update: (ctx, input) =>
            Effect.gen(function*() {
              if (ctx.taskId !== undefined) return yield* new InvalidInput({ message: "Not from a task." })
              if (input.message.trim() === "") return yield* new InvalidInput({ message: "The update is empty." })
              const task = yield* read(input.taskId)
              if (task.botId !== ctx.claims.botId) return yield* new NotFound({ entity: "task", id: input.taskId })
              if (isTerminalTaskStatus(task.status)) return { task, delivery: "finished" as const }
              updates.push({ taskId: task.id, message: input.message.trim() })
              return { task, delivery: task.status === "running" ? ("steered" as const) : ("queued" as const) }
            }),
          removeBot: (botId) => Effect.sync(() => {
            for (const t of list(botId)) tasks.delete(t.id)
          }),
          cancelForConversation: () => Effect.void,
          approve: () => Effect.succeed({ decision: "allow-once" }),
          results: Stream.never,
          recover: () => Effect.void,
          hold: Effect.void,
          running: Effect.sync(() => [...tasks.values()].filter((t) => t.status === "running").length),
        })
        return Context.make(BackgroundTasks, service).pipe(
          Context.add(BackgroundTasksFake, BackgroundTasksFake.of({
            started: Effect.sync(() => [...started]),
            put: (task, taskSteps) => Effect.sync(() => {
              tasks.set(task.id, task)
              if (taskSteps !== undefined) steps.set(task.id, taskSteps)
            }),
            cancelled: Effect.sync(() => [...cancelled]),
            updates: Effect.sync(() => [...updates]),
          })),
        )
      }),
    )
}
