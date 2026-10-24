// Minimal stand-ins for the W2.3 components, used only while `../details`, `../settings`,
// `../dialogs`, `../onboarding` or `../computer` are missing or fail to load. They keep the shell
// usable (and the smoke test runnable) but are deliberately plain; W2.3 owns the real screens.
import { Monitor, Settings as SettingsIcon, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { DEFAULT_SETTINGS, MAX_GROUP_BOTS, MIN_GROUP_BOTS, type BotId, type ConversationId } from "@openbot/contracts"
import { createBotAtom, createGroupAtom, newClientNonce, updateSettingsAtom } from "@openbot/client"
import {
  Avatar,
  DialogBody,
  DialogFooter,
  Icon,
  IconButton,
  PillButton,
  SegmentedTabs,
  Select,
  Sheet,
  SheetField,
  Switch,
  TextField,
  Dialog,
  cn,
  useToast,
} from "@openbot/ui"
import type { ComputerViewProps, DetailsPaneProps, NewBotFormProps, NewGroupFormProps, OnboardingProps, SettingsDialogProps, SettingsPage } from "../contracts.ts"
import { describeFailure } from "../cards/useRespond.ts"
import { useRoster } from "./data.ts"
import { useDetailsPane } from "./uiState.ts"

export function FallbackDetailsPane({ botId, conversationId, onClose }: DetailsPaneProps): ReactNode {
  const roster = useRoster()
  const pane = useDetailsPane()
  const summary = conversationId ? roster.state.conversations.get(conversationId) : undefined
  const bot = roster.botById(botId ?? summary?.botIds[0])
  const isGroup = summary?.kind === "group"
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[60px] shrink-0 items-center justify-end px-3">
        <IconButton icon={X} label="Close details" variant="elevated" onClick={onClose} />
      </div>
      <div className="flex flex-col items-center gap-1 px-4">
        <Avatar shape={bot?.avatar.shape} color={bot?.avatar.color} size={64} />
        <div className="mt-2 text-xl font-medium text-fg">{isGroup ? summary?.title : bot?.name}</div>
        <div className="text-xs text-fg-secondary">{isGroup ? `${summary?.botIds.length ?? 0} Bots` : (bot?.label ?? "Add a label")}</div>
        <SegmentedTabs
          className="mt-4"
          label="Details sections"
          value={pane.tab}
          onValueChange={pane.setTab}
          tabs={[
            { value: "details", label: "Details" },
            { value: "library", label: "Library" },
            { value: "computer", label: "Computer" },
          ]}
        />
      </div>
      {bot && (
        <div className="flex flex-col gap-3 px-4 pt-6">
          <div className="text-xs text-fg-secondary">Brain</div>
          <Sheet>
            <SheetField label="Harness">{bot.harness.kind}</SheetField>
            <SheetField label="Model">{bot.harness.model ?? "Default"}</SheetField>
            <SheetField label="Computer">{roster.state.nodes.get(bot.hostNodeId)?.label ?? "This computer"}</SheetField>
          </Sheet>
          <p className="px-4 pt-4 text-center text-sm text-fg-secondary">Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.</p>
        </div>
      )}
    </div>
  )
}

export function FallbackComputerView({ onClose }: ComputerViewProps): ReactNode {
  return (
    <div className="flex h-full flex-col bg-[rgba(20,20,20,.95)] text-white">
      <div className="flex h-11 items-center justify-end bg-[rgba(0,0,0,.55)] px-3">
        <IconButton icon={X} label="Exit fullscreen" onClick={onClose} className="text-white" />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-white/70">
        <Icon icon={Monitor} size="xl" />
        No screen to show
      </div>
    </div>
  )
}

const PAGES: ReadonlyArray<{ readonly id: SettingsPage; readonly label: string }> = [
  { id: "general", label: "General" },
  { id: "harnesses", label: "Harnesses" },
  { id: "computers", label: "Computers" },
  { id: "permissions", label: "Permissions" },
  { id: "usage", label: "Usage" },
]

