// New Bot form (grok-bot-ui.md §4.8 + grok-bot-ui-activity.md F.10.1-A, OpenBot original): name, label,
// harness chips (only installed + signed-in harnesses; the fake harness is always there as "Demo"),
// the account when a harness has several signed-in ones (e.g. three Claude logins), model, host node,
// autonomy (default: Settings › Permissions "Default for new Bots", "Auto in workspace" unless changed), instructions and a hash-default avatar with shuffle → bots.create.
// The shell renders it inside its own Dialog (title + close); this renders fields + footer.
import { useAtomValue } from "@effect/atom-react"
import { harnessModelsAtom, harnessStatusAtom, nodesAtom, settingsAtom } from "@openbot/client"
import type { BotAutonomy, HarnessStatus, NodeId, NodeSummary } from "@openbot/contracts"
import {
  Avatar,
  Icon,
  IconButton,
  PillButton,
  Select,
  type SelectOption,
  TextArea,
  TextField,
  cn,
  defaultBotAvatar,
} from "@openbot/ui"
import { Settings2, Shuffle } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import type { NewBotFormProps } from "../contracts.ts"
import { useSettingsDialog } from "../contracts.ts"
import { AutonomySelect, FullAutoWarning, autonomyChoice } from "../details/autonomy.tsx"
import {
  ErrorLine,
  LoadingLine,
  StatusDot,
  accountChoiceLabel,
  harnessGlyph,
  harnessName,
  harnessReady,
  newNonce,
  nodeTone,
  statusProfileId,
  useCommand,
  useQuery,
  useRosterValue,
} from "../details/kit.tsx"

const DEFAULT = "__default__"
const ORDER = ["claude", "codex", "opencode", "fake"]

export interface NewBotFormBodyProps extends NewBotFormProps {
  readonly submitLabel?: string
  /** Hide Cancel (onboarding has its own Back). */
  readonly hideCancel?: boolean
  readonly className?: string
  /** Prefill (onboarding's first Bot). */
  readonly initialName?: string
  /** Show the "Set up harnesses" links (they open Settings, which onboarding does not render). */
  readonly showSetupLinks?: boolean
}

export function NewBotForm(props: NewBotFormProps): ReactNode {
  return <NewBotFormBody {...props} />
}

