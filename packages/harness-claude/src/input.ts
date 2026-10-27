/**
 * `TurnInput` → SDK streaming-input user message (sdk-claude.md §4, §17).
 *
 * Images (png/jpeg/gif/webp) are inlined as base64 blocks **before** the text. Every attachment's
 * on-disk path is also appended to the text, because the model's tools cannot dereference inlined
 * pixels (t3code `makeClaudeUserMessageWithAttachments`); the attachments directory is granted via
 * `additionalDirectories`.
 *
 * Turn text that starts with `/` is sent with `client_composed: true` so the CLI delivers it as
 * written instead of dispatching a Claude Code slash command (`/clear`, `/login`, …) that OpenBot
 * cannot see; OpenBot's own commands (compact) use `commandMessage`. Other text keeps the CLI's
 * normal turn-start context (skill listings, reminders), which `client_composed` would drop
 * (sdk-claude.md §4). The owner's `/name` skill command is sent as the CLI's own
 * `/openbot-skills:name` command, so skills marked `disable-model-invocation` start too.
 */
import type { TurnInput } from "@openbot/core"
import { SKILLS_PLUGIN_NAME } from "./skillsPlugin.ts"

export const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** Max bytes of one inlined image (the API rejects much larger images anyway). */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024

export type ReadFile = (path: string) => Promise<Uint8Array>

export const bunReadFile: ReadFile = async (path) => new Uint8Array(await Bun.file(path).arrayBuffer())

/** SDK `SDKUserMessage`, structurally. */
export interface ClaudeUserMessage {
  readonly type: "user"
  readonly message: { readonly role: "user"; readonly content: string | ReadonlyArray<Record<string, unknown>> }
  readonly parent_tool_use_id: null
  readonly uuid: string
  readonly priority?: "now" | "next" | "later"
  readonly client_composed?: true
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

/** The turn's text; the owner's skill command as the CLI's command for the Bot's skills plugin. */
const turnText = (input: TurnInput): string =>
  input.skillCommand === undefined
    ? input.text
    : `/${SKILLS_PLUGIN_NAME}:${input.skillCommand.name} ${input.skillCommand.args}`.trimEnd()

export const textWithAttachmentPaths = (input: TurnInput): string => {
  const text = turnText(input)
  if (input.attachments.length === 0) return text
  const lines = input.attachments.map((a) => `- ${a.name} (${a.mime}): ${a.path}`)
  const header = text.length > 0 ? `${text}\n\n` : ""
  return `${header}Attached files:\n${lines.join("\n")}`
}

/** True when the CLI would treat the text as a slash command. */
export const looksLikeSlashCommand = (text: string): boolean => text.trimStart().startsWith("/")

/** Builds the user message; unreadable or oversized images are referenced by path only. */
export const toUserMessage = async (
  input: TurnInput,
  options: { readonly uuid: string; readonly priority?: "now" | "next" | "later"; readonly readFile: ReadFile },
): Promise<ClaudeUserMessage> => {
  const text = textWithAttachmentPaths(input)
  const base = {
    type: "user" as const,
    parent_tool_use_id: null,
    uuid: options.uuid,
    ...(options.priority ? { priority: options.priority } : {}),
    ...(input.skillCommand === undefined && looksLikeSlashCommand(input.text)
      ? { client_composed: true as const }
      : {}),
  }
  const images: Array<Record<string, unknown>> = []
  for (const attachment of input.attachments) {
    if (!SUPPORTED_IMAGE_MIME.has(attachment.mime)) continue
    try {
      const bytes = await options.readFile(attachment.path)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) continue
      images.push({ type: "image", source: { type: "base64", media_type: attachment.mime, data: toBase64(bytes) } })
    } catch {
      // Referenced by path in the text; the model can still read it with its tools.
    }
  }
  if (images.length === 0) return { ...base, message: { role: "user", content: text } }
  return {
    ...base,
    message: { role: "user", content: [...images, ...(text.length > 0 ? [{ type: "text", text }] : [])] },
  }
}

/** A slash command (e.g. `/compact`) as streaming input. */
export const commandMessage = (command: string, uuid: string): ClaudeUserMessage => ({
  type: "user",
  message: { role: "user", content: command },
  parent_tool_use_id: null,
  uuid,
})