export function FallbackSettingsDialog({ open, initialPage, onClose }: SettingsDialogProps): ReactNode {
  const roster = useRoster()
  const setSettings = useAtomSet(updateSettingsAtom, { mode: "promiseExit" })
  const { toast } = useToast()
  const update = async (input: Parameters<typeof setSettings>[0]) => {
    const exit = await setSettings(input)
    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
  }
  const settings = roster.state.settings ?? DEFAULT_SETTINGS
  const [page, setPage] = useState<SettingsPage>(initialPage ?? "general")
  const row = (title: string, desc: string | undefined, control: ReactNode) => (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-base text-fg">{title}</div>
        {desc && <div className="text-sm text-fg-secondary">{desc}</div>}
      </div>
      {control}
    </div>
  )
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} width={900} height={702} label="Settings" className="bg-chrome">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[192px] shrink-0 flex-col gap-0.5 border-e-[0.5px] border-line-tertiary p-3">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPage(p.id)}
              aria-current={page === p.id ? "page" : undefined}
              className="flex h-8 items-center gap-2 rounded-lg px-2 text-base text-fg transition-colors hover:bg-hover aria-[current=page]:bg-active"
            >
              <Icon icon={SettingsIcon} size="lg" className="text-icon-secondary" />
              {p.label}
            </button>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto px-10 pt-6 pb-10 scrollbar-thin">
          <IconButton icon={X} label="Close settings" size={28} className="absolute top-4 right-4" onClick={onClose} />
          <h2 className="text-xl font-medium text-fg">{PAGES.find((p) => p.id === page)?.label ?? "General"}</h2>
          {page === "general" ? (
            <>
              <div className="mt-8 mb-2 text-sm text-fg-secondary">Appearance</div>
              <div className="flex flex-col rounded-3xl bg-elevated hairline border-line-tertiary [&>*+*]:border-t-[0.5px] [&>*+*]:border-line-tertiary">
                {row(
                  "Theme",
                  undefined,
                  <Select
                    label="Theme"
                    value={settings.theme}
                    onValueChange={(theme) => update({ patch: { theme } })}
                    options={[
                      { value: "light", label: "Light" },
                      { value: "dark", label: "Dark" },
                      { value: "system", label: "Follow System" },
                    ]}
                  />,
                )}
                {row(
                  "Accent",
                  "Tint your messages and the send button with the Bot's color.",
                  <Select
                    label="Accent"
                    value={settings.accent}
                    onValueChange={(accent) => update({ patch: { accent } })}
                    options={[
                      { value: "bot", label: "Bot color" },
                      { value: "black", label: "Black" },
                    ]}
                  />,
                )}
                {row("Show steps under replies", "A collapsed list of the tools a Bot used, under each finished reply.", <Switch checked={settings.showSteps} onCheckedChange={(showSteps) => update({ patch: { showSteps } })} label="Show steps" />)}
                {row("Bots can message each other", "Lets Bots hand off work and ask each other for help.", <Switch checked={settings.botMessaging} onCheckedChange={(botMessaging) => update({ patch: { botMessaging } })} label="Bot messaging" />)}
              </div>
            </>
          ) : (
            <p className="mt-8 text-sm text-fg-secondary">This page is not available in this build.</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export function FallbackNewBotForm({ initialName, onCreated, onCancel }: NewBotFormProps): ReactNode {
  const create = useAtomSet(createBotAtom, { mode: "promiseExit" })
  const { toast } = useToast()
  const [name, setName] = useState(initialName ?? "")
  const [label, setLabel] = useState("")
  const [harness, setHarness] = useState<"fake" | "claude" | "codex" | "opencode">("fake")
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    const exit = await create({ name: name.trim(), ...(label.trim() ? { label: label.trim() } : {}), harness: { kind: harness }, clientNonce: newClientNonce() })
    setBusy(false)
    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
    else onCreated(exit.value.id)
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <DialogBody className="flex flex-col gap-3">
        <TextField label="Name" autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Research Scout" />
        <TextField label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Research" />
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-secondary">Harness</span>
          <Select
            label="Harness"
            value={harness}
            onValueChange={setHarness}
            options={[
              { value: "fake", label: "Fake (offline demo)" },
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
              { value: "opencode", label: "OpenCode" },
            ]}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <PillButton variant="tertiary" onClick={onCancel}>
          Cancel
        </PillButton>
        <PillButton type="submit" variant="primary" disabled={!name.trim()} loading={busy}>
          Create Bot
        </PillButton>
      </DialogFooter>
    </form>
  )
}

export function FallbackNewGroupForm({ initialBotIds, onCreated, onCancel }: NewGroupFormProps): ReactNode {
  const roster = useRoster()
  const create = useAtomSet(createGroupAtom, { mode: "promiseExit" })
  const { toast } = useToast()
  const [picked, setPicked] = useState<ReadonlyArray<BotId>>(initialBotIds ?? [])
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const valid = picked.length >= MIN_GROUP_BOTS && picked.length <= MAX_GROUP_BOTS
  const submit = async () => {
    setBusy(true)
    const names = picked.map((id) => roster.botById(id)?.name ?? "Bot")
    const exit = await create({ title: title.trim() || names.join(", "), memberBotIds: picked, clientNonce: newClientNonce() })
    setBusy(false)
    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
    else onCreated(exit.value.id as ConversationId)
  }
  return (
    <div>
      <DialogBody className="flex flex-col gap-3">
        <TextField label="Name (optional)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Launch crew" />
        <div className="text-xs text-fg-secondary">Pick 2–6 Bots</div>
        <div className="flex max-h-72 flex-col overflow-y-auto scrollbar-thin">
          {roster.bots.map((b) => {
            const on = picked.includes(b.id)
            return (
              <button
                key={b.id}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== b.id) : [...p, b.id]))}
                className={cn("flex h-10 items-center gap-2.5 rounded-xl px-2 text-start text-base text-fg hover:bg-hover", on && "bg-active")}
              >
                <Avatar shape={b.avatar.shape} color={b.avatar.color} size={22} />
                <span className="flex-1 truncate">{b.name}</span>
                {on && <span className="text-xs text-fg-secondary">Added</span>}
              </button>
            )
          })}
        </div>
      </DialogBody>
      <DialogFooter>
        <PillButton variant="tertiary" onClick={onCancel}>
          Cancel
        </PillButton>
        <PillButton variant="primary" disabled={!valid} loading={busy} onClick={() => void submit()}>
          Create group chat
        </PillButton>
      </DialogFooter>
    </div>
  )
}

export function FallbackOnboarding({ onDone }: OnboardingProps): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-chrome text-center">
      <Avatar shape="blob" color="black" size={108} idle />
      <h1 className="text-3xl font-medium text-fg">Your team of always-on Bots</h1>
      <p className="max-w-md text-base text-fg-secondary">Each Bot runs on the harness you pick (Claude, Codex or OpenCode) and works on your computers.</p>
      <PillButton variant="primary" size="lg" onClick={() => onDone()}>
        Get started
      </PillButton>
    </div>
  )
}

/** Shown by Suspense while a lazy W2.3 module loads. */
export function PaneLoading({ className }: { readonly className?: string }): ReactNode {
  return <div className={cn("h-full w-full", className)} aria-busy="true" />
}


