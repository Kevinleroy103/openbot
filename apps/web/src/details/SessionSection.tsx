// Details › Notifications, Session (context meter + Compact / New session, F.10.4), Usage (F.10.5)
// and the danger zone (Delete bot).
import { conversationAtom, harnessStatusAtom, usageAtom } from "@openbot/client"
import type { Bot, BotNotify } from "@openbot/contracts"
import { PillButton, Select, cn } from "@openbot/ui"
import { Archive, RotateCcw, Trash2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ConfirmDialog, ErrorLine, Section, SectionSheet, SheetLine, formatTokens, formatUsd, useCommand, useQuery } from "./kit.tsx"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"

export function NotificationsSection({ bot }: { readonly bot: Bot }): ReactNode {
  const update = useCommand("bots.update", `${bot.id}/notify`)
  const [local, setLocal] = useState<BotNotify | undefined>(undefined)
  const value = local ?? bot.notify
  return (
    <Section title="Notifications" id="details-notifications">
      <SectionSheet>
        <SheetLine label="Notify me" hint="When it’s done or needs you">
          <Select<BotNotify>
            label="Notifications"
            value={value}
            options={[
              { value: "all", label: "All messages" },
              { value: "mentions", label: "Only when it needs me" },
              { value: "none", label: "Off" },
            ]}
            onValueChange={async (notify) => {
              setLocal(notify)
              await update.run({ botId: bot.id, patch: { notify } })
              setLocal(undefined)
            }}
          />
        </SheetLine>
      </SectionSheet>
      {update.error && <ErrorLine>{update.error}</ErrorLine>}
    </Section>
  )
}

const WEEK = 7 * 86_400_000

export function SessionSection({ bot }: { readonly bot: Bot }): ReactNode {
  const conv = useAtomValue(conversationAtom(bot.directConversationId))
  const session = AsyncResult.isSuccess(conv) ? conv.value.conversation?.sessions?.find((s) => s.botId === bot.id) : undefined
  const ctx = session?.contextUsage
  const pct = ctx && ctx.windowTokens > 0 ? Math.min(100, Math.round((ctx.usedTokens / ctx.windowTokens) * 100)) : undefined
  const statuses = useQuery(harnessStatusAtom)
  const caps = statuses.value?.find((s) => s.kind === bot.harness.kind)?.capabilities
  const canCompact = caps?.compact ?? true
  const compact = useCommand("bots.compact", bot.id)
  const fresh = useCommand("bots.newSession", bot.id)
  const [confirmNew, setConfirmNew] = useState(false)
  const [done, setDone] = useState<string | undefined>(undefined)

  // week window, stable per mount so the query family key does not churn
  const [since] = useState(() => Math.floor((Date.now() - WEEK) / 3_600_000) * 3_600_000)
  const usage = useQuery(usageAtom(since))
  const mine = usage.value?.find((u) => u.botId === bot.id)
  const tokens = mine ? mine.usage.inputTokens + mine.usage.outputTokens : 0

  const fill = pct === undefined ? "" : pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-fg-secondary"

  return (
    <Section title="Session" id="details-session" trailing={<span className="text-xs text-fg-tertiary">All of {bot.name}'s chats</span>}>
      <SectionSheet>
        <div className="flex flex-col gap-2 px-2 py-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm text-fg">Context</span>
            <span className="text-sm text-fg-secondary tabular-nums" data-testid="context-usage">
              {pct !== undefined && ctx ? `${pct} % · ${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.windowTokens)}` : session?.active === false ? "New session" : "Not reported yet"}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">{pct !== undefined && <div className={cn("h-full rounded-full", fill)} style={{ width: `${pct}%` }} />}</div>
          <div className="flex items-center gap-2 pt-1">
            <PillButton
              size="md"
              variant="secondary"
              leadingIcon={Archive}
              loading={compact.pending}
              disabled={!canCompact}
              title={canCompact ? undefined : "This harness can't compact"}
              onClick={async () => {
                setDone(undefined)
                const r = await compact.run({ botId: bot.id })
                if (r.ok) setDone("Compacted. The conversation summary carries on.")
              }}
            >
              {compact.pending ? "Compacting…" : "Compact"}
            </PillButton>
            <PillButton size="md" variant="ghost" leadingIcon={RotateCcw} className="ms-auto" onClick={() => setConfirmNew(true)} data-testid="new-session">
              New session
            </PillButton>
          </div>
        </div>
        <SheetLine label="This week" hint={mine ? `${mine.turnCount} turn${mine.turnCount === 1 ? "" : "s"}` : undefined}>
          <span className="text-sm text-fg-secondary tabular-nums">
            {mine ? `${mine.usage.costUsd !== undefined ? `${formatUsd(mine.usage.costUsd)} · ` : ""}${formatTokens(tokens)} tokens` : usage.loading ? "…" : "No usage"}
          </span>
        </SheetLine>
      </SectionSheet>
      {(compact.error ?? fresh.error) && <ErrorLine>{compact.error ?? fresh.error}</ErrorLine>}
      {done && <p className="px-3 text-xs text-success-fg">{done}</p>}
      <p className="px-3 text-2xs text-fg-quaternary" data-testid="session-scope">
        {bot.name} has one session for all of its chats (this DM, its groups and routines), so it remembers what it did in each. Compacting keeps a summary; a new session starts empty for all of them. {bot.name}'s memory and files stay.
      </p>
      <ConfirmDialog
        open={confirmNew}
        title="Start a new session?"
        body={`${bot.name} forgets the context of ALL its chats (DM, groups, routines) on its next message. The chat history, memory and files stay.`}
        confirmLabel="New session"
        pending={fresh.pending}
        error={fresh.error}
        onCancel={() => setConfirmNew(false)}
        onConfirm={async () => {
          const r = await fresh.run({ botId: bot.id })
          if (r.ok) {
            setConfirmNew(false)
            setDone("New session. The next message starts fresh.")
          }
        }}
      />
    </Section>
  )
}

export function DangerSection({ bot, onDeleted }: { readonly bot: Bot; readonly onDeleted: () => void }): ReactNode {
  const del = useCommand("bots.delete", bot.id)
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="flex flex-col items-center gap-2 px-3 pt-2">
      <PillButton variant="danger-soft" size="md" leadingIcon={Trash2} onClick={() => setConfirm(true)} data-testid="delete-bot">
        Delete {bot.name}
      </PillButton>
      <ConfirmDialog
        open={confirm}
        title={`Delete ${bot.name}?`}
        body="Its chats, routines and memory are removed. This can't be undone."
        confirmLabel="Delete"
        danger
        pending={del.pending}
        error={del.error}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          const r = await del.run({ botId: bot.id })
          if (r.ok) {
            setConfirm(false)
            onDeleted()
          }
        }}
      />
    </div>
  )
}
