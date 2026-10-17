/**
 * ComputerToolkit (D1.7, architecture §4.6; remote-computer-control.md §7): the bot's own screen.
 *
 * - `computer` (toolset `computer`, offered when the host node has `desktop@1`): one tool with
 *   Anthropic's computer-use action names, mapped 1:1 to the node's `computer.act`. The schema is flat
 *   (an `action` enum plus optional fields; `coordinate` / `start_coordinate` / `region` are arrays of
 *   numbers, never tuples: R5). Coordinates are in the screenshot's 1280-wide API space; the node
 *   scales them to the screen. Results are text plus an MCP image (R3), never `structuredContent`.
 *   While the owner holds the screen (lease) the node refuses with `LeaseHeld`.
 * - `request_takeover` (toolset `bot`, offered with a screen: `computer` or `browser`, never to a
 *   background task): an async "Action needed" hand-off card (`ApprovalService.requestTakeover`);
 *   returns pending at once and the owner's "done" / "skip" arrives later as a message.
 */
import { ApprovalService } from "@openbot/core"
import { type ComputerAction, ComputerActionName } from "@openbot/node-protocol"
import { Effect } from "effect"
import * as p from "../params.ts"
import { errorResult, imageResult, textResult, ToolRefusal } from "../results.ts"
import { type AnyTool, defineTool, type ToolAvailability } from "../tool.ts"
import { PENDING_HINT } from "./bot.ts"
import { type NodeToolkitServices, resolveTarget } from "./node.ts"
import { notInTask } from "./tasks.ts"

export type ComputerToolkitServices = NodeToolkitServices | ApprovalService

/** Model-readable text of the computer tool's refusals (owner in control, no desktop). */
export const OWNER_HAS_SCREEN = "The owner is using your screen right now. Wait until they hand it back."

const MAX_WAIT_SECONDS = 60

type Args = {
  readonly action: ComputerActionName
  readonly coordinate?: ReadonlyArray<number> | undefined
  readonly start_coordinate?: ReadonlyArray<number> | undefined
  readonly region?: ReadonlyArray<number> | undefined
  readonly text?: string | undefined
  readonly scroll_direction?: "up" | "down" | "left" | "right" | undefined
  readonly scroll_amount?: number | undefined
  readonly duration?: number | undefined
}

const refuse = (message: string) => Effect.fail(new ToolRefusal({ message }))

const need = <A>(value: A | undefined, name: string, action: string): Effect.Effect<A, ToolRefusal> =>
  value === undefined ? refuse(`\`${name}\` is required for action ${action}`) : Effect.succeed(value)

const opt = <K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V }

/** Maps the flat tool arguments to a node-protocol `ComputerAction` (per-action required fields). */
export const toComputerAction = (args: Args): Effect.Effect<ComputerAction, ToolRefusal> =>
  Effect.gen(function*() {
    const action = args.action
    const coordinate = opt("coordinate", args.coordinate)
    switch (action) {
      case "screenshot":
      case "cursor_position":
        return { action }
      case "zoom":
        return { action, region: yield* need(args.region, "region", action) }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click":
        // `text`: modifier keys held during the click ("shift", "ctrl")
        return { action, ...coordinate, ...opt("text", args.text) }
      case "left_mouse_down":
      case "left_mouse_up":
        return { action, ...coordinate }
      case "mouse_move":
        return { action, coordinate: yield* need(args.coordinate, "coordinate", action) }
      case "left_click_drag":
        return {
          action,
          start_coordinate: yield* need(args.start_coordinate, "start_coordinate", action),
          coordinate: yield* need(args.coordinate, "coordinate", action),
        }
      case "scroll":
        return {
          action,
          ...coordinate,
          scroll_direction: yield* need(args.scroll_direction, "scroll_direction", action),
          scroll_amount: args.scroll_amount ?? 3,
          ...opt("text", args.text),
        }
      case "type":
      case "key":
        return { action, text: yield* need(args.text, "text", action) }
      case "hold_key":
        return { action, text: yield* need(args.text, "text", action), duration: yield* need(args.duration, "duration", action) }
      case "wait":
        return { action, duration: args.duration ?? 1 }
    }
  })

/** The node's refusals in the bot's terms; anything else goes to the generic renderer. */
const explain = (error: unknown): Effect.Effect<never, unknown> => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const e = error as { readonly _tag: string; readonly message?: unknown; readonly missing?: ReadonlyArray<string> | undefined }
    if (e._tag === "LeaseHeld") return refuse(OWNER_HAS_SCREEN)
    if (e._tag === "DesktopUnavailable") {
      const message = typeof e.message === "string" && e.message.trim() !== "" ? e.message.trim() : "Your screen is not available"
      const missing = e.missing !== undefined && e.missing.length > 0 ? ` This computer lacks: ${e.missing.join(", ")}.` : ""
      return refuse(`${message.replace(/[.!?]?$/, ".")}${missing}`)
    }
  }
  return Effect.fail(error)
}

