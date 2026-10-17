// Details › Tasks (docs/decisions.md D5.7): the bot's background work. In progress (running, then
// waiting in line) and finished rows: title, status pill, elapsed / ended time and the chat it was
// started from. A row expands to its steps (the chat's Steps rows) and its result; running work has
// a Stop button (the owner's stop: only that work, and the bot is told). Live: the roster carries
// task changes, and the list / details refetch on them.
import { conversationSummariesAtom, rosterTasksAtom, taskDetailAtom, tasksQueryAtom } from "@openbot/client"
import { type Bot, type ConversationSummary, isTerminalTaskStatus, type Task, type TaskId } from "@openbot/contracts"
import { Icon, IconButton, StatusPill, type StatusTone, cn } from "@openbot/ui"
import { Ban, CircleCheck, CircleX, Clock, LoaderCircle, Square } from "lucide-react"
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react"
import { useSelection } from "../app/uiState.ts"
import type { EventEntry, MessageEntry, ReasoningEntry, ToolCallEntry } from "../chat/grouping.ts"
import { Markdown } from "../chat/Markdown.tsx"
import { StepList } from "../chat/Steps.tsx"
import { EmptyNote, ErrorLine, LoadingLine, Section, SectionSheet, formatAgo, useCommand, useQuery, useRosterValue } from "./kit.tsx"

/** "12 s", "3 min", "1 h 5 min". */
export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

const pill = (task: Task): { readonly tone: StatusTone; readonly label: string } => {
  switch (task.status) {
    case "queued":
      return { tone: "neutral", label: "Waiting" }
    case "running":
      return task.waiting === true ? { tone: "warn", label: "Needs you" } : { tone: "accent", label: "Running" }
    case "succeeded":
      return { tone: "success", label: "Done" }
    case "failed":
      return { tone: "danger", label: "Failed" }
    case "cancelled":
      return { tone: "neutral", label: "Stopped" }
  }
}

const statusIcon = (task: Task) =>
  task.status === "running" ? LoaderCircle : task.status === "queued" ? Clock : task.status === "succeeded" ? CircleCheck : task.status === "failed" ? CircleX : Ban

/** The roster's copy wins when it is newer (live progress); the query brings older tasks. */
export const mergeTasks = (listed: ReadonlyArray<Task>, live: ReadonlyArray<Task>): ReadonlyArray<Task> => {
  const byId = new Map<TaskId, Task>()
  for (const t of listed) byId.set(t.id, t)
  for (const t of live) {
    const known = byId.get(t.id)
    if (known === undefined || t.updatedAt >= known.updatedAt) byId.set(t.id, t)
  }
  return [...byId.values()]
}

/** "Running 2 min", "Waiting to start", "Finished 3 min ago · took 2 min". */
export const taskTiming = (task: Task, now: number): string => {
  switch (task.status) {
    case "queued":
      return "Waiting to start"
    case "running":
      return `Running ${formatElapsed(now - (task.startedAt ?? task.createdAt))}`
    default: {
      const ended = task.endedAt ?? task.updatedAt
      const took = task.startedAt === undefined ? "" : ` · took ${formatElapsed(ended - task.startedAt)}`
      return `${task.status === "succeeded" ? "Finished" : task.status === "failed" ? "Failed" : "Stopped"} ${formatAgo(ended, now)}${took}`
    }
  }
}

