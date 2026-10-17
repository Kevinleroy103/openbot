// The bot-to-bot exchange (Grok's "2 messages with ‹Bot›" line → the conversation between the
// agents): every message_bot / handoff_task message between bots A and B, both directions, in order.
// B → A lives in A's direct conversation, A → B in B's; both replicas come from the client's
// conversation atoms (the open chat's is already live; the other subscribes while this is open).
import { useAtomValue } from "@effect/atom-react"
import { conversationAtom } from "@openbot/client"
import { type Bot, type ConversationId, emptyConversationState } from "@openbot/contracts"
import { Avatar, Bubble, Dialog, DialogBody, DialogFooter, DialogHeader, PillButton, Spinner } from "@openbot/ui"
import { Attachments } from "./Attachments.tsx"
import { ArrowLeftRight } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { valueOr } from "../app/data.ts"
import { formatTimestamp } from "../app/format.ts"
import { exchangeBetween } from "./grouping.ts"
import { Markdown } from "./Markdown.tsx"

export interface ExchangeDialogProps {
  /** The bot whose chat is open. */
  readonly a: Bot
  /** The other bot. */
  readonly b: Bot
  readonly onClose: () => void
  readonly onOpenConversation: (id: ConversationId) => void
}

export function ExchangeDialog({ a, b, onClose, onOpenConversation }: ExchangeDialogProps): ReactNode {
  const ra = useAtomValue(conversationAtom(a.directConversationId))
  const rb = useAtomValue(conversationAtom(b.directConversationId))
  const sa = valueOr(ra, emptyConversationState)
  const sb = valueOr(rb, emptyConversationState)
  const items = useMemo(() => exchangeBetween(a.id, b.id, [[...sa.entries.values()], [...sb.entries.values()]]), [a.id, b.id, sa.entries, sb.entries])
  const loading = ra._tag === "Initial" || rb._tag === "Initial"
  const bots = new Map([[a.id as string, a], [b.id as string, b]])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={560} label={`${a.name} and ${b.name}`}>
      <DialogHeader
        title={
          <span className="inline-flex items-center gap-2" data-testid="exchange-title">
            <Avatar shape={a.avatar.shape} color={a.avatar.color} size={22} />
            {a.name}
            <ArrowLeftRight className="size-4 text-icon-tertiary" aria-label="and" />
            <Avatar shape={b.avatar.shape} color={b.avatar.color} size={22} />
            {b.name}
          </span>
        }
        description={`Messages ${a.name} and ${b.name} sent each other`}
        onClose={onClose}
      />
      <DialogBody className="max-h-[60vh] overflow-y-auto scrollbar-thin">
        <div className="flex flex-col gap-3" data-testid="exchange">
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-8 text-fg-tertiary">
            <Spinner size={16} label="Loading" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-secondary">No messages between them yet.</p>
        ) : (
          items.map((e) => {
            const from = bots.get(e.author.kind === "bot" ? e.author.botId : "")
            const to = bots.get(e.toBotId ?? "")
            return (
              <div key={e.id} className="flex items-end gap-2" data-exchange-item={e.id}>
                <Avatar shape={from?.avatar.shape} color={from?.avatar.color} size={24} className="mb-1.5" />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="flex items-center gap-1.5 ps-3 text-xs text-fg-secondary">
                    <span className="text-fg">{from?.name ?? "Bot"}</span>
                    <span>to {to?.name ?? "Bot"}</span>
                    <span aria-hidden>·</span>
                    <button
                      type="button"
                      className="hover:text-fg hover:underline"
                      title={`Open ${to?.name ?? "the"} chat at this message`}
                      onClick={() => {
                        if (to) onOpenConversation(to.directConversationId)
                        onClose()
                      }}
                    >
                      {formatTimestamp(e.createdAt)}
                    </button>
                  </span>
                  {e.attachments.length > 0 && <Attachments items={e.attachments} side="bot" />}
                  {e.text.trim() !== "" && (
                    <Bubble side="bot" className="max-w-full">
                      <Markdown text={e.text} />
                    </Bubble>
                  )}
                </div>
              </div>
            )
          })
        )}
        </div>
      </DialogBody>
      <DialogFooter>
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Close
        </PillButton>
        <PillButton
          variant="primary"
          size="card"
          onClick={() => {
            onOpenConversation(b.directConversationId)
            onClose()
          }}
        >
          Open {b.name}'s chat
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}
