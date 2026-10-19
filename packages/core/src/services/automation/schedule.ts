/**
 * Routine trigger math (D5.3, architecture §4.3.5): next-run computation with effect `Cron`
 * (timezone-aware, strict "after"), validation and human summaries. Pure; times are epoch millis.
 */
import type { RoutineTrigger } from "@openbot/contracts"
import { MIN_ROUTINE_INTERVAL_MINUTES } from "@openbot/contracts"
import { Cron, Result } from "effect"

/** Catch-up window at boot: a routine due within the last 24 h runs once (§4.3.5). */
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000

/** Parses a 5-field cron expression in an IANA timezone. */
export const parseCron = (schedule: string, timezone: string): Result.Result<Cron.Cron, string> => {
  const fields = schedule.trim().split(/\s+/).filter((s) => s.length > 0)
  if (fields.length !== 5) return Result.fail(`"${schedule}" is not a 5-field cron expression (minute hour day month weekday).`)
  const parsed = Cron.parse(schedule, timezone)
  return Result.isSuccess(parsed) ? Result.succeed(parsed.success) : Result.fail(`Invalid schedule "${schedule}" (${timezone}): ${parsed.failure.message}.`)
}

/** Validation for create/update (returns a model-readable problem or undefined). */
export const validateTrigger = (trigger: RoutineTrigger, now: number): string | undefined => {
  switch (trigger.type) {
    case "cron": {
      const parsed = parseCron(trigger.schedule, trigger.timezone)
      return Result.isFailure(parsed) ? parsed.failure : undefined
    }
    case "interval":
      return Number.isInteger(trigger.everyMinutes) && trigger.everyMinutes >= MIN_ROUTINE_INTERVAL_MINUTES
        ? undefined
        : `The interval must be a whole number of at least ${MIN_ROUTINE_INTERVAL_MINUTES} minutes.`
    case "once":
      return trigger.at > now ? undefined : "The time for a one-time routine must be in the future."
    case "manual":
      return undefined
    case "slack":
      return validateSlackTrigger(trigger)
    case "webhook":
      return "Webhook triggers are not supported yet."
  }
}

const validateSlackTrigger = (trigger: Extract<RoutineTrigger, { type: "slack" }>): string | undefined => {
  if (trigger.on === "phrase" && (trigger.phrase ?? "").trim().length === 0) return "A Slack phrase trigger needs the phrase to look for."
  if (trigger.on === "message" && (trigger.channel ?? "").trim().length === 0) {
    return "A trigger on every Slack message needs a channel."
  }
  return undefined
}

/**
 * The first run strictly after `after`.
 * - cron: `Cron.next` in the trigger's timezone;
 * - interval: `anchor + n × every` for the smallest n ≥ 1 that lands after `after` (`anchor` is
 *   the last run, or when the routine was enabled; a new routine never runs at creation);
 * - once: `at` when it is still ahead (and has not run);
 * - manual / webhook: never.
 */
export const nextRunAfter = (
  trigger: RoutineTrigger,
  after: number,
  options?: { readonly anchor?: number | undefined; readonly ranOnce?: boolean | undefined },
): number | undefined => {
  switch (trigger.type) {
    case "cron": {
      const parsed = parseCron(trigger.schedule, trigger.timezone)
      return Result.isSuccess(parsed) ? Cron.next(parsed.success, new Date(after)).getTime() : undefined
    }
    case "interval": {
      const every = trigger.everyMinutes * 60_000
      if (!(every > 0)) return undefined
      const anchor = options?.anchor ?? after
      if (anchor > after) return anchor
      const n = Math.floor((after - anchor) / every) + 1
      return anchor + n * every
    }
    case "once":
      return options?.ranOnce === true || trigger.at <= after ? undefined : trigger.at
    case "manual":
    case "slack":
    case "webhook":
      return undefined
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

const clock12 = (hour: number, minute: number): string => {
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`
}

const describeCron = (schedule: string, timezone: string): string => {
  const [minute, hour, day, month, weekday] = schedule.trim().split(/\s+/)
  const fixed = (s: string | undefined) => s !== undefined && /^\d+$/.test(s)
  const tz = timezone === "UTC" || timezone === "Etc/UTC" ? " UTC" : ` (${timezone})`
  if (fixed(minute) && fixed(hour) && day === "*" && month === "*") {
    const at = clock12(Number(hour), Number(minute))
    if (weekday === "*") return `Every day at ${at}${tz}`
    if (weekday === "1-5") return `Weekdays at ${at}${tz}`
    if (weekday === "0,6" || weekday === "6,0") return `Weekends at ${at}${tz}`
    if (fixed(weekday) && Number(weekday) <= 7) return `Every ${WEEKDAYS[Number(weekday) % 7]} at ${at}${tz}`
  }
  if (fixed(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*") {
    return `Every hour at :${String(Number(minute)).padStart(2, "0")}`
  }
  return `Cron "${schedule.trim()}"${tz}`
}

const pad = (n: number) => String(n).padStart(2, "0")
const utcStamp = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** Human schedule, e.g. "Weekdays at 9:00 AM (Europe/Berlin)", "Every 2 hours", "Manual only". */
export const describeTrigger = (trigger: RoutineTrigger): string => {
  switch (trigger.type) {
    case "cron":
      return describeCron(trigger.schedule, trigger.timezone)
    case "interval": {
      const m = trigger.everyMinutes
      if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`
      if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`
      return `Every ${m} minutes`
    }
    case "once":
      return `Once at ${utcStamp(trigger.at)}`
    case "manual":
      return "Manual only"
    case "slack":
      return describeSlackTrigger(trigger)
    case "webhook":
      return "Webhook"
  }
}

const describeSlackTrigger = (trigger: Extract<RoutineTrigger, { type: "slack" }>): string => {
  const channel = trigger.channel?.trim()
  const where = channel === undefined || channel.length === 0 ? "" : ` in ${channel}`
  switch (trigger.on) {
    case "dm":
      return `When someone messages you on Slack${where}`
    case "mention":
      return `When you're mentioned on Slack${where}`
    case "phrase":
      return `When a Slack message says “${(trigger.phrase ?? "").trim()}”${where}`
    case "message":
      return `Every Slack message${where}`
  }
}

/** Same trigger (no next-run recomputation needed on update). */
export const sameTrigger = (a: RoutineTrigger, b: RoutineTrigger): boolean => {
  switch (a.type) {
    case "cron":
      return b.type === "cron" && a.schedule.trim() === b.schedule.trim() && a.timezone === b.timezone
    case "interval":
      return b.type === "interval" && a.everyMinutes === b.everyMinutes
    case "once":
      return b.type === "once" && a.at === b.at
    case "slack":
      return b.type === "slack" && a.on === b.on && (a.phrase ?? "").trim() === (b.phrase ?? "").trim() &&
        (a.channel ?? "").trim() === (b.channel ?? "").trim()
    case "manual":
    case "webhook":
      return a.type === b.type
  }
}
