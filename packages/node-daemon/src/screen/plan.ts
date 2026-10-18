// A `computer` action plan (../desktop/actions.ts, planned with `mac: true`) replayed on a Mac: the
// plan's xdotool steps become helper requests (./helper.ts). The planner's checks, messages and
// coordinates (already mapped to screen points) are shared with the X11 desktops.
import type { ActionPlan } from "../desktop/actions.ts"
import type { MacButton, MacOp } from "./helper.ts"
import { flagsOf, macCombo, macKey } from "./macKeys.ts"

export type MacStep = MacOp | { readonly op: "sleep"; readonly ms: number }

export interface MacPlan {
  /** requests in order; `hold` and its release are included */
  readonly steps: ReadonlyArray<MacStep>
  /** a click, scroll or button press comes before any move: start from the real pointer position */
  readonly needsPointer: boolean
  /** keys pressed for the whole plan (released afterwards, even on failure) */
  readonly held: ReadonlyArray<number>
}

const BUTTONS: Readonly<Record<string, MacButton>> = { "1": "left", "2": "middle", "3": "right" }
/** xdotool scroll buttons → wheel direction (positive dy scrolls up, positive dx left) */
const WHEEL: Readonly<Record<string, { readonly dx: number; readonly dy: number }>> = {
  "4": { dx: 0, dy: 1 },
  "5": { dx: 0, dy: -1 },
  "6": { dx: 1, dy: 0 },
  "7": { dx: -1, dy: 0 },
}

/** `["--repeat", "3", "--delay", "80", "1"]` → options and the remaining arguments. */
const options = (args: ReadonlyArray<string>) => {
  const opts: Record<string, string> = {}
  const rest: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--") {
      rest.push(...args.slice(i + 1))
      break
    }
    if (a === "--sync") continue
    if (a.startsWith("--")) {
      opts[a.slice(2)] = args[i + 1] ?? ""
      i++
      continue
    }
    rest.push(a)
  }
  return { opts, rest }
}

/** One xdotool step → helper requests, or an error message for the model. */
const stepOps = (args: ReadonlyArray<string>): ReadonlyArray<MacOp> | string => {
  const [command = "", ...tail] = args
  const { opts, rest } = options(tail)
  switch (command) {
    case "mousemove":
      return [{ op: "move", x: Number(rest[0]), y: Number(rest[1]) }]
    case "click": {
      const count = Number(opts["repeat"] ?? 1)
      const b = rest.at(-1) ?? "1"
      const wheel = WHEEL[b]
      if (wheel) return [{ op: "scroll", dx: wheel.dx * count, dy: wheel.dy * count, unit: "line" }]
      const button = BUTTONS[b]
      return button ? [{ op: "click", button, count }] : `unknown mouse button ${b}`
    }
    case "mousedown":
    case "mouseup": {
      const button = BUTTONS[rest.at(-1) ?? "1"] ?? "left"
      return [{ op: "button", button, down: command === "mousedown" }]
    }
    case "type":
      return [{ op: "type", text: rest.join(" ") }]
    case "key": {
      const ops: Array<MacOp> = []
      for (const combo of rest) {
        const key = macCombo(combo)
        if (key === undefined) return `the key ${combo} does not exist on a Mac`
        ops.push({ op: "key", keyCode: key.keyCode, flags: key.flags })
      }
      return ops
    }
    default:
      return `cannot do "${command}" on a Mac`
  }
}

/** The plan's steps as helper requests (held keys pressed first and released last). */
export const macSteps = (plan: ActionPlan): MacPlan | string => {
  const held: Array<number> = []
  for (const k of plan.hold) {
    const key = macKey(k)
    if (key === undefined) return `the key ${k} does not exist on a Mac`
    held.push(key.keyCode)
  }
  const flags = flagsOf(plan.hold)
  const body: Array<MacStep> = []
  let moved = false
  let needsPointer = false
  for (const step of plan.steps) {
    if (step._tag === "sleep") {
      body.push({ op: "sleep", ms: step.ms })
      continue
    }
    const ops = stepOps(step.args)
    if (typeof ops === "string") return ops
    for (const op of ops) {
      if (op.op === "move") moved = true
      else if ((op.op === "click" || op.op === "scroll" || op.op === "button") && !moved) needsPointer = true
      body.push(op)
    }
  }
  const steps: ReadonlyArray<MacStep> = held.length === 0
    ? body
    : [
      ...held.map((keyCode): MacStep => ({ op: "keyEvent", keyCode, down: true })),
      { op: "hold", flags },
      ...body,
      { op: "hold", flags: 0 },
      ...[...held].reverse().map((keyCode): MacStep => ({ op: "keyEvent", keyCode, down: false })),
    ]
  return { steps, needsPointer, held }
}
