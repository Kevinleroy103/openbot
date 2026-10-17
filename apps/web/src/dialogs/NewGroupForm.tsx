// New group form (D5.1; grok-bot-ui.md §4.8 "Selecting 2–6 Bots creates a group"): pick 2–6 Bots,
// an optional title (empty = the app names it), and the lead who answers un-addressed messages
// → conversations.createGroup. Rendered inside the shell's Dialog; fields + footer only.
import { botsAtom } from "@openbot/client"
import { type Bot, type BotId, MAX_GROUP_BOTS, MIN_GROUP_BOTS } from "@openbot/contracts"
import { Avatar, Icon, LabelChip, PillButton, Select, TextField, cn } from "@openbot/ui"
import { Check, Search } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import type { NewGroupFormProps } from "../contracts.ts"
import { ErrorLine, newNonce, useCommand, useRosterValue } from "../details/kit.tsx"

export function NewGroupForm({ onCreated, onCancel, initialBotIds }: NewGroupFormProps): ReactNode {
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const create = useCommand("conversations.createGroup", "new-group-form")
  const [nonce] = useState(newNonce)
  const [picked, setPicked] = useState<ReadonlyArray<BotId>>(() => (initialBotIds ?? []).slice(0, MAX_GROUP_BOTS))
  const [title, setTitle] = useState("")
  const [lead, setLead] = useState<BotId | undefined>(undefined)
  const [query, setQuery] = useState("")

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bots.filter((b) => !b.hidden || picked.includes(b.id)).filter((b) => !q || b.name.toLowerCase().includes(q) || (b.label ?? "").toLowerCase().includes(q))
  }, [bots, query, picked])
  const pickedBots = picked.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => b !== undefined)
  const leadId = lead && picked.includes(lead) ? lead : picked[0]
  const valid = picked.length >= MIN_GROUP_BOTS && picked.length <= MAX_GROUP_BOTS
  const full = picked.length >= MAX_GROUP_BOTS

  const toggle = (id: BotId) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_GROUP_BOTS ? p : [...p, id]))

  const submit = async () => {
    if (!valid) return
    const r = await create.run({ title: title.trim(), memberBotIds: [...picked], ...(leadId ? { leadBotId: leadId } : {}), clientNonce: nonce })
    if (r.ok) onCreated(r.value.id)
  }

  return (
    <form
      className="flex min-h-0 flex-col"
      data-testid="new-group-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-2 scrollbar-thin">
        <TextField
          aria-label="Group name"
          placeholder={pickedBots.length > 0 ? pickedBots.map((b) => b.name).join(", ") : "Group name (optional)"}
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-fg-secondary">
              Members · {picked.length} of {MIN_GROUP_BOTS}–{MAX_GROUP_BOTS}
            </span>
            <div className="relative w-44">
              <Icon icon={Search} size="xs" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-icon-tertiary" />
              <input
                aria-label="Find a Bot"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a Bot"
                className="h-7 w-full rounded-lg bg-elevated ps-7 pe-2 text-sm text-fg outline-none hairline border-line-tertiary placeholder:text-fg-quaternary"
              />
            </div>
          </div>
          <div role="group" aria-label="Members" className="flex max-h-[300px] flex-col gap-px overflow-y-auto rounded-2xl bg-elevated p-1 hairline border-line-tertiary scrollbar-thin">
            {visible.length === 0 && <p className="px-3 py-4 text-center text-sm text-fg-tertiary">{bots.length === 0 ? "Create some Bots first." : "No Bots match."}</p>}
            {visible.map((b) => {
              const on = picked.includes(b.id)
              return (
                <button
                  key={b.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={!on && full}
                  onClick={() => toggle(b.id)}
                  data-testid="group-candidate"
                  className={cn("flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1 text-start transition-colors hover:bg-hover disabled:opacity-40", on && "bg-active hover:bg-active")}
                >
                  <Avatar shape={b.avatar.shape} color={b.avatar.color} size={28} />
                  <span className="min-w-0 truncate text-base text-fg">{b.name}</span>
                  {b.label && <LabelChip>{b.label}</LabelChip>}
                  <span
                    className={cn(
                      "ms-auto inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors",
                      on ? "bg-primary text-fg-inverted" : "hairline border-line",
                    )}
                  >
                    {on && <Icon icon={Check} size="xs" glyph={12} />}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        {pickedBots.length >= 2 && (
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-fg">Lead</span>
              <span className="text-xs text-fg-secondary">Answers when nobody is @mentioned.</span>
            </div>
            <Select
              label="Lead"
              value={leadId ?? ""}
              onValueChange={(v) => setLead(v as BotId)}
              options={pickedBots.map((b) => ({
                value: b.id,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar shape={b.avatar.shape} color={b.avatar.color} size={16} />
                    {b.name}
                  </span>
                ),
              }))}
            />
          </div>
        )}
        {create.error && <ErrorLine className="px-0">{create.error}</ErrorLine>}
      </div>
      <div className="flex items-center justify-end gap-2 py-3 ps-4 pe-3">
        <span className="me-auto text-xs text-fg-tertiary">{picked.length < MIN_GROUP_BOTS ? `Pick at least ${MIN_GROUP_BOTS} Bots` : full ? `Up to ${MAX_GROUP_BOTS} Bots` : ""}</span>
        <PillButton variant="secondary" size="card" onClick={onCancel}>
          Cancel
        </PillButton>
        <PillButton type="submit" variant="primary" size="card" disabled={!valid} loading={create.pending} data-testid="create-group">
          Create group
        </PillButton>
      </div>
    </form>
  )
}
