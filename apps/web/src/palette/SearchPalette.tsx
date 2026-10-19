// Search palette (Cmd/Ctrl+K, grok-bot-ui.md §4.10): Bots (unread first), group chats, settings
// pages and actions. Rows: 22 px avatar + name + label chip, unread dot at the right. Phone: a
// full-screen sheet with an iOS "Cancel", without the keyboard-only actions.
import { ChartNoAxesColumn, Cpu, MessageSquarePlus, MessagesSquare, Monitor, Moon, PanelLeft, Plus, Settings, ShieldCheck, Sparkles, Sun, Users } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { useAtomSet } from "@effect/atom-react"
import { DEFAULT_SETTINGS, type ConversationSummary } from "@openbot/contracts"
import { updateSettingsAtom } from "@openbot/client"
import { Avatar, AvatarStack, CommandPalette, CommandPaletteBody, Dialog, Icon, KeyBadge, LabelChip, UnreadDot, type PaletteItem } from "@openbot/ui"
import { useIsPhone } from "../app/layout.ts"
import { useRoster } from "../app/data.ts"
import { useDialogs, useResolvedTheme, useSelection, useSettingsDialog } from "../app/uiState.ts"
import type { SettingsPage } from "../contracts.ts"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? "⌘" : "Ctrl+"

export interface SearchPaletteProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onToggleCompact: () => void
}

