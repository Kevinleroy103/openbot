// Details › "Brain" (grok-bot-ui-activity.md F.10.1-B, OpenBot original): harness + account, model, effort,
// host node ("Runs on"), the other nodes the bot may reach, its autonomy (what it may do without
// asking) and its project folders (extra folders that count as its workspace, on top of Settings'
// shared ones). Same tokens as the Routines section.
import { harnessModelsAtom, harnessStatusAtom, nodesAtom, settingsAtom } from "@openbot/client"
import { useAtomValue } from "@effect/atom-react"
import type { Bot, BotHarness, HarnessStatus, NodeId, NodeSummary } from "@openbot/contracts"
import { profileIdOf } from "@openbot/contracts"
import { Icon, Menu, MenuItem, MenuLabel, Select, type SelectOption, cn } from "@openbot/ui"
import { ChevronDown } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useSettingsDialog } from "../contracts.ts"
import { AutonomySelect, FolderListEditor, FullAutoWarning, autonomyChoice } from "./autonomy.tsx"
import {
  ConfirmDialog,
  ErrorLine,
  Section,
  SectionSheet,
  SheetLine,
  StatusDot,
  accountChoiceLabel,
  accountNickname,
  harnessAccountName,
  harnessGlyph,
  harnessName,
  harnessReady,
  harnessState,
  statusFor,
  statusProfileId,
  nodeTone,
  useCommand,
  useQuery,
  useRosterValue,
} from "./kit.tsx"

const DEFAULT = "__default__"

