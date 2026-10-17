// Settings › Permissions (D5.6; Grok "Auto-review Rules", grok-bot-ui.md §4.11): approval rules as
// "When ‹bot / any Bot› wants to ‹surface + match› → It should ‹Ask first / Allow / Never allow›".
// "Ask first" beats "Allow automatically"; nodes enforce their own ceiling on top. Without a matching
// rule, each Bot's autonomy decides (Ask first / Auto in workspace / Full auto), editable here too,
// with the default for new Bots and the shared project folders (count as every Bot's workspace).
import { botsAtom, rulesAtom } from "@openbot/client"
import type { ApprovalAction, ApprovalRule, ApprovalRuleInput, ApprovalSurface, Bot, BotId } from "@openbot/contracts"
import { Avatar, IconButton, PillButton, Select, TextField, cn } from "@openbot/ui"
import { Trash2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { AUTONOMY_CHOICES, AutonomySelect, FolderListEditor } from "../details/autonomy.tsx"
import { ErrorLine, LoadingLine, useCommand, useQuery, useRosterValue } from "../details/kit.tsx"
import { useSettingsEditor } from "./GeneralPage.tsx"
import { GroupLabel, PageHeader, SettingsCard, SettingsRow } from "./layout.tsx"

const ANY = "__any__"

export const SURFACES: ReadonlyArray<{ value: ApprovalSurface; label: string; match: "commandPrefix" | "pathPrefix" | "toolName"; placeholder: string }> = [
  { value: "shell", label: "Run commands", match: "commandPrefix", placeholder: "starting with… e.g. git status" },
  { value: "file-edit", label: "Edit files", match: "pathPrefix", placeholder: "under… e.g. /home/me/project" },
  { value: "file-read", label: "Read files", match: "pathPrefix", placeholder: "under… e.g. /home/me/notes" },
  { value: "mcp", label: "Use MCP tools", match: "toolName", placeholder: "tool name (optional)" },
  { value: "browser", label: "Use the browser", match: "toolName", placeholder: "tool name (optional)" },
  { value: "computer", label: "Control the computer", match: "toolName", placeholder: "tool name (optional)" },
  { value: "network", label: "Use the network", match: "toolName", placeholder: "tool name (optional)" },
  { value: "skills", label: "Change Bots' skills", match: "toolName", placeholder: "tool name (optional)" },
  { value: "other", label: "Use other tools", match: "toolName", placeholder: "tool name, e.g. WebFetch" },
]

const ACTIONS: ReadonlyArray<{ value: ApprovalAction; label: string }> = [
  { value: "ask", label: "Ask first" },
  { value: "allow", label: "Allow automatically" },
  { value: "deny", label: "Never allow" },
]

const surfaceInfo = (s: ApprovalSurface) => SURFACES.find((x) => x.value === s) ?? SURFACES[SURFACES.length - 1]!

/** "Run commands starting with `git status`". */
export const describeRule = (rule: Pick<ApprovalRule, "surface" | "match">): ReactNode => {
  const info = surfaceInfo(rule.surface)
  const m = rule.match
  const detail = m.commandPrefix ? ["starting with", m.commandPrefix] : m.pathPrefix ? ["under", m.pathPrefix] : m.toolName ? ["named", m.toolName] : undefined
  return (
    <>
      {info.label}
      {detail && (
        <>
          {" "}
          {detail[0]} <code className="rounded-sm bg-secondary px-1 py-px font-mono text-xs wrap-anywhere text-fg">{detail[1]}</code>
        </>
      )}
    </>
  )
}

export function PermissionsPage(): ReactNode {
  const rules = useQuery(rulesAtom("*"))
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const upsert = useCommand("rules.upsert", "new")
  const [botId, setBotId] = useState<string>(ANY)
  const [surface, setSurface] = useState<ApprovalSurface>("shell")
  const [match, setMatch] = useState("")
  const [action, setAction] = useState<ApprovalAction>("ask")
  const info = surfaceInfo(surface)

  const add = async () => {
    const rule: ApprovalRuleInput = {
      surface,
      action,
      match: match.trim() ? { [info.match]: match.trim() } : {},
      ...(botId !== ANY ? { botId: botId as BotId } : {}),
    }
    const r = await upsert.run({ rule })
    if (r.ok) setMatch("")
  }

  const editor = useSettingsEditor()
  const sharedUpdate = useCommand("settings.update", "shared-project-folders")
  const botOptions = [{ value: ANY, label: "Any Bot" }, ...bots.map((b) => ({ value: b.id as string, label: b.name }))]
  const list = [...(rules.value ?? [])].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Permissions"
        description="Rules decide first: a Bot’s own rules before Any Bot rules, and “Never allow” over “Ask first” over “Allow automatically”. Anything no rule covers is up to the Bot’s autonomy."
      />

      <GroupLabel>Autonomy</GroupLabel>
      <SettingsCard testId="autonomy-card">
        <ul className="flex flex-col gap-1 border-b-[0.5px] border-line-tertiary px-4 py-3 text-sm text-fg-secondary" data-testid="autonomy-explainer">
          {AUTONOMY_CHOICES.map((c) => (
            <li key={c.value}>
              <span className="text-fg">{c.label}</span> — {c.hint}
            </li>
          ))}
        </ul>
        <SettingsRow
          className="border-b-[0.5px] border-line-tertiary"
          title="Default for new Bots"
          description="Preselected in New Bot; Bots that create Bots never pass on more than their own."
          control={
            <div data-testid="default-autonomy">
              <AutonomySelect
                label="Default for new Bots"
                value={editor.settings.defaultAutonomy}
                align="end"
                onValueChange={(defaultAutonomy) => void editor.patch({ defaultAutonomy })}
              />
            </div>
          }
        />
        {bots.length === 0 ? (
          <p className="px-4 py-3 text-sm text-fg-secondary">No Bots yet.</p>
        ) : (
          bots.map((bot) => <AutonomyRow key={bot.id} bot={bot} />)
        )}
      </SettingsCard>
      {editor.error && <ErrorLine className="mt-2 px-1">{editor.error}</ErrorLine>}

      <GroupLabel>Shared project folders</GroupLabel>
      <SettingsCard testId="shared-project-folders">
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-sm text-fg-secondary">
            Folders that count as every Bot’s workspace, e.g. <code className="font-mono text-xs">~/projects</code> (paths on the computer the Bot runs on). With “Auto in workspace” Bots work there without asking; on this server their tools may reach them too. Add folders for one Bot in its Details › Brain.
          </p>
          <FolderListEditor
            folders={editor.settings.sharedProjectFolders}
            pending={sharedUpdate.pending}
            emptyText="No shared folders: each Bot works in its own workspace."
            onChange={async (sharedProjectFolders) => (await sharedUpdate.run({ patch: { sharedProjectFolders } })).ok}
          />
          {sharedUpdate.error && <ErrorLine className="px-0">{sharedUpdate.error}</ErrorLine>}
        </div>
      </SettingsCard>

      <GroupLabel>New rule</GroupLabel>
      <SettingsCard testId="rule-form">
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
            <span className="text-fg-secondary">When</span>
            <Select label="Which Bot" value={botId} options={botOptions} onValueChange={setBotId} align="start" />
            <span className="text-fg-secondary">wants to</span>
            <Select label="Action" value={surface} options={SURFACES.map((s) => ({ value: s.value, label: s.label }))} onValueChange={setSurface} align="start" />
          </div>
          <TextField aria-label="Match" value={match} onChange={(e) => setMatch(e.target.value)} placeholder={info.placeholder} className={cn(info.match !== "toolName" && "font-mono text-sm")} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-secondary">It should</span>
            <Select label="It should" value={action} options={ACTIONS} onValueChange={setAction} align="start" />
            <PillButton variant="primary" size="md" className="ms-auto" loading={upsert.pending} onClick={() => void add()} data-testid="add-rule">
              Add Rule
            </PillButton>
          </div>
          {upsert.error && <ErrorLine className="px-0">{upsert.error}</ErrorLine>}
        </div>
      </SettingsCard>

      <GroupLabel>Rules</GroupLabel>
      <SettingsCard testId="rules-table">
        <div className="grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_160px_32px] items-center gap-3 border-b-[0.5px] border-line-tertiary px-4 py-2 text-xs text-fg-secondary max-sm:hidden">
          <span>Bot</span>
          <span>Action</span>
          <span>Behavior</span>
          <span />
        </div>
        {rules.loading ? (
          <LoadingLine />
        ) : rules.error && !rules.value ? (
          <ErrorLine onRetry={rules.refresh}>{rules.error}</ErrorLine>
        ) : list.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-fg-secondary">No rules yet. Bots ask before anything risky; answer “Always allow” on a card to add one.</p>
        ) : (
          list.map((rule) => <RuleRow key={rule.id} rule={rule} bot={rule.botId ? bots.find((b) => b.id === rule.botId) : undefined} />)
        )}
      </SettingsCard>
      <p className="mt-3 px-1 text-2xs text-fg-quaternary">These rules apply to every harness. Each computer also enforces its own limits on top.</p>
    </div>
  )
}

