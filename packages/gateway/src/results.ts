/**
 * MCP tool-result rules (mcp-conformance.md R1–R4, D1.6, architecture §4.6):
 *
 * - results carry `content` only (text plus optional images) and NEVER `structuredContent`;
 * - error text reads as an error on its own: it starts with `ERROR:` (Codex direct mode drops `isError`);
 * - text stays under about 10 KB; longer output is spilled to a file on the node by the toolkits and
 *   the path is returned (this module only caps, see `capText`).
 */
import { describeNodeError } from "@openbot/node-protocol"
import { Schema } from "effect"

export interface TextContent {
  readonly type: "text"
  readonly text: string
}

export interface ImageContent {
  readonly type: "image"
  /** Standard base64. */
  readonly data: string
  readonly mimeType: string
}

export type ToolContent = TextContent | ImageContent

/** What a tool handler returns. There is deliberately no `structuredContent` field. */
export interface ToolResult {
  readonly content: ReadonlyArray<ToolContent>
  readonly isError?: boolean | undefined
}

/** The wire shape sent back to the MCP client (a plain object; `structuredContent` is never set). */
export interface WireToolResult {
  [key: string]: unknown
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  isError?: boolean
}

/** Upper bound for the text of one result (R4: "about 10 KB"). */
export const MAX_RESULT_TEXT_BYTES = 10_000

const encoder = new TextEncoder()

export const utf8Length = (text: string): number => encoder.encode(text).length

/** Cuts `text` so its UTF-8 encoding fits in `maxBytes` (never splits a surrogate pair). */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ""
  if (utf8Length(text) <= maxBytes) return text
  let lo = 0
  let hi = Math.min(text.length, maxBytes)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (utf8Length(text.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let end = lo
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** Keeps the last part of `text` whose UTF-8 encoding fits in `maxBytes`. */
export const truncateUtf8Start = (text: string, maxBytes: number): string => {
  if (utf8Length(text) <= maxBytes) return text
  let lo = 0
  let hi = text.length
  // smallest start index whose suffix fits
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (utf8Length(text.slice(mid)) <= maxBytes) hi = mid
    else lo = mid + 1
  }
  let start = lo
  const code = text.charCodeAt(start)
  if (start < text.length && code >= 0xdc00 && code <= 0xdfff) start += 1
  return text.slice(start)
}

export interface CappedText {
  readonly text: string
  readonly truncated: boolean
  readonly originalBytes: number
}

/**
 * Caps `text` at `maxBytes`, keeping the head and the tail (the tail of command output usually
 * matters most) with a marker in between. `note` is appended after the marker (e.g. the spill path).
 */
export const capText = (
  text: string,
  maxBytes: number = MAX_RESULT_TEXT_BYTES,
  note?: string,
): CappedText => {
  const originalBytes = utf8Length(text)
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes }
  const marker = `\n\n[… output truncated: ${originalBytes} bytes in total${note === undefined ? "" : `; ${note}`} …]\n\n`
  const budget = Math.max(0, maxBytes - utf8Length(marker))
  const head = truncateUtf8(text, Math.floor(budget * 0.3))
  const tail = truncateUtf8Start(text, budget - utf8Length(head))
  return { text: `${head}${marker}${tail}`, truncated: true, originalBytes }
}

// ---------------------------------------------------------------------------- constructors

export const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] })

/** Prefixes `ERROR: ` unless the text already starts with it. */
export const errorText = (message: string): string => (message.startsWith("ERROR:") ? message : `ERROR: ${message}`)

/** R2: `isError` plus self-describing `ERROR: …` text; never images or structured content. */
export const errorResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: errorText(message) }],
  isError: true,
})

/** R3: a caption followed by the image. */
export const imageResult = (caption: string, image: { readonly data: string; readonly mimeType: string }): ToolResult => ({
  content: [{ type: "text", text: caption }, { type: "image", data: image.data, mimeType: image.mimeType }],
})

/** Renders lines as a bullet-free list; `empty` when there is nothing to show. */
export const linesResult = (lines: ReadonlyArray<string>, empty: string): ToolResult =>
  textResult(lines.length === 0 ? empty : lines.join("\n"))

