/**
 * BrowserToolkit (D3.2, architecture §4.6): one `browser` tool that drives the bot's own browser
 * window on its HOST node via `browser.action` (CDP on the node, capability `browser@1`).
 *
 * The schema is flat (an `action` enum plus optional fields) rather than a tagged union, so every
 * harness keeps it intact (mcp-conformance.md R5). Screenshots come back as `[caption, image]` (R3).
 * While the user holds the control lease the node refuses with `LeaseHeld`, rendered as
 * "ERROR: The user is controlling the browser".
 */
import type { BrowserAction } from "@openbot/node-protocol"
import { Effect } from "effect"
import * as p from "../params.ts"
import { imageResult, textResult, ToolRefusal } from "../results.ts"
import { type AnyTool, defineTool } from "../tool.ts"
import { fitToResult, type NodeToolkitServices, resolveTarget } from "./node.ts"

export type BrowserToolkitServices = NodeToolkitServices

const actions = ["navigate", "snapshot", "click", "type", "key", "scroll", "screenshot", "tabs"] as const

type Args = {
  readonly action: (typeof actions)[number]
  readonly url?: string | undefined
  readonly ref?: string | undefined
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly text?: string | undefined
  readonly submit?: boolean | undefined
  readonly clear?: boolean | undefined
  readonly key?: string | undefined
  readonly direction?: "up" | "down" | "left" | "right" | undefined
  readonly amount?: number | undefined
  readonly full_page?: boolean | undefined
  readonly tab_op?: "list" | "new" | "select" | "close" | undefined
  readonly tab_id?: string | undefined
}

const need = <A>(value: A | undefined, name: string, action: string): Effect.Effect<A, ToolRefusal> =>
  value === undefined
    ? Effect.fail(new ToolRefusal({ message: `\`${name}\` is required for action ${action}` }))
    : Effect.succeed(value)

const opt = <K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V }

/** Maps the flat tool arguments to a node-protocol `BrowserAction`. */
export const toBrowserAction = (args: Args): Effect.Effect<BrowserAction, ToolRefusal> =>
  Effect.gen(function* () {
    const tab = opt("tabId", args.tab_id)
    switch (args.action) {
      case "navigate":
        return { _tag: "navigate", url: yield* need(args.url, "url", "navigate"), ...tab } as const
      case "snapshot":
        return { _tag: "snapshot", ...tab } as const
      case "click":
        if (args.ref === undefined && (args.x === undefined || args.y === undefined)) {
          return yield* new ToolRefusal({ message: "click needs `ref` (from snapshot) or both `x` and `y`" })
        }
        return { _tag: "click", ...opt("ref", args.ref), ...opt("x", args.x), ...opt("y", args.y), ...tab } as const
      case "type":
        return {
          _tag: "type",
          text: yield* need(args.text, "text", "type"),
          ...opt("ref", args.ref),
          ...opt("submit", args.submit),
          ...opt("clear", args.clear),
          ...tab,
        } as const
      case "key":
        return { _tag: "key", key: yield* need(args.key, "key", "key"), ...tab } as const
      case "scroll":
        return {
          _tag: "scroll",
          direction: args.direction ?? "down",
          ...opt("amount", args.amount),
          ...opt("ref", args.ref),
          ...opt("x", args.x),
          ...opt("y", args.y),
          ...tab,
        } as const
      case "screenshot":
        return { _tag: "screenshot", ...opt("fullPage", args.full_page), ...tab } as const
      case "tabs":
        return { _tag: "tabs", op: args.tab_op ?? "list", ...tab, ...opt("url", args.url) } as const
    }
  })

const browser = defineTool({
  name: "browser",
  toolset: "browser",
  description:
    'Use your own web browser window on your computer (the user can watch it live). Actions: navigate {url}; snapshot (page text with [ref] ids for elements); click {ref | x,y}; type {text, ref?, submit?, clear?}; key {key, e.g. "Enter", "Control+a"}; scroll {direction, amount?}; screenshot {full_page?}; tabs {tab_op: list|new|select|close, tab_id?, url?}. Take a snapshot before clicking or typing to get fresh refs.',
  params: p.params({
    action: p.literals(actions, "What to do."),
    url: p.optional(p.string("URL for navigate (or tabs new).")),
    ref: p.optional(p.string("Element ref from the last snapshot (click, type, scroll).")),
    x: p.optional(p.number("Viewport x in CSS pixels (click/scroll without a ref).")),
    y: p.optional(p.number("Viewport y in CSS pixels (click/scroll without a ref).")),
    text: p.optional(p.string("Text to type.")),
    submit: p.optional(p.boolean("Press Enter after typing.")),
    clear: p.optional(p.boolean("Clear the field before typing.")),
    key: p.optional(p.string("Key or combination for action key.")),
    direction: p.optional(p.literals(["up", "down", "left", "right"], "Scroll direction (default down).")),
    amount: p.optional(p.number("Scroll amount in wheel notches (default 3).", { min: 1, max: 50 })),
    full_page: p.optional(p.boolean("Screenshot the whole page instead of the viewport.")),
    tab_op: p.optional(p.literals(["list", "new", "select", "close"], "Tab operation for action tabs (default list).")),
    tab_id: p.optional(p.string("Tab to act on (default: the active tab).")),
  }),
  annotations: { title: "Browser", destructiveHint: true, openWorldHint: true },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      // The browser always runs on the host node (architecture §4.6).
      const target = yield* resolveTarget(ctx, undefined, "browser")
      const action = yield* toBrowserAction(args)
      yield* ctx.progress(`Browser: ${args.action}`)
      const result = yield* target.client["browser.action"]({ inv: target.inv, action })
      const header = [result.title, result.url].filter((s) => s !== undefined && s !== "").join(" — ")
      const tabs =
        result.tabs === undefined
          ? ""
          : `\nTabs:\n${result.tabs.map((t) => `${t.active ? "*" : " "} ${t.tabId} ${t.title} — ${t.url}`).join("\n")}`
      const text = yield* fitToResult(target, `${header === "" ? "" : `${header}\n`}${result.text}${tabs}`)
      return result.image === undefined
        ? textResult(text)
        : imageResult(text, { data: result.image.data, mimeType: result.image.mimeType })
    }),
})

/** The browser tool (offered when the claims include the `browser` toolset; the node capability is checked per call). */
export const BrowserToolkit: ReadonlyArray<AnyTool<BrowserToolkitServices>> = [browser]