/** A clock that ticks every second while `active`. */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function TasksTab({ bot }: { readonly bot: Bot }): ReactNode {
  const query = useQuery(tasksQueryAtom(bot.id))
  const live = useRosterValue<ReadonlyArray<Task>>(rosterTasksAtom, [])
  const conversations = useRosterValue<ReadonlyArray<ConversationSummary>>(conversationSummariesAtom, [])
  const tasks = useMemo(() => mergeTasks(query.value ?? [], live.filter((t) => t.botId === bot.id)), [query.value, live, bot.id])
  const running = tasks.filter((t) => t.status === "running").sort((a, b) => a.createdAt - b.createdAt)
  const waiting = tasks.filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt)
  const finished = tasks
    .filter((t) => isTerminalTaskStatus(t.status))
    .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
    .slice(0, 30)
  const now = useNow(running.length > 0 || waiting.length > 0)
  // expanded rows survive a move from "In progress" to "Finished"
  const [expanded, setExpanded] = useState<ReadonlySet<TaskId>>(() => new Set())
  const toggle = (id: TaskId) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const chatName = (task: Task): string | undefined => {
    if (task.conversationId === bot.directConversationId) return "your chat"
    const c = conversations.find((x) => x.id === task.conversationId)
    return c === undefined ? undefined : c.title
  }

  if (query.loading && tasks.length === 0) return <LoadingLine />
  return (
    <div className="flex flex-col gap-6" data-testid="tasks-tab">
      {query.error && !query.value && <ErrorLine onRetry={query.refresh}>{query.error}</ErrorLine>}
      <Section title="In progress">
        {running.length + waiting.length === 0 ? (
          <EmptyNote>Nothing in progress. Longer work {bot.name} takes on shows up here while it keeps chatting with you.</EmptyNote>
        ) : (
          <SectionSheet>
            {[...running, ...waiting].map((t) => (
              <TaskRow key={t.id} task={t} now={now} chat={chatName(t)} open={expanded.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </SectionSheet>
        )}
      </Section>
      {finished.length > 0 && (
        <Section title="Finished">
          <SectionSheet>
            {finished.map((t) => (
              <TaskRow key={t.id} task={t} now={now} chat={chatName(t)} open={expanded.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </SectionSheet>
        </Section>
      )}
    </div>
  )
}

function TaskRow({
  task,
  now,
  chat,
  open,
  onToggle,
}: {
  readonly task: Task
  readonly now: number
  readonly chat: string | undefined
  readonly open: boolean
  readonly onToggle: () => void
}): ReactNode {
  const stop = useCommand("tasks.cancel", task.id)
  const { select } = useSelection()
  const p = pill(task)
  const active = !isTerminalTaskStatus(task.status)
  return (
    <div className={cn("flex flex-col rounded-lg", open && "bg-hover")} data-testid="task-row" data-task={task.id} data-status={task.status}>
      <div className="flex min-h-12 items-center gap-1.5 rounded-lg pe-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          data-testid="task-toggle"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-hover"
        >
          <Icon
            icon={statusIcon(task)}
            size="sm"
            className={cn(
              "shrink-0",
              task.status === "running" ? "animate-spin text-accent-fg" : task.status === "failed" ? "text-danger-fg" : task.status === "succeeded" ? "text-success-fg" : "text-fg-tertiary",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-fg" data-testid="task-title">{task.title}</span>
            <span className="min-w-0 text-xs leading-4 text-fg-tertiary">
              {[...taskTiming(task, now).split(" · "), ...(chat === undefined ? [] : [`in ${chat}`])].map((part, i) => (
                <Fragment key={part}>
                  {i > 0 && " · "}
                  <span className="whitespace-nowrap">{part}</span>
                </Fragment>
              ))}
            </span>
          </span>
          <StatusPill tone={p.tone} dot className="h-[22px] px-2 text-xs">
            {p.label}
          </StatusPill>
        </button>
        {active && (
          <IconButton
            icon={Square}
            label={`Stop ${task.title}`}
            size={28}
            iconSize="sm"
            variant="secondary"
            disabled={stop.pending}
            onClick={() => void stop.run({ taskId: task.id })}
            data-testid="task-stop"
          />
        )}
      </div>
      {open && <TaskDetailView task={task} onOpenChat={chat === undefined ? undefined : () => select(task.conversationId)} />}
      {stop.error && <ErrorLine>{stop.error}</ErrorLine>}
    </div>
  )
}

function TaskDetailView({ task, onOpenChat }: { readonly task: Task; readonly onOpenChat: (() => void) | undefined }): ReactNode {
  const detail = useQuery(taskDetailAtom(task.id))
  const steps = (detail.value?.steps ?? []).flatMap((s): Array<ToolCallEntry | ReasoningEntry> => (s.kind === "tool-call" || s.kind === "reasoning" ? [s] : []))
  const decisions = (detail.value?.steps ?? []).flatMap((s): Array<EventEntry> => (s.kind === "event" ? [s] : []))
  // updates passed on while it runs (`update_task`): the work's input messages
  const updates = (detail.value?.steps ?? []).flatMap((s): Array<MessageEntry> => (s.kind === "message" && s.role === "user" ? [s] : []))
  const latest = detail.value?.task ?? task
  const partial = [...(detail.value?.steps ?? [])].reverse().find((s) => s.kind === "message" && s.role === "bot" && s.text.trim() !== "")
  const [showBrief, setShowBrief] = useState(false)
  return (
    <div className="flex flex-col gap-2.5 px-2 pt-0.5 pb-2.5" data-testid="task-detail">
      {latest.status === "running" && latest.progress && <p className="text-xs text-fg-secondary">{latest.progress}</p>}
      {detail.loading && !detail.value ? (
        <LoadingLine className="py-1" />
      ) : steps.length + decisions.length + updates.length > 0 ? (
        <StepList steps={steps} decisions={decisions} updates={updates} />
      ) : (
        <p className="text-xs text-fg-tertiary">No steps yet.</p>
      )}
      {latest.status === "succeeded" && latest.result && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-fg-tertiary">Result</span>
          <div className="max-h-80 overflow-y-auto rounded-xl bg-elevated px-3 py-2 text-sm scrollbar-thin" data-testid="task-result">
            <Markdown text={latest.result} />
          </div>
        </div>
      )}
      {(latest.status === "failed" || latest.status === "cancelled") && (
        <p className={cn("text-sm", latest.status === "failed" ? "text-danger-fg" : "text-fg-secondary")}>
          {latest.status === "failed" ? `Could not be finished: ${latest.error ?? "unknown error"}` : latest.stoppedBy === "owner" ? "You stopped it." : "Stopped."}
        </p>
      )}
      {latest.status !== "succeeded" && partial?.kind === "message" && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-fg-tertiary">So far</span>
          <div className="max-h-48 overflow-y-auto rounded-xl bg-elevated px-3 py-2 text-sm text-fg-secondary scrollbar-thin">
            <Markdown text={partial.text} />
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" className="text-xs text-fg-tertiary transition-colors hover:text-fg" onClick={() => setShowBrief((v) => !v)}>
          {showBrief ? "Hide the brief" : "Show the brief"}
        </button>
        {onOpenChat && (
          <button type="button" className="text-xs text-fg-tertiary transition-colors hover:text-fg" onClick={onOpenChat}>
            Open the chat
          </button>
        )}
      </div>
      {showBrief && <p className="text-xs whitespace-pre-wrap text-fg-secondary">{latest.brief}</p>}
    </div>
  )
}
