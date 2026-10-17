// Details › Routines (D5.3; grok-bot-ui-activity.md F.9): rows with a clock in the bot color, name,
// schedule (or "Paused") and an Active switch; a row menu (Run now, Edit, Delete); "+" creates one.
// The editor covers cron + timezone, interval (≥ 5 min), once and manual triggers, plus the last runs.
import { routineRunsAtom, routinesAtom } from "@openbot/client"
import {
  type Bot,
  MIN_ROUTINE_INTERVAL_MINUTES,
  type Routine,
  type RoutineOutput,
  type RoutineRun,
  type RoutineSpec,
  type RoutineTriggerInput,
} from "@openbot/contracts"
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  PillButton,
  SegmentedTabs,
  Select,
  Switch,
  TextArea,
  TextField,
  cn,
} from "@openbot/ui"
import { ChevronRight, CircleAlert, CircleCheck, Clock, Ellipsis, LoaderCircle, Pencil, Play, Plus, Trash2 } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { ConfirmDialog, EmptyNote, ErrorLine, LoadingLine, Section, SectionSheet, describeCron, describeTrigger, formatWhen, useCommand, useQuery } from "./kit.tsx"

export function RoutinesSection({ bot }: { readonly bot: Bot }): ReactNode {
  const routines = useQuery(routinesAtom(bot.id))
  const [editing, setEditing] = useState<Routine | "new" | undefined>(undefined)
  const all = [...(routines.value ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  // Finished one-time routines (switched off after their run) fold into a collapsed "Done" group.
  const isDone = (r: Routine) => r.trigger.type === "once" && !r.enabled && r.lastRunAt !== undefined
  const list = all.filter((r) => !isDone(r))
  const done = all.filter(isDone).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
  const [showDone, setShowDone] = useState(false)
  return (
    <Section title="Routines" id="details-routines" trailing={<IconButton icon={Plus} label="New routine" size={24} iconSize="sm" onClick={() => setEditing("new")} data-testid="new-routine" />}>
      {routines.loading ? (
        <LoadingLine />
      ) : routines.error && !routines.value ? (
        <ErrorLine onRetry={routines.refresh}>{routines.error}</ErrorLine>
      ) : all.length === 0 ? (
        <EmptyNote>Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.</EmptyNote>
      ) : (
        <>
          {list.length > 0 && (
            <SectionSheet>
              {list.map((r) => (
                <RoutineRow key={r.id} routine={r} onEdit={() => setEditing(r)} />
              ))}
            </SectionSheet>
          )}
          {done.length > 0 && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs text-fg-tertiary hover:bg-hover hover:text-fg-secondary"
              >
                <ChevronRight size={14} className={showDone ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
                Done ({done.length}) · removed after 7 days
              </button>
              {showDone && (
                <SectionSheet>
                  {done.map((r) => (
                    <RoutineRow key={r.id} routine={r} onEdit={() => setEditing(r)} />
                  ))}
                </SectionSheet>
              )}
            </div>
          )}
        </>
      )}
      {editing && <RoutineDialog bot={bot} routine={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} />}
    </Section>
  )
}

function RoutineRow({ routine, onEdit }: { readonly routine: Routine; readonly onEdit: () => void }): ReactNode {
  const setEnabled = useCommand("routines.setEnabled", routine.id)
  const runNow = useCommand("routines.runNow", routine.id)
  const del = useCommand("routines.delete", routine.id)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [enabled, setLocal] = useState<boolean | undefined>(undefined)
  // optimistic until the refetched routine changes
  const [seen, setSeen] = useState(routine.enabled)
  if (seen !== routine.enabled) {
    setSeen(routine.enabled)
    setLocal(undefined)
  }
  const on = enabled ?? routine.enabled
  return (
    <div role="group" data-automation-row data-testid="routine-row" className="group flex min-h-12 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover">
      <Icon icon={Clock} size="md" className="text-accent" />
      <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 flex-col text-start">
        <span className="truncate text-sm text-fg">{routine.name}</span>
        <span className="truncate text-sm text-fg-secondary">
          {runNow.pending
            ? "Starting…"
            : runNow.error
            ? runNow.error
            : on
            ? describeTrigger(routine.trigger)
            : routine.trigger.type === "once" && routine.lastRunAt !== undefined
            ? `Ran ${formatWhen(routine.lastRunAt).replace(/^[A-Z]/, (c) => c.toLowerCase())}`
            : "Paused"}
        </span>
      </button>
      <Menu
        label="Routine actions"
        align="end"
        trigger={(p) => (
          <button
            {...p}
            type="button"
            aria-label="Routine actions"
            className="inline-flex size-6 items-center justify-center rounded-full text-icon-secondary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary focus-visible:opacity-100 aria-expanded:opacity-100"
          >
            <Icon icon={Ellipsis} size="sm" />
          </button>
        )}
      >
        <MenuItem icon={Play} onSelect={() => void runNow.run({ routineId: routine.id })}>
          Run now
        </MenuItem>
        <MenuItem icon={Pencil} onSelect={onEdit}>
          Edit
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => setConfirmDelete(true)}>
          Delete
        </MenuItem>
      </Menu>
      <Switch
        checked={on}
        label={on ? `Pause ${routine.name}` : `Resume ${routine.name}`}
        onCheckedChange={async (next) => {
          setLocal(next)
          const r = await setEnabled.run({ routineId: routine.id, enabled: next })
          if (!r.ok) setLocal(undefined)
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${routine.name}”?`}
        body="It stops running. Past runs stay in the chat."
        confirmLabel="Delete"
        danger
        pending={del.pending}
        error={del.error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const r = await del.run({ routineId: routine.id })
          if (r.ok) setConfirmDelete(false)
        }}
      />
    </div>
  )
}

// ----------------------------------------------------------------------------------- editor

type TriggerKind = "cron" | "interval" | "once" | "manual"
type Repeat = "daily" | "weekdays" | "weekends" | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "custom"

const REPEAT_OPTIONS: ReadonlyArray<{ value: Repeat; label: string }> = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekends", label: "Weekends" },
  { value: "1", label: "Mondays" },
  { value: "2", label: "Tuesdays" },
  { value: "3", label: "Wednesdays" },
  { value: "4", label: "Thursdays" },
  { value: "5", label: "Fridays" },
  { value: "6", label: "Saturdays" },
  { value: "0", label: "Sundays" },
  { value: "custom", label: "Custom (cron)" },
]

const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Split a simple cron ("M H * * DOW") into the repeat preset + time; anything else is "custom". */
const parseCron = (schedule: string): { repeat: Repeat; time: string } => {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\S+)$/.exec(schedule.trim())
  if (!m) return { repeat: "custom", time: "09:00" }
  const time = `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`
  const dow = m[3]!
  const repeat: Repeat | undefined =
    dow === "*" ? "daily" : dow === "1-5" ? "weekdays" : dow === "0,6" || dow === "6,0" ? "weekends" : /^[0-6]$/.test(dow) ? (dow as Repeat) : undefined
  return repeat ? { repeat, time } : { repeat: "custom", time }
}

const buildCron = (repeat: Repeat, time: string, custom: string): string => {
  if (repeat === "custom") return custom.trim()
  const [h, mi] = time.split(":")
  const hour = Number(h ?? 9)
  const minute = Number(mi ?? 0)
  const dow = repeat === "daily" ? "*" : repeat === "weekdays" ? "1-5" : repeat === "weekends" ? "0,6" : repeat
  return `${minute} ${hour} * * ${dow}`
}

const toLocalInput = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function RoutineDialog({ bot, routine, onClose }: { readonly bot: Bot; readonly routine: Routine | undefined; readonly onClose: () => void }): ReactNode {
  const create = useCommand("routines.create", bot.id)
  const update = useCommand("routines.update", routine?.id ?? "new")
  const runNow = useCommand("routines.runNow", routine?.id ?? "new")
  const del = useCommand("routines.delete", routine?.id ?? "new")
  const t = routine?.trigger
  const parsed = t?.type === "cron" ? parseCron(t.schedule) : { repeat: "weekdays" as Repeat, time: "09:00" }

  const [name, setName] = useState(routine?.name ?? "")
  const [prompt, setPrompt] = useState(routine?.prompt ?? "")
  const [kind, setKind] = useState<TriggerKind>(t && t.type !== "webhook" ? t.type : "cron")
  const [repeat, setRepeat] = useState<Repeat>(parsed.repeat)
  const [time, setTime] = useState(parsed.time)
  const [cron, setCron] = useState(t?.type === "cron" ? t.schedule : "0 9 * * 1-5")
  const [timezone, setTimezone] = useState(t?.type === "cron" ? t.timezone : localZone())
  const [every, setEvery] = useState(String(t?.type === "interval" ? t.everyMinutes : 60))
  const [once, setOnce] = useState(() => toLocalInput(t?.type === "once" ? t.at : Date.now() + 3_600_000))
  const [output, setOutput] = useState<RoutineOutput>(routine?.output ?? "direct")
  const [enabled, setEnabled] = useState(routine?.enabled ?? true)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const schedule = buildCron(repeat, time, cron)
  const trigger = useMemo((): RoutineTriggerInput | string => {
    switch (kind) {
      case "cron":
        if (schedule.split(/\s+/).length !== 5) return "Use a 5-field cron expression, e.g. 0 9 * * 1-5"
        if (!timezone.trim()) return "Choose a timezone"
        return { type: "cron", schedule, timezone: timezone.trim() }
      case "interval": {
        const n = Number(every)
        if (!Number.isInteger(n) || n < MIN_ROUTINE_INTERVAL_MINUTES) return `Run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes`
        return { type: "interval", everyMinutes: n }
      }
      case "once": {
        const at = new Date(once).getTime()
        if (!Number.isFinite(at)) return "Pick a date and time"
        return { type: "once", at }
      }
      case "manual":
        return { type: "manual" }
    }
  }, [kind, schedule, timezone, every, once])

  const invalid = typeof trigger === "string" ? trigger : !name.trim() ? "Give the routine a name" : !prompt.trim() ? "Tell the Bot what to do each run" : undefined
  const error = create.error ?? update.error ?? runNow.error ?? del.error

  const save = async () => {
    if (invalid || typeof trigger === "string") return
    const spec: RoutineSpec = { name: name.trim(), prompt, trigger, enabled, output }
    const r = routine ? await update.run({ routineId: routine.id, spec }) : await create.run({ botId: bot.id, spec })
    if (r.ok) onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={520} label={routine ? "Edit routine" : "New routine"}>
      <DialogHeader title={routine ? "Routine" : "New routine"} description={routine ? undefined : `${bot.name} runs it on its own and posts the result in chat.`} onClose={onClose} />
      <DialogBody className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" data-autofocus data-testid="routine-name" />
        <TextArea label="Instruction" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize what changed overnight and what needs me today." className="text-sm" />
        <div className="flex flex-col gap-2">
          <span className="text-xs text-fg-secondary">When to run</span>
          <SegmentedTabs<TriggerKind>
            variant="track"
            size="sm"
            label="Trigger"
            value={kind}
            onValueChange={setKind}
            tabs={[
              { value: "cron", label: "Schedule" },
              { value: "interval", label: "Interval" },
              { value: "once", label: "Once" },
              { value: "manual", label: "Manual" },
            ]}
          />
          <div className="flex flex-col gap-2 rounded-xl bg-quaternary p-3 hairline border-line-quaternary">
            {kind === "cron" && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Select label="Repeat" value={repeat} options={REPEAT_OPTIONS} onValueChange={setRepeat} align="start" />
                  {repeat !== "custom" && (
                    <input
                      type="time"
                      aria-label="Time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      className="h-7 rounded-lg bg-elevated px-2 text-sm text-fg outline-none hairline border-line-tertiary"
                    />
                  )}
                  <TextField size="sm" aria-label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} wrapperClassName="min-w-[140px] flex-1" />
                </div>
                {repeat === "custom" && <TextField size="sm" aria-label="Cron expression" value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" placeholder="0 9 * * 1-5" />}
                <span className="text-xs text-fg-tertiary">
                  {describeCron(schedule)} · <span className="font-mono">{schedule}</span>
                </span>
              </>
            )}
            {kind === "interval" && (
              <div className="flex items-center gap-2 text-sm text-fg-secondary">
                Every
                <TextField size="sm" aria-label="Minutes" type="number" min={MIN_ROUTINE_INTERVAL_MINUTES} value={every} onChange={(e) => setEvery(e.target.value)} wrapperClassName="w-20" />
                minutes
              </div>
            )}
            {kind === "once" && (
              <input
                type="datetime-local"
                aria-label="Run at"
                value={once}
                onChange={(e) => setOnce(e.target.value)}
                className="h-8 w-fit rounded-lg bg-elevated px-2 text-sm text-fg outline-none hairline border-line-tertiary"
              />
            )}
            {kind === "manual" && <span className="text-sm text-fg-secondary">Runs only when you press Run now.</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm text-fg">Post results</span>
          <Select<RoutineOutput>
            label="Post results"
            value={output}
            onValueChange={setOutput}
            options={[
              { value: "direct", label: `In ${bot.name}'s chat` },
              { value: "own-conversation", label: "In a separate chat per run" },
            ]}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm text-fg">Active</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} label="Active" />
        </div>
        {routine && <RunHistory routineId={routine.id} />}
        {(error ?? (invalid && (name || prompt) ? invalid : undefined)) && <ErrorLine className="px-0">{error ?? invalid}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        {routine && (
          <>
            <IconButton icon={Trash2} label="Delete routine" size={36} variant="secondary" className="me-auto" onClick={() => setConfirmDelete(true)} />
            <PillButton variant="secondary" size="card" leadingIcon={Play} loading={runNow.pending} onClick={() => void runNow.run({ routineId: routine.id })}>
              Run now
            </PillButton>
          </>
        )}
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Cancel
        </PillButton>
        <PillButton variant="primary" size="card" disabled={invalid !== undefined} loading={create.pending || update.pending} onClick={() => void save()} data-testid="save-routine">
          {routine ? "Save" : "Create"}
        </PillButton>
      </DialogFooter>
      {routine && (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete “${routine.name}”?`}
          body="It stops running. Past runs stay in the chat."
          confirmLabel="Delete"
          danger
          pending={del.pending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const r = await del.run({ routineId: routine.id })
            if (r.ok) onClose()
          }}
        />
      )}
    </Dialog>
  )
}

const RUN_ICON: Record<RoutineRun["status"], { icon: typeof Clock; className: string; label: string }> = {
  running: { icon: LoaderCircle, className: "animate-spin text-icon-secondary", label: "Running" },
  succeeded: { icon: CircleCheck, className: "text-success-fg", label: "Done" },
  failed: { icon: CircleAlert, className: "text-danger-fg", label: "Failed" },
  interrupted: { icon: CircleAlert, className: "text-warn-fg", label: "Interrupted" },
  skipped: { icon: CircleAlert, className: "text-icon-tertiary", label: "Skipped" },
}

function RunHistory({ routineId }: { readonly routineId: Routine["id"] }): ReactNode {
  const runs = useQuery(routineRunsAtom(routineId))
  const [all, setAll] = useState(false)
  const list = runs.value ?? []
  const shown = all ? list : list.slice(0, 5)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-fg-secondary">Last runs</span>
      {runs.loading ? (
        <LoadingLine className="justify-start px-0" />
      ) : list.length === 0 ? (
        <span className="text-sm text-fg-tertiary">No runs yet.</span>
      ) : (
        <div className="flex flex-col rounded-xl bg-elevated p-1 hairline border-line-tertiary">
          {shown.map((run) => {
            const s = RUN_ICON[run.status]
            return (
              <div key={run.id} className="flex min-h-8 items-center gap-2 rounded-lg px-2 py-1" title={run.error ?? run.summary}>
                <Icon icon={s.icon} size="sm" className={s.className} label={s.label} />
                <span className="shrink-0 text-sm text-fg">{formatWhen(run.startedAt)}</span>
                <span className={cn("min-w-0 flex-1 truncate text-xs", run.error ? "text-danger-fg" : "text-fg-tertiary")}>
                  {run.error ?? run.summary ?? (run.firedBy === "manual" ? "Run by you" : run.firedBy === "catch-up" ? "Catch-up run" : "")}
                </span>
              </div>
            )
          })}
          {list.length > 5 && (
            <button type="button" className="rounded-lg px-2 py-1 text-start text-xs text-fg-secondary hover:bg-hover" onClick={() => setAll(!all)}>
              {all ? "Show less" : `Show all ${list.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