const point = (description: string) => p.optional(p.array(p.number(), description, { minItems: 2, maxItems: 2 }))

const computer = defineTool({
  name: "computer",
  toolset: "computer",
  description: [
    "Look at and work your own screen: a whole desktop with a browser, a terminal, files and an editor (the owner can watch it live).",
    "Screenshots are 1280 pixels wide and every coordinate is in that screenshot's pixels.",
    "Take a screenshot first, and again whenever you need to see what happened.",
    "Prefer the `browser` tool for web pages; use `computer` for everything else (desktop apps, file dialogs, windows, terminal GUIs).",
    "Actions: screenshot; zoom {region: [x0, y0, x1, y1]} (a closer look; coordinates stay in full-screenshot space);",
    "left_click, right_click, middle_click, double_click, triple_click {coordinate?: [x, y], text?: keys held, e.g. \"shift\"};",
    "mouse_move {coordinate}; left_click_drag {start_coordinate, coordinate}; left_mouse_down, left_mouse_up {coordinate?};",
    "scroll {scroll_direction, scroll_amount?, coordinate?}; type {text}; key {text: a key or combination, e.g. \"Return\", \"ctrl+s\"};",
    "hold_key {text, duration}; wait {duration}; cursor_position.",
  ].join(" "),
  params: p.params({
    action: p.literals(ComputerActionName.literals, "What to do."),
    coordinate: point("[x, y] in screenshot pixels: where to click, move, scroll or drag to."),
    start_coordinate: point("[x, y] in screenshot pixels where a left_click_drag starts."),
    region: p.optional(p.array(p.number(), "[x0, y0, x1, y1] in screenshot pixels for zoom.", { minItems: 4, maxItems: 4 })),
    text: p.optional(p.string("Text to type; the key or combination for key / hold_key; keys held during a click or scroll.")),
    scroll_direction: p.optional(p.literals(["up", "down", "left", "right"], "Scroll direction.")),
    scroll_amount: p.optional(p.number("Scroll amount in wheel notches (default 3).", { integer: true, min: 1, max: 30 })),
    duration: p.optional(p.number(`Seconds to wait or hold a key (max ${MAX_WAIT_SECONDS}).`, { min: 0, max: MAX_WAIT_SECONDS })),
  }),
  annotations: { title: "Computer", destructiveHint: true, openWorldHint: true },
  handler: (args, ctx) =>
    Effect.gen(function*() {
      // the screen is always the host node's (architecture §4.6)
      const target = yield* resolveTarget(ctx, undefined, "desktop")
      const action = yield* toComputerAction(args)
      yield* ctx.progress(`Computer: ${args.action}`)
      const result = yield* target.client["computer.act"]({ inv: target.inv, action }).pipe(Effect.catch(explain))
      const text = result.text === "" ? `Done: ${args.action}.` : result.text
      // the node answers bad arguments as text ("ERROR: coordinate [x, y] is required")
      if (result.image === undefined && text.startsWith("ERROR:")) return errorResult(text)
      return result.image === undefined
        ? textResult(text)
        : imageResult(text, { data: result.image.data, mimeType: result.image.mimeType })
    }),
})

/** Offered to a bot with a screen (a desktop or a browser window), never to its background tasks. */
export const hasScreen = (input: ToolAvailability): boolean =>
  notInTask(input) && (input.claims.toolsets.includes("computer") || input.claims.toolsets.includes("browser"))

const requestTakeover = defineTool({
  name: "request_takeover",
  toolset: "bot",
  description:
    "Ask the owner to take over your screen for something you must not or cannot do yourself: signing in, a password, a 2FA or verification code, a CAPTCHA, a payment or another personal confirmation. Bring it up on your screen first. Returns immediately with status pending: the owner gets an Action needed card, takes over your screen and hands it back; their answer (done or skipped) arrives later as a new message. End your turn after calling it.",
  params: p.params({
    instruction: p.text(
      "What the owner should do on your screen, in one or two sentences (e.g. \"Sign in to GitHub and approve the 2FA prompt\").",
    ),
  }),
  annotations: { title: "Ask the owner to take over", destructiveHint: false, openWorldHint: false },
  available: hasScreen,
  handler: (args, ctx) =>
    Effect.gen(function*() {
      const receipt = yield* (yield* ApprovalService).requestTakeover(ctx.tool, { instruction: args.instruction })
      return textResult(`status: pending\nrequestId: ${receipt.requestId}\n${PENDING_HINT}`)
    }),
})

/** The screen tools. */
export const ComputerToolkit: ReadonlyArray<AnyTool<ComputerToolkitServices>> = [computer, requestTakeover]