export function SearchPalette({ open, onOpenChange, onToggleCompact }: SearchPaletteProps): ReactNode {
  const roster = useRoster()
  const { select } = useSelection()
  const dialogs = useDialogs()
  const settingsDialog = useSettingsDialog()
  const theme = useResolvedTheme()
  const updateSettings = useAtomSet(updateSettingsAtom)
  const settings = roster.state.settings ?? DEFAULT_SETTINGS
  const phone = useIsPhone()

  const items = useMemo((): ReadonlyArray<PaletteItem> => {
    const summaries = roster.state.conversations
    const summaryOf = (id: string): ConversationSummary | undefined => summaries.get(id as ConversationSummary["id"])
    const bots = [...roster.bots].sort((a, b) => {
      const ua = summaryOf(a.directConversationId)?.unreadCount ?? 0
      const ub = summaryOf(b.directConversationId)?.unreadCount ?? 0
      if ((ua > 0) !== (ub > 0)) return ua > 0 ? -1 : 1
      return (summaryOf(b.directConversationId)?.lastActivityAt ?? 0) - (summaryOf(a.directConversationId)?.lastActivityAt ?? 0)
    })
    const botItems: PaletteItem[] = bots.map((b) => ({
      id: `bot:${b.id}`,
      label: b.name,
      keywords: [b.label ?? "", b.harness.kind, "bot"],
      leading: <Avatar shape={b.avatar.shape} color={b.avatar.color} size={22} className={b.hidden ? "opacity-50" : undefined} />,
      ...(b.label ? { chip: <LabelChip>{b.label}</LabelChip> } : {}),
      ...((summaryOf(b.directConversationId)?.unreadCount ?? 0) > 0 ? { trailing: <UnreadDot /> } : {}),
      onSelect: () => select(b.directConversationId),
    }))
    const groups: PaletteItem[] = [...summaries.values()]
      .filter((c) => c.kind === "group")
      .map((c) => ({
        id: `group:${c.id}`,
        label: c.title,
        group: "Group chats",
        keywords: ["group", ...c.botIds.map((id) => roster.botById(id)?.name ?? "")],
        leading: <AvatarStack size={22} outlineColor="var(--ob-elevated)" avatars={c.botIds.map((id) => ({ key: id, shape: roster.botById(id)?.avatar.shape, color: roster.botById(id)?.avatar.color }))} />,
        ...(c.unreadCount > 0 ? { trailing: <UnreadDot /> } : {}),
        onSelect: () => select(c.id),
      }))
    const page = (p: SettingsPage, label: string, icon: typeof Settings, keywords: string[] = []): PaletteItem => ({
      id: `settings:${p}`,
      label: `Settings › ${label}`,
      group: "Settings",
      keywords: ["settings", ...keywords],
      leading: <Icon icon={icon} size="xl" className="text-icon-secondary" />,
      onSelect: () => settingsDialog.show(p),
    })
    const actions: PaletteItem[] = [
      {
        id: "action:new-chat",
        label: "New chat",
        group: "Actions",
        leading: <Icon icon={MessageSquarePlus} size="xl" className="text-icon-secondary" />,
        trailing: <KeyBadge>{modKey}N</KeyBadge>,
        onSelect: () => select(null),
      },
      { id: "action:new-bot", label: "Create new Bot", group: "Actions", keywords: ["add", "bot"], leading: <Icon icon={Plus} size="xl" className="text-icon-secondary" />, onSelect: () => dialogs.show({ kind: "new-bot" }) },
      { id: "action:new-group", label: "Create group chat", group: "Actions", keywords: ["group", "team"], leading: <Icon icon={Users} size="xl" className="text-icon-secondary" />, onSelect: () => dialogs.show({ kind: "new-group" }) },
      {
        id: "action:theme",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        group: "Actions",
        keywords: ["theme", "appearance", "dark", "light"],
        leading: <Icon icon={theme === "dark" ? Sun : Moon} size="xl" className="text-icon-secondary" />,
        onSelect: () => updateSettings({ patch: { theme: theme === "dark" ? "light" : "dark" } }),
      },
      {
        id: "action:steps",
        label: settings.showSteps ? "Hide steps under replies" : "Show steps under replies",
        group: "Actions",
        keywords: ["steps", "tools", "activity"],
        leading: <Icon icon={ChartNoAxesColumn} size="xl" className="text-icon-secondary" />,
        onSelect: () => updateSettings({ patch: { showSteps: !settings.showSteps } }),
      },
      {
        id: "action:compact",
        label: "Toggle compact sidebar",
        group: "Actions",
        keywords: ["sidebar"],
        leading: <Icon icon={PanelLeft} size="xl" className="text-icon-secondary" />,
        trailing: <KeyBadge>{modKey}B</KeyBadge>,
        onSelect: onToggleCompact,
      },
    ]
    return [
      ...botItems,
      ...groups,
      page("general", "General", Settings, ["theme", "accent", "appearance"]),
      page("harnesses", "Harnesses", Cpu, ["claude", "codex", "opencode", "sign in"]),
      page("computers", "Computers", Monitor, ["nodes", "pair", "pairing"]),
      page("permissions", "Permissions", ShieldCheck, ["rules", "approvals", "allow"]),
      page("skills", "Skills", Sparkles, ["library", "skills.sh", "import"]),
      page("slack", "Slack", MessagesSquare, ["connect", "connector", "workspace"]),
      page("usage", "Usage", ChartNoAxesColumn, ["tokens", "cost"]),
      ...(phone ? actions.filter((a) => a.id !== "action:compact").map(({ trailing: _shortcut, ...a }) => a) : actions),
    ]
  }, [roster, select, dialogs, settingsDialog, theme, settings.showSteps, updateSettings, onToggleCompact, phone])

  if (phone) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} width={560} label="Search" className="ob-phone-full ob-search-sheet">
        <CommandPaletteBody open={open} onOpenChange={onOpenChange} items={items} placeholder="Search" emptyText="No results" />
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute end-1.5 top-[calc(6px+env(safe-area-inset-top))] inline-flex h-9 items-center rounded-full px-3 text-[16px] text-accent-fg active:bg-hover"
        >
          Cancel
        </button>
      </Dialog>
    )
  }
  return <CommandPalette open={open} onOpenChange={onOpenChange} items={items} placeholder="Search" emptyText="No results" />
}