export function BrainSection({ bot }: { readonly bot: Bot }): ReactNode {
  const statuses = useQuery(harnessStatusAtom)
  const models = useQuery(harnessModelsAtom(bot.harness.kind, bot.harness.profileId))
  const nodes = useRosterValue<ReadonlyArray<NodeSummary>>(nodesAtom, [])
  const update = useCommand("bots.update", `${bot.id}/brain`)
  const foldersUpdate = useCommand("bots.update", `${bot.id}/project-folders`)
  const shared = useAtomValue(settingsAtom).sharedProjectFolders
  const settings = useSettingsDialog()
  const [switchTo, setSwitchTo] = useState<{ readonly kind: string; readonly profileId: string } | undefined>(undefined)

  // Harness (kind) and, when it has several, the Account (harness profile: a login on the server)
  const statusOf = (kind: string, profileId: string): HarnessStatus | undefined => statusFor(statuses.value, { kind, profileId })
  const botProfile = profileIdOf(bot.harness)
  const current = statusOf(bot.harness.kind, botProfile)
  const ready = harnessReady(current)
  const accountsOf = (kind: string) => (statuses.value ?? []).filter((s) => s.kind === kind)
  const choiceName = (kind: string, profileId: string): string => {
    const s = statusOf(kind, profileId)
    if (s) return harnessAccountName(s, accountsOf(kind).length <= 1)
    return profileId === "default" ? harnessName(kind) : `${harnessName(kind)} · removed account`
  }
  /** The account a switch to `kind` lands on: its default when ready, else its first ready one. */
  const accountFor = (kind: string): string => {
    const accounts = accountsOf(kind)
    const pick = accounts.find((s) => statusProfileId(s) === "default" && harnessReady(s)) ?? accounts.find(harnessReady) ?? accounts[0]
    return pick ? statusProfileId(pick) : "default"
  }

  const harnessOptions = ((): ReadonlyArray<SelectOption<string>> => {
    const kinds = [...new Set<string>([...(statuses.value ?? []).map((s) => s.kind), bot.harness.kind])]
    return kinds.map((kind) => {
      const accounts = (statuses.value ?? []).filter((s) => s.kind === kind)
      const anyReady = accounts.some(harnessReady)
      const st = harnessState(accounts[0])
      return {
        value: kind,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={harnessGlyph(kind)} size="xs" className="text-icon-secondary" />
            {harnessName(kind, accounts[0])}
            {accounts.length > 0 && !anyReady && <StatusDot tone={st.tone === "neutral" ? "danger" : st.tone} />}
          </span>
        ),
      }
    })
  })()

  const accountOptions = ((): ReadonlyArray<SelectOption<string>> => {
    const accounts = (statuses.value ?? []).filter((s) => s.kind === bot.harness.kind)
    const options: Array<SelectOption<string>> = accounts.map((s) => ({
      value: statusProfileId(s),
      label: (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {/* the pane is narrow: the nickname or email; the full "email (plan)" is the tooltip */}
          <span className="truncate" title={accountChoiceLabel(s)}>{accountNickname(s) ?? s.account?.email ?? accountChoiceLabel(s)}</span>
          {!harnessReady(s) && <StatusDot tone={harnessState(s).tone === "neutral" ? "danger" : harnessState(s).tone} />}
        </span>
      ),
    }))
    if (!accounts.some((s) => statusProfileId(s) === botProfile)) options.push({ value: botProfile, label: botProfile === "default" ? "Default account" : "Removed account" })
    return options
  })()
  const showAccount = accountOptions.length > 1 || botProfile !== "default"

  const modelList = models.value ?? []
  const selectedModel = modelList.find((m) => m.id === bot.harness.model) ?? modelList.find((m) => m.default)
  const modelOptions: ReadonlyArray<SelectOption<string>> = [
    { value: DEFAULT, label: modelList.find((m) => m.default) ? `Default (${modelList.find((m) => m.default)!.label})` : "Default" },
    ...modelList.map((m) => ({ value: m.id, label: m.label || m.id })),
    ...(bot.harness.model && !modelList.some((m) => m.id === bot.harness.model) ? [{ value: bot.harness.model, label: bot.harness.model }] : []),
  ]
  const efforts = selectedModel?.efforts ?? []

  const setHarness = (patch: Partial<BotHarness>) => {
    const next: { -readonly [K in keyof BotHarness]: BotHarness[K] } = { ...bot.harness, ...patch }
    for (const k of ["model", "effort"] as const) if (next[k] === undefined || next[k] === DEFAULT) delete next[k]
    return update.run({ botId: bot.id, patch: { harness: next } })
  }

  const nodeOptions: ReadonlyArray<SelectOption<string>> = (nodes.some((n) => n.id === bot.hostNodeId) ? nodes : [...nodes, undefined]).map((n) =>
    n
      ? {
          value: n.id,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={nodeTone(n)} />
              {n.kind === "local" ? "This server" : n.label}
            </span>
          ),
        }
      : { value: bot.hostNodeId, label: bot.hostNodeId },
  )
  const others = nodes.filter((n) => n.id !== bot.hostNodeId)
  const bound = new Set<string>(bot.boundNodeIds)
  const toggleBound = (id: NodeId) => {
    const next = bound.has(id) ? bot.boundNodeIds.filter((x) => x !== id) : [...bot.boundNodeIds, id]
    void update.run({ botId: bot.id, patch: { boundNodeIds: next } })
  }

  return (
    <Section title="Brain" id="details-brain">
      <SectionSheet>
        <SheetLine label="Harness">
          <Select label="Harness" value={bot.harness.kind} options={harnessOptions} onValueChange={(kind) => kind !== bot.harness.kind && setSwitchTo({ kind, profileId: accountFor(kind) })} />
        </SheetLine>
        {showAccount && (
          <SheetLine label="Account">
            <Select
              label="Account"
              value={botProfile}
              options={accountOptions}
              className="max-w-[190px]"
              onValueChange={(profileId) => profileId !== botProfile && setSwitchTo({ kind: bot.harness.kind, profileId })}
            />
          </SheetLine>
        )}
        <SheetLine label="Model">
          <Select
            label="Model"
            value={bot.harness.model ?? DEFAULT}
            options={modelOptions}
            disabled={models.loading && modelList.length === 0}
            onValueChange={(model) => void setHarness({ model, effort: undefined })}
            className="max-w-[170px]"
          />
        </SheetLine>
        {efforts.length > 0 && (
          <SheetLine label="Effort">
            <Select
              label="Effort"
              value={bot.harness.effort ?? DEFAULT}
              options={[{ value: DEFAULT, label: "Default" }, ...efforts.map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) }))]}
              onValueChange={(effort) => void setHarness({ effort })}
            />
          </SheetLine>
        )}
        <SheetLine label="Runs on">
          <Select label="Runs on" value={bot.hostNodeId} options={nodeOptions} onValueChange={(id) => void update.run({ botId: bot.id, patch: { hostNodeId: id as NodeId } })} className="max-w-[170px]" />
        </SheetLine>
        {others.length > 0 && (
          <SheetLine label="Also reaches" hint="Other computers its tools may use">
            <Menu
              label="Also reaches"
              align="end"
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg ps-2.5 pe-1.5 text-sm text-fg hairline border-line-tertiary transition-colors hover:bg-hover aria-expanded:bg-hover"
                >
                  {bound.size === 0 ? "None" : bound.size === 1 ? (others.find((n) => bound.has(n.id))?.label ?? "1 computer") : `${bound.size} computers`}
                  <Icon icon={ChevronDown} size="sm" className="text-icon-secondary" />
                </button>
              )}
            >
              <MenuLabel>Computers</MenuLabel>
              {others.map((n) => (
                <MenuItem key={n.id} checked={bound.has(n.id)} leading={<StatusDot tone={nodeTone(n)} className="mx-1" />} onSelect={() => toggleBound(n.id)}>
                  {n.label}
                </MenuItem>
              ))}
            </Menu>
          </SheetLine>
        )}
        <SheetLine label="Autonomy">
          <AutonomySelect value={bot.autonomy} onValueChange={(autonomy) => autonomy !== bot.autonomy && void update.run({ botId: bot.id, patch: { autonomy } })} />
        </SheetLine>
      </SectionSheet>
      <p className="px-3 text-xs text-fg-tertiary" data-testid="autonomy-hint">
        {autonomyChoice(bot.autonomy).hint}{" "}
        <button type="button" className="underline-offset-2 hover:text-fg-secondary hover:underline" onClick={() => settings.show("permissions")}>
          Edit rules
        </button>
      </p>
      {bot.autonomy === "full" && <FullAutoWarning name={bot.name} />}
      <div className="flex flex-col gap-1.5 px-3" data-testid="bot-project-folders">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-fg">Project folders</span>
          <span className="text-xs text-fg-tertiary">count as its workspace</span>
        </div>
        <FolderListEditor
          folders={bot.projectFolders}
          pending={foldersUpdate.pending}
          placeholder="/home/me/projects/app"
          emptyText={shared.length === 0 ? "None: it works in its own workspace." : `None of its own; shared: ${shared.join(", ")}`}
          onChange={async (projectFolders) => (await foldersUpdate.run({ botId: bot.id, patch: { projectFolders } })).ok}
        />
        {shared.length > 0 && bot.projectFolders.length > 0 && <p className="text-2xs text-fg-quaternary">Also shared with every Bot: {shared.join(", ")}</p>}
        {foldersUpdate.error && <ErrorLine className="px-0">{foldersUpdate.error}</ErrorLine>}
      </div>
      {current && !ready && (
        <div className={cn("flex items-center gap-2 rounded-xl px-3 py-2 text-sm", "bg-warn-soft text-warn-fg")}>
          <span className="min-w-0 flex-1">
            {current.installed ? `${choiceName(bot.harness.kind, botProfile)} needs you to sign in on the server.` : `${harnessName(current.kind, current)} isn't installed on the server.`}
          </span>
          <button type="button" className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => settings.show("harnesses")}>
            Fix
          </button>
        </div>
      )}
      {update.error && <ErrorLine>{update.error}</ErrorLine>}
      <p className="px-3 text-2xs text-fg-quaternary">Model and effort apply from the next turn. Changing the harness, account or computer starts a new session; memory and files stay.</p>
      <ConfirmDialog
        open={switchTo !== undefined}
        title={`Switch to ${switchTo ? choiceName(switchTo.kind, switchTo.profileId) : ""}?`}
        body={`${bot.name} starts a new session on the next message. Instructions, memory and files stay.${switchTo && !harnessReady(statusOf(switchTo.kind, switchTo.profileId)) ? " This account isn't ready on the server yet." : ""}`}
        confirmLabel="Switch"
        pending={update.pending}
        error={update.error}
        onCancel={() => setSwitchTo(undefined)}
        onConfirm={async () => {
          if (!switchTo) return
          // Another account of the same harness keeps the model and effort; another harness starts fresh.
          const sameKind = switchTo.kind === bot.harness.kind
          const harness: BotHarness = {
            kind: switchTo.kind,
            ...(switchTo.profileId !== "default" ? { profileId: switchTo.profileId } : {}),
            ...(sameKind && bot.harness.model ? { model: bot.harness.model } : {}),
            ...(sameKind && bot.harness.effort ? { effort: bot.harness.effort } : {}),
          }
          const r = await update.run({ botId: bot.id, patch: { harness } })
          if (r.ok) setSwitchTo(undefined)
        }}
      />
    </Section>
  )
}