export function NewBotFormBody({
  onCreated,
  onCancel,
  submitLabel = "Create Bot",
  hideCancel = false,
  className,
  initialName = "",
  showSetupLinks = true,
}: NewBotFormBodyProps): ReactNode {
  const statuses = useQuery(harnessStatusAtom)
  const settings = useAtomValue(settingsAtom)
  const nodes = useRosterValue<ReadonlyArray<NodeSummary>>(nodesAtom, [])
  const settingsDialog = useSettingsDialog()
  const create = useCommand("bots.create", "new-bot-form")

  const [nonce] = useState(newNonce)
  const [seed, setSeed] = useState(nonce)
  const avatar = defaultBotAvatar(seed)
  const [name, setName] = useState(initialName)
  const [label, setLabel] = useState("")
  const [kind, setKind] = useState<string | undefined>(undefined)
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [model, setModel] = useState(DEFAULT)
  const [effort, setEffort] = useState(DEFAULT)
  const [host, setHost] = useState<string | undefined>(undefined)
  const [instructions, setInstructions] = useState("")
  const [autonomy, setAutonomy] = useState<BotAutonomy>(settings.defaultAutonomy)

  // every ready (kind, account); one chip per kind, an Account picker when a kind has several
  const ready = useMemo(
    () =>
      [...(statuses.value ?? [])]
        .filter(harnessReady)
        .sort(
          (a, b) =>
            (ORDER.includes(a.kind) ? ORDER.indexOf(a.kind) : 9) - (ORDER.includes(b.kind) ? ORDER.indexOf(b.kind) : 9),
        ),
    [statuses.value],
  )
  const readyKinds = new Set(ready.map((s) => s.kind))
  const notReady = [
    ...new Map((statuses.value ?? []).filter((s) => !readyKinds.has(s.kind)).map((s) => [s.kind, s] as const)).values(),
  ]
  const kindChoices = [...new Map(ready.map((s) => [s.kind, s] as const)).values()]
  // fake is always offered, even before the status probe answers
  const choices: ReadonlyArray<Pick<HarnessStatus, "kind"> & Partial<HarnessStatus>> = kindChoices.some(
    (s) => s.kind === "fake",
  )
    ? kindChoices
    : [...kindChoices, { kind: "fake" }]

  // default harness: Settings default when ready, else the first real ready harness, else Demo
  const preferred =
    settings.defaultHarness && choices.some((c) => c.kind === settings.defaultHarness)
      ? settings.defaultHarness
      : (choices.find((c) => c.kind !== "fake") ?? choices[0])?.kind
  const selected = kind ?? preferred ?? "fake"
  const accounts = ready.filter((s) => s.kind === selected)
  const preferredAccount = accounts.find((s) => statusProfileId(s) === "default") ?? accounts[0]
  const selectedAccount = accounts.find((s) => statusProfileId(s) === account) ?? preferredAccount
  const profileId = selectedAccount ? statusProfileId(selectedAccount) : "default"
  const pick = (next: string) => {
    if (next === selected) return
    setKind(next)
    setAccount(undefined)
    setModel(DEFAULT)
    setEffort(DEFAULT)
  }
  const accountOptions: ReadonlyArray<SelectOption<string>> = accounts.map((s) => ({
    value: statusProfileId(s),
    label: accountChoiceLabel(s),
  }))
  const models = useQuery(harnessModelsAtom(selected, profileId))
  const modelOptions: ReadonlyArray<SelectOption<string>> = [
    {
      value: DEFAULT,
      label: (() => {
        const d = models.value?.find((m) => m.default)
        if (d === undefined) return "Default model"
        return /^default\b/i.test(d.label) ? d.label : `Default (${d.label})`
      })(),
    },
    ...(models.value ?? []).map((m) => ({ value: m.id, label: m.label || m.id })),
  ]
  // effort levels come from the chosen model (or the harness default model when "Default")
  const effectiveModel =
    model === DEFAULT ? models.value?.find((m) => m.default) : models.value?.find((m) => m.id === model)
  const efforts = effectiveModel?.efforts ?? []
  const effortOptions: ReadonlyArray<SelectOption<string>> = [
    { value: DEFAULT, label: "Default" },
    ...efforts.map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) })),
  ]
  const effortValue = efforts.includes(effort) ? effort : DEFAULT
  const nodeOptions: ReadonlyArray<SelectOption<string>> = nodes.map((n) => ({
    value: n.id,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone={nodeTone(n)} />
        {n.kind === "local" ? "This server" : n.label}
      </span>
    ),
  }))
  const hostValue = host ?? nodes.find((n) => n.kind === "local")?.id ?? nodes[0]?.id

  const submit = async () => {
    const trimmed = name.trim() || "New Bot"
    const r = await create.run({
      name: trimmed,
      ...(label.trim() ? { label: label.trim() } : {}),
      avatar,
      harness: {
        kind: selected,
        ...(profileId !== "default" ? { profileId } : {}),
        ...(model !== DEFAULT ? { model } : {}),
        ...(effortValue !== DEFAULT ? { effort: effortValue } : {}),
      },
      ...(hostValue ? { hostNodeId: hostValue as NodeId } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      autonomy,
      clientNonce: nonce,
    })
    if (r.ok) onCreated(r.value.id)
  }

  return (
    <form
      className={cn("flex min-h-0 flex-col", className)}
      data-testid="new-bot-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-2 scrollbar-thin">
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar shape={avatar.shape} color={avatar.color} size={56} idle label="New Bot's avatar" />
            <IconButton
              icon={Shuffle}
              label="Shuffle avatar"
              size={24}
              iconSize="xs"
              variant="elevated"
              className="absolute -right-1 -bottom-1"
              onClick={() => setSeed(newNonce())}
              data-testid="shuffle-avatar"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <TextField
              aria-label="Name"
              placeholder="New Bot"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              data-autofocus
              data-testid="new-bot-name"
            />
            <TextField
              aria-label="Label"
              placeholder="Add a label (e.g. Research)"
              value={label}
              maxLength={64}
              onChange={(e) => setLabel(e.target.value)}
              size="sm"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-fg-secondary">Brain</span>
            {showSetupLinks && (
              <button
                type="button"
                onClick={() => settingsDialog.show("harnesses")}
                className="inline-flex items-center gap-1 text-xs text-fg-tertiary hover:text-fg-secondary"
              >
                <Icon icon={Settings2} size="xs" />
                Set up harnesses
              </button>
            )}
          </div>
          {statuses.loading ? (
            <LoadingLine className="justify-start px-0 py-1">Checking harnesses…</LoadingLine>
          ) : (
            <div role="radiogroup" aria-label="Harness" className="flex flex-wrap gap-2">
              {choices.map((s) => {
                const on = s.kind === selected
                return (
                  <button
                    key={s.kind}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-testid={`harness-chip-${s.kind}`}
                    onClick={() => pick(s.kind)}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-full ps-2.5 pe-3 text-sm transition-colors duration-[120ms]",
                      on ? "bg-primary text-fg-inverted" : "bg-secondary text-fg hover:bg-secondary-hover",
                    )}
                  >
                    <Icon icon={harnessGlyph(s.kind)} size="sm" />
                    {harnessName(s.kind, s)}
                    {s.kind === "fake" && (
                      <span className={cn("text-xs", on ? "text-fg-inverted/70" : "text-fg-tertiary")}>offline</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {notReady.length > 0 && !statuses.loading && (
            <p className="text-xs text-fg-tertiary">
              {notReady.map((s) => harnessName(s.kind, s)).join(", ")} {notReady.length === 1 ? "isn't" : "aren't"}{" "}
              ready on the server yet.{" "}
              {showSetupLinks && (
                <button
                  type="button"
                  className="underline-offset-2 hover:text-fg-secondary hover:underline"
                  onClick={() => settingsDialog.show("harnesses")}
                >
                  Set up
                </button>
              )}
            </p>
          )}
          {accounts.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 pt-1" data-testid="new-bot-account">
              <span className="text-sm text-fg-secondary">Account</span>
              <Select
                label="Account"
                value={profileId}
                options={accountOptions}
                onValueChange={(next) => {
                  setAccount(next)
                  setModel(DEFAULT)
                  setEffort(DEFAULT)
                }}
                align="start"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-sm text-fg-secondary">Model</span>
            <Select
              label="Model"
              value={model}
              options={modelOptions}
              onValueChange={(next) => {
                setModel(next)
                setEffort(DEFAULT)
              }}
              align="start"
              disabled={models.loading}
            />
            {efforts.length > 0 && (
              <>
                <span className="ms-2 text-sm text-fg-secondary">Effort</span>
                <Select
                  label="Effort"
                  value={effortValue}
                  options={effortOptions}
                  onValueChange={setEffort}
                  align="start"
                />
              </>
            )}
            {nodeOptions.length > 1 && (
              <>
                <span className="ms-2 text-sm text-fg-secondary">Runs on</span>
                <Select
                  label="Runs on"
                  value={hostValue ?? ""}
                  options={nodeOptions}
                  onValueChange={setHost}
                  align="start"
                />
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5" data-testid="new-bot-autonomy">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg-secondary">Autonomy</span>
            <AutonomySelect value={autonomy} onValueChange={setAutonomy} align="start" />
          </div>
          <p className="text-xs text-fg-tertiary">{autonomyChoice(autonomy).hint}</p>
          {autonomy === "full" && <FullAutoWarning {...(name.trim() ? { name: name.trim() } : {})} />}
        </div>

        <TextArea
          label="Instructions"
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What's this Bot's job? e.g. Watch my inbox, draft replies and flag anything urgent."
          description="You can change this any time in the Bot's details."
          className="text-sm"
        />
        {create.error && <ErrorLine className="px-0">{create.error}</ErrorLine>}
      </div>
      <div className="flex items-center justify-end gap-2 py-3 ps-4 pe-3">
        {!hideCancel && (
          <PillButton variant="secondary" size="card" onClick={onCancel}>
            Cancel
          </PillButton>
        )}
        <PillButton type="submit" variant="primary" size="card" loading={create.pending} data-testid="create-bot">
          {submitLabel}
        </PillButton>
      </div>
    </form>
  )
}
