// Details pane for a group conversation (D5.1; grok-bot-ui.md §4.7 "Group details"): stacked member
// avatars, the editable title, Members (lead + add / remove, 2–6 bots) via conversations.setMembers.
import { useAtomValue } from "@effect/atom-react"
import { botsAtom, conversationAtom } from "@openbot/client"
import { type Bot, type BotId, type ConversationId, MAX_GROUP_BOTS, MIN_GROUP_BOTS } from "@openbot/contracts"
import {
  Avatar,
  AvatarStack,
  Icon,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PillButton,
  StatusPill,
} from "@openbot/ui"
import { Crown, Ellipsis, MessageSquare, Plus, Trash2, UserMinus } from "lucide-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useState } from "react"
import { useSelection } from "../contracts.ts"
import { InlineEdit } from "./InlineEdit.tsx"
import {
  ConfirmDialog,
  EmptyNote,
  ErrorLine,
  LoadingLine,
  Section,
  SectionSheet,
  useCommand,
  useRosterValue,
} from "./kit.tsx"

export function GroupDetails({ conversationId }: { readonly conversationId: ConversationId }): ReactNode {
  const state = useAtomValue(conversationAtom(conversationId))
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const rename = useCommand("conversations.rename", conversationId)
  const setMembers = useCommand("conversations.setMembers", conversationId)
  const remove = useCommand("conversations.delete", conversationId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const selection = useSelection()

  if (!AsyncResult.isSuccess(state) || !state.value.conversation) {
    return AsyncResult.isFailure(state) ? <ErrorLine>Couldn't load this group.</ErrorLine> : <LoadingLine />
  }
  const conv = state.value.conversation
  if (conv.kind !== "group") return <EmptyNote>Not a group conversation.</EmptyNote>
  const members = conv.memberBotIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => b !== undefined)
  const lead = conv.leadBotId ?? conv.memberBotIds[0]
  const candidates = bots.filter((b) => !conv.memberBotIds.includes(b.id))
  const error = rename.error ?? setMembers.error

  const save = (memberBotIds: ReadonlyArray<BotId>, leadBotId?: BotId | null) =>
    setMembers.run({
      conversationId,
      memberBotIds: [...memberBotIds],
      ...(leadBotId !== undefined ? { leadBotId } : {}),
    })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1 px-4">
        <AvatarStack
          avatars={members.slice(0, 3).map((b) => ({ shape: b.avatar.shape, color: b.avatar.color, key: b.id }))}
          size={64}
          outlineColor="var(--ob-chrome)"
        />
        <InlineEdit
          value={conv.title}
          placeholder="Name this group"
          label="Group name"
          maxLength={80}
          testId="group-title"
          className="mt-2 text-xl font-medium text-fg"
          onSave={(title) => rename.run({ conversationId, title })}
        />
        <span className="text-xs text-fg-secondary">
          {members.length} Bots ·{" "}
          {lead ? `${bots.find((b) => b.id === lead)?.name ?? "Lead"} answers first` : "No lead"}
        </span>
      </div>
      <Section
        title="Members"
        trailing={
          <span className="text-xs text-fg-tertiary">
            {members.length} / {MAX_GROUP_BOTS}
          </span>
        }
      >
        <SectionSheet>
          {members.map((b) => (
            <div
              key={b.id}
              className="group flex min-h-14 items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover"
              data-testid="group-member"
            >
              <Avatar shape={b.avatar.shape} color={b.avatar.color} size={36} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-base text-fg">{b.name}</span>
                {b.label && <span className="truncate text-xs text-fg-secondary">{b.label}</span>}
              </div>
              {b.id === lead && (
                <StatusPill tone="neutral" className="h-[22px] gap-1 text-xs">
                  <Icon icon={Crown} size="xs" />
                  Lead
                </StatusPill>
              )}
              <Menu
                label={`${b.name} actions`}
                align="end"
                trigger={(p) => (
                  <button
                    {...p}
                    type="button"
                    aria-label={`${b.name} actions`}
                    className="inline-flex size-7 items-center justify-center rounded-full text-icon-secondary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary focus-visible:opacity-100 aria-expanded:opacity-100"
                  >
                    <Icon icon={Ellipsis} size="sm" />
                  </button>
                )}
              >
                <MenuItem icon={MessageSquare} onSelect={() => selection.select(b.directConversationId)}>
                  Message {b.name}
                </MenuItem>
                {b.id !== lead && (
                  <MenuItem icon={Crown} onSelect={() => void save(conv.memberBotIds, b.id)}>
                    Make lead
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem
                  icon={UserMinus}
                  danger
                  disabled={members.length <= MIN_GROUP_BOTS}
                  onSelect={() => {
                    const rest = conv.memberBotIds.filter((id) => id !== b.id)
                    void save(rest, b.id === conv.leadBotId ? null : undefined)
                  }}
                >
                  Remove from group
                </MenuItem>
              </Menu>
            </div>
          ))}
          {conv.memberBotIds.length < MAX_GROUP_BOTS && candidates.length > 0 && (
            <Menu
              label="Add member"
              align="start"
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 text-start text-sm text-fg-secondary transition-colors hover:bg-hover"
                >
                  <span className="inline-flex size-9 items-center justify-center rounded-full bg-secondary">
                    <Icon icon={Plus} size="md" />
                  </span>
                  Add Member
                </button>
              )}
            >
              <MenuLabel>Add to the group</MenuLabel>
              {candidates.map((b) => (
                <MenuItem
                  key={b.id}
                  leading={<Avatar shape={b.avatar.shape} color={b.avatar.color} size={20} />}
                  onSelect={() => void save([...conv.memberBotIds, b.id])}
                >
                  {b.name}
                </MenuItem>
              ))}
            </Menu>
          )}
        </SectionSheet>
        {error && <ErrorLine>{error}</ErrorLine>}
        <p className="px-3 text-2xs text-fg-quaternary">
          Messages go to @mentioned Bots, @everyone, or the Bot you reply to. Otherwise the lead answers.
        </p>
      </Section>
      <div className="flex flex-col items-center gap-2 px-3 pt-2">
        <PillButton
          variant="danger-soft"
          size="md"
          leadingIcon={Trash2}
          onClick={() => setConfirmDelete(true)}
          data-testid="delete-group"
        >
          Delete group…
        </PillButton>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${conv.title}”?`}
        body="The group's messages are removed. The Bots stay, and they keep what they learned here. This can't be undone."
        confirmLabel="Delete group"
        danger
        pending={remove.pending}
        error={remove.error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const r = await remove.run({ conversationId })
          if (r.ok) setConfirmDelete(false)
        }}
      />
    </div>
  )
}