/**
 * Last line of defence before a result leaves the gateway: drops anything that is not text or
 * image content (and so any `structuredContent`), caps text, removes images from error results,
 * and makes sure error text starts with `ERROR:`.
 */
export const toWireResult = (result: ToolResult, maxBytes: number = MAX_RESULT_TEXT_BYTES): WireToolResult => {
  const isError = result.isError === true
  const content: WireToolResult["content"] = []
  let budget = maxBytes
  for (const item of result.content) {
    if (item.type === "text") {
      const capped = capText(item.text, Math.max(budget, 256))
      budget = Math.max(0, budget - utf8Length(capped.text))
      content.push({ type: "text", text: capped.text })
    } else if (item.type === "image" && !isError) {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType })
    }
  }
  if (isError) {
    const first = content[0]
    if (first === undefined || first.type !== "text") content.unshift({ type: "text", text: "ERROR: The tool failed." })
    else first.text = errorText(first.text)
    return { content, isError: true }
  }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" })
  return { content }
}

// ---------------------------------------------------------------------------- errors

/** A refusal raised by the gateway itself (bad node, missing capability, denied approval, bad args). */
export class ToolRefusal extends Schema.TaggedError<ToolRefusal>()("ToolRefusal", {
  message: Schema.String,
}) {}

const nodeProtocolTags = new Set([
  "PathDenied",
  "PolicyRefused",
  "EditFailed",
  "FsError",
  "TunnelFailed",
  "StreamRefused",
  "NotAuthenticated",
  "BrowserUnavailable",
  "LeaseHeld",
  "BrowserActionFailed",
])

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

export const INTERNAL_ERROR = "ERROR: Internal error"

/**
 * Model-readable text for any failure a tool handler may produce: contract errors (`NotFound`,
 * `InvalidInput`, `Conflict`, `Forbidden`, `HarnessUnavailable`, `NodeUnavailable`), node-protocol
 * errors (`describeNodeError`), RPC transport errors and gateway refusals. Always starts with `ERROR:`.
 */
export const renderToolError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const e = error as Record<string, unknown> & { readonly _tag: string }
    switch (e._tag) {
      case "ToolRefusal":
      case "InvalidInput":
        return errorText(str(e.message) ?? "Invalid input")
      case "NotFound":
        return errorText(`${str(e.entity) ?? "item"} ${str(e.id) ?? ""} was not found`.replace(/\s+was/, " was"))
      case "Conflict":
      case "Forbidden":
        return errorText(str(e.reason) ?? "The request conflicts with the current state")
      case "Unauthorized":
        return errorText(str(e.reason) ?? "Not authorized")
      case "HarnessUnavailable":
        return errorText(str(e.message) ?? "The harness is unavailable")
      case "Unavailable":
        return errorText(str(e.message) ?? "An outside service did not answer")
      case "RequestNotPending":
        return errorText(`Request ${str(e.requestId) ?? ""} is no longer pending (${str(e.status) ?? "unknown"})`)
      case "NodeUnavailable": {
        // Contract error: `{nodeId, message}` ("Node ‹label› is offline"); node-protocol: `{nodeId, reason}`.
        const message = str(e.message)
        if (message !== undefined && message.length > 0) return errorText(message)
        return errorText(`Node ${str(e.nodeId) ?? ""} is offline${str(e.reason) ? `: ${str(e.reason)}` : ""}`)
      }
      case "RpcClientError":
        return errorText(`The node did not answer: ${str(e.message) ?? "connection error"}`)
      case "DesktopUnavailable": {
        // not covered by describeNodeError: `{message, missing?}`
        const missing = Array.isArray(e.missing) && e.missing.length > 0 ? ` (missing: ${e.missing.join(", ")})` : ""
        return errorText(`${str(e.message) ?? "The desktop is unavailable"}${missing}`)
      }
      case "Internal":
        return INTERNAL_ERROR
      default:
        if (nodeProtocolTags.has(e._tag)) {
          return errorText(describeNodeError(error as Parameters<typeof describeNodeError>[0]))
        }
    }
  }
  return INTERNAL_ERROR
}