function AutonomyRow({ bot }: { readonly bot: Bot }): ReactNode {
  const update = useCommand("bots.update", `${bot.id}/autonomy`)
  return (
    <div className="border-b-[0.5px] border-line-tertiary last:border-b-0" data-testid="autonomy-row">
      <div className="flex min-h-11 items-center gap-2 px-4 py-1.5">
        <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={16} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{bot.name}</span>
        <AutonomySelect value={bot.autonomy} disabled={update.pending} onValueChange={(autonomy) => autonomy !== bot.autonomy && void update.run({ botId: bot.id, patch: { autonomy } })} />
      </div>
      {update.error && <ErrorLine className="px-4 pb-2">{update.error}</ErrorLine>}
    </div>
  )
}

function RuleRow({ rule, bot }: { readonly rule: ApprovalRule; readonly bot: Bot | undefined }): ReactNode {
  const upsert = useCommand("rules.upsert", rule.id)
  const del = useCommand("rules.delete", rule.id)
  const save = (action: ApprovalAction) =>
    upsert.run({
      rule: { id: rule.id, surface: rule.surface, match: rule.match, action, ...(rule.botId ? { botId: rule.botId } : {}), ...(rule.note ? { note: rule.note } : {}) },
    })
  return (
    <div className="border-b-[0.5px] border-line-tertiary last:border-b-0" data-testid="rule-row">
      {/* phones: Bot · Behavior · delete on one line, the rule under it */}
      <div className="grid min-h-11 grid-cols-[minmax(110px,150px)_minmax(0,1fr)_160px_32px] items-center gap-3 px-4 py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto_auto] max-sm:gap-x-2 max-sm:gap-y-0.5 max-sm:py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
          {bot ? (
            <>
              <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={16} />
              <span className="truncate">{bot.name}</span>
            </>
          ) : rule.botId ? (
            <span className="truncate text-fg-tertiary">Deleted Bot</span>
          ) : (
            <span className="text-fg-secondary">Any Bot</span>
          )}
        </span>
        <span className="min-w-0 text-sm text-fg max-sm:order-last max-sm:col-span-3">
          {describeRule(rule)}
          {rule.origin === "always-allow" && <span className="ms-1.5 text-xs text-fg-tertiary">from a card</span>}
        </span>
        <Select label="Behavior" value={rule.action} options={ACTIONS} onValueChange={(a) => void save(a)} align="end" className="justify-self-start" />
        <IconButton icon={Trash2} label="Delete rule" size={28} iconSize="sm" onClick={() => void del.run({ ruleId: rule.id })} disabled={del.pending} />
      </div>
      {(upsert.error ?? del.error) && <ErrorLine className="px-4 pb-2">{upsert.error ?? del.error}</ErrorLine>}
    </div>
  )
}
