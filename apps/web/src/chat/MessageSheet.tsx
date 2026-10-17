// Long-press on a message bubble (touch): the hover actions of Message.tsx as a bottom sheet — quick
// reactions, Reply, Copy, Copy message ID.
import { Copy, Hash, Reply } from "lucide-react"
import type { ReactNode } from "react"
import { useAtomSet } from "@effect/atom-react"
import type { ConversationId, EntryId } from "@openbot/contracts"
import { commands } from "@openbot/client"
import { MenuItem, MenuSeparator, useToast } from "@openbot/ui"
import { ActionSheet } from "../app/ActionSheet.tsx"
import { plainPreview } from "../app/format.ts"
import type { MessageEntry } from "./grouping.ts"

/** Table rules and pipes read badly in a one-line preview. */
const previewText = (text: string): string => text.replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, "").replace(/\s*\|\s*/g, " · ").replace(/(^|\n) · /g, "$1")

/** Same set as the hover React popover (Message.tsx). */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"] as const

export interface MessageSheetProps {
  readonly entry: MessageEntry
  readonly conversationId: ConversationId
  readonly authorName: string
  readonly onReply?: ((entry: MessageEntry) => void) | undefined
  readonly onClose: () => void
}

export function MessageSheet({ entry, conversationId, authorName, onReply, onClose }: MessageSheetProps): ReactNode {
  const react = useAtomSet(commands["messages.react"])
  const { toast } = useToast()
  const mine = new Set((entry.reactions ?? []).filter((r) => r.by.kind !== "bot").map((r) => r.emoji))
  const copy = (text: string, what: string) => {
    onClose()
    void navigator.clipboard?.writeText(text).then(
      () => toast({ title: `${what} copied`, icon: Copy }),
      () => toast({ title: `Couldn't copy ${what.toLowerCase()}`, tone: "danger" }),
    )
  }
  return (
    <ActionSheet
      label="Message actions"
      onClose={onClose}
      testId="message-sheet"
      header={
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-fg-tertiary">{authorName}</span>
          <p className="line-clamp-2 text-base text-fg-secondary">{plainPreview(previewText(entry.text), 180) || "Attachment"}</p>
        </div>
      }
    >
      <div className="flex justify-between gap-1 px-2 pt-1 pb-3" role="group" aria-label="React">
        {QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            aria-label={`React ${e}`}
            aria-pressed={mine.has(e)}
            className="inline-flex size-12 items-center justify-center rounded-full bg-secondary text-[24px] transition-colors active:bg-secondary-hover aria-pressed:bg-accent-soft aria-pressed:ring-1 aria-pressed:ring-accent-line-faint"
            onClick={() => {
              react({ conversationId, entryId: entry.id as EntryId, emoji: e })
              onClose()
            }}
          >
            {e}
          </button>
        ))}
      </div>
      <div role="menu" aria-label="Message actions" className="flex flex-col gap-px">
        {onReply && (
          <MenuItem
            icon={Reply}
            onSelect={() => {
              onClose()
              onReply(entry)
            }}
          >
            Reply
          </MenuItem>
        )}
        <MenuItem icon={Copy} onSelect={() => copy(entry.text, "Message")}>
          Copy
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Hash} onSelect={() => copy(entry.id, "Message ID")}>
          Copy message ID
        </MenuItem>
      </div>
    </ActionSheet>
  )
}
