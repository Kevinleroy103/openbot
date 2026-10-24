// Details-pane identity block (grok-bot-ui.md §4.7, §4.2): 64 px avatar (hover → pencil; click →
// avatar editor popover; a bottom sheet on a phone), inline-editable name (17/24 medium) and label
// ("Add a label", 12 px).
import type { Bot } from "@openbot/contracts"
import {
  Avatar,
  AvatarPicker,
  Icon,
  IconButton,
  PillButton,
  Popover,
  SegmentedTabs,
  cn,
  defaultBotAvatar,
  normalizeAvatar,
} from "@openbot/ui"
import { Pencil, Shuffle } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ActionSheet } from "../app/ActionSheet.tsx"
import { useIsPhone } from "../app/layout.ts"
import { InlineEdit } from "./InlineEdit.tsx"
import { ErrorLine, useCommand } from "./kit.tsx"

export function BotHeader({ bot, working }: { readonly bot: Bot; readonly working: boolean }): ReactNode {
  const updateName = useCommand("bots.update", `${bot.id}/name`)
  const updateLabel = useCommand("bots.update", `${bot.id}/label`)
  const error = updateName.error ?? updateLabel.error
  return (
    <div className="flex flex-col items-center gap-1 px-4">
      <AvatarEditor bot={bot} working={working} />
      <InlineEdit
        value={bot.name}
        placeholder="Name"
        label="Bot name"
        testId="bot-name"
        className="mt-2 text-xl font-medium text-fg"
        onSave={(name) => updateName.run({ botId: bot.id, patch: { name } })}
      />
      <InlineEdit
        value={bot.label ?? ""}
        placeholder="Add a label"
        label="Label"
        allowEmpty
        testId="bot-label"
        className="text-xs text-fg-secondary"
        onSave={(label) => updateLabel.run({ botId: bot.id, patch: { label: label.length > 0 ? label : null } })}
      />
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  )
}

/** 64 px avatar button + the 300 px editor popover (Bot tab: shape grid + color dots; Reset). */
function AvatarEditor({ bot, working }: { readonly bot: Bot; readonly working: boolean }): ReactNode {
  const update = useCommand("bots.update", `${bot.id}/avatar`)
  // optimistic picker state; follows the stored avatar whenever the roster changes it
  const [local, setLocal] = useState(() => normalizeAvatar(bot.avatar))
  const [seen, setSeen] = useState(bot.avatar)
  if (seen !== bot.avatar) {
    setSeen(bot.avatar)
    setLocal(normalizeAvatar(bot.avatar))
  }
  const save = (next: { shape: string; color: string }) => {
    setLocal(normalizeAvatar(next))
    void update.run({ botId: bot.id, patch: { avatar: next } })
  }
  const phone = useIsPhone()
  const [sheet, setSheet] = useState(false)
  const editor = (
    <div className="flex flex-col gap-4 p-2 pb-5" data-testid="avatar-editor">
      <SegmentedTabs
        label="Avatar source"
        value="bot"
        tabs={[{ value: "bot", label: "Bot" }]}
        trailing={
          <div className="flex items-center gap-0.5">
            <IconButton
              icon={Shuffle}
              label="Shuffle"
              size={phone ? 36 : 28}
              iconSize="sm"
              onClick={() => save(defaultBotAvatar(`${bot.id}:${Date.now().toString(36)}`))}
            />
            <button
              type="button"
              onClick={() => save(defaultBotAvatar(bot.id))}
              className={cn(
                "rounded-full text-sm text-fg-secondary transition-colors hover:bg-hover hover:text-fg",
                phone ? "h-9 px-3" : "h-7 px-2",
              )}
            >
              Reset
            </button>
          </div>
        }
      />
      <div className="h-0 border-t-[0.5px] border-line-secondary" />
      <AvatarPicker shape={local.shape} color={local.color} onChange={save} className="px-2" />
      {update.error && <ErrorLine>{update.error}</ErrorLine>}
    </div>
  )
  const face = (
    <>
      {/* hover / open: the body darkens and a pencil sits on it (grok-bot-ui.md §4.2, R:light-07) */}
      <span className="inline-flex transition-[filter] duration-150 group-hover:brightness-[.45] group-aria-expanded:brightness-[.45]">
        <Avatar
          shape={local.shape}
          color={local.color}
          size={64}
          working={working}
          idle={!working}
          label={`${bot.name}'s avatar`}
        />
      </span>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-aria-expanded:opacity-100">
        <Icon icon={Pencil} size="lg" />
      </span>
    </>
  )
  if (phone) {
    return (
      <>
        <button
          type="button"
          aria-label="Edit avatar"
          aria-haspopup="dialog"
          aria-expanded={sheet}
          data-testid="avatar-button"
          onClick={() => setSheet(true)}
          className="group relative inline-flex size-16 items-center justify-center rounded-full outline-offset-2"
        >
          {face}
          {/* touch has no hover: a small badge says the avatar is editable */}
          <span className="absolute -end-0.5 -bottom-0.5 inline-flex size-6 items-center justify-center rounded-full bg-elevated text-icon-secondary shadow-control hairline border-line-secondary">
            <Icon icon={Pencil} size="xs" />
          </span>
        </button>
        {sheet && (
          <ActionSheet
            label="Edit avatar"
            onClose={() => setSheet(false)}
            testId="avatar-sheet"
            header={
              <div className="flex items-center gap-3">
                <span className="flex-1 text-lg font-medium text-fg">Edit avatar</span>
                <PillButton variant="primary" size="card" onClick={() => setSheet(false)}>
                  Done
                </PillButton>
              </div>
            }
          >
            <div className="flex justify-center pb-1">
              <Avatar shape={local.shape} color={local.color} size={72} idle />
            </div>
            {editor}
          </ActionSheet>
        )}
      </>
    )
  }
  return (
    <Popover
      side="bottom"
      align="center"
      offset={8}
      label="Edit avatar"
      className="w-[296px]"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label="Edit avatar"
          data-testid="avatar-button"
          className="group relative inline-flex size-16 items-center justify-center rounded-full outline-offset-2"
        >
          {face}
        </button>
      )}
    >
      {editor}
    </Popover>
  )
}
