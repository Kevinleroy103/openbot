// Settings › Computers (grok-bot-ui-activity.md F.10.3, OpenBot original): the nodes (hands), their
// status and capabilities, capability approval, rename, remove, and pairing a new computer
// (nodes.createPairingCode → code + ready-to-paste command; the new node then appears for approval).
import { useAtomValue } from "@effect/atom-react"
import { botsAtom, nodesAtom } from "@openbot/client"
import type { Bot, NodeSummary } from "@openbot/contracts"
import {
  Avatar,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Icon,
  LabelChip,
  Menu,
  MenuItem,
  MenuSeparator,
  PillButton,
  Spinner,
  StatusPill,
  Switch,
  cn,
} from "@openbot/ui"
import {
  Check,
  ChevronDown,
  Ellipsis,
  Laptop,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { nodeDesktopState, nodeScreenState } from "../computer/desktop.ts"
import { DesktopSetupNote } from "../computer/DesktopSetupNote.tsx"
import { ScreenPermissionsNote } from "../computer/ScreenPermissionsNote.tsx"
import { InlineEdit } from "../details/InlineEdit.tsx"
import {
  CommandBlock,
  ConfirmDialog,
  ErrorLine,
  capabilityInfo,
  capabilityName,
  formatAgo,
  useCommand,
  useRosterValue,
} from "../details/kit.tsx"
import { GroupLabel, PageHeader, SettingsCard } from "./layout.tsx"
import { AsyncResult } from "effect/reactivity"

/** Capabilities the node declared but the owner has not approved yet. */
const unapproved = (n: NodeSummary): ReadonlyArray<string> =>
  n.declaredCapabilities.filter((c) => !n.capabilities.includes(c))

export function ComputersPage(): ReactNode {
  const nodesResult = useAtomValue(nodesAtom)
  const nodes = AsyncResult.isSuccess(nodesResult) ? nodesResult.value : []
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const [pairing, setPairing] = useState(false)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Computers"
        description="Your Bots think on this server and work on these computers. Each one dials in to OpenBot, so it can sit behind NAT."
        actions={
          <PillButton
            variant="primary"
            size="card"
            leadingIcon={Plus}
            onClick={() => setPairing(true)}
            data-testid="pair-computer"
          >
            Pair a computer
          </PillButton>
        }
      />
      <GroupLabel>Connected computers</GroupLabel>
      <SettingsCard testId="nodes-list">
        {!AsyncResult.isSuccess(nodesResult) ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-tertiary">
            <Spinner size={14} /> Loading…
          </div>
        ) : nodes.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-fg-secondary">
            No computers yet. Pair one to give your Bots hands.
          </p>
        ) : (
          nodes.map((n, i) => (
            <div key={n.id} className={cn(i > 0 && "border-t-[0.5px] border-line-tertiary")}>
              <NodeRow
                node={n}
                bots={bots}
                expanded={expanded === n.id}
                onToggle={() => setExpanded(expanded === n.id ? undefined : n.id)}
              />
            </div>
          ))
        )}
      </SettingsCard>
      <p className="mt-3 px-1 text-2xs text-fg-quaternary">
        Each computer also enforces its own limits: allowed folders, a deny-list and an approval ceiling that OpenBot
        cannot raise.
      </p>
      {pairing && <PairDialog knownIds={nodes.map((n) => n.id)} onClose={() => setPairing(false)} />}
    </div>
  )
}

function statusPill(n: NodeSummary): ReactNode {
  if (unapproved(n).length > 0 && n.capabilities.length === 0)
    return (
      <StatusPill tone="warn" className="h-[22px] text-xs">
        Needs approval
      </StatusPill>
    )
  if (n.status === "online")
    return (
      <StatusPill tone="success" dot className="h-[22px] text-xs">
        Online
      </StatusPill>
    )
  if (n.status === "degraded")
    return (
      <StatusPill tone="warn" className="h-[22px] text-xs">
        {n.lastSeenAt ? `Last seen ${formatAgo(n.lastSeenAt)}` : "Degraded"}
      </StatusPill>
    )
  return (
    <StatusPill tone="neutral" className="h-[22px] text-xs">
      {n.lastSeenAt ? `Offline · ${formatAgo(n.lastSeenAt)}` : "Offline"}
    </StatusPill>
  )
}

function NodeRow({
  node,
  bots,
  expanded,
  onToggle,
}: {
  readonly node: NodeSummary
  readonly bots: ReadonlyArray<Bot>
  readonly expanded: boolean
  readonly onToggle: () => void
}): ReactNode {
  const rename = useCommand("nodes.rename", node.id)
  const revoke = useCommand("nodes.revoke", node.id)
  const [renaming, setRenaming] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const pendingCaps = unapproved(node)
  const using = bots.filter((b) => b.hostNodeId === node.id || b.boundNodeIds.includes(node.id))
  const desc = [node.platform, node.hostname, node.version ? `node ${node.version}` : undefined]
    .filter(Boolean)
    .join(" · ")
  return (
    <div className="flex flex-col" data-testid="node-row">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-icon">
          <Icon icon={node.kind === "local" ? Server : Laptop} size="md" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col items-start">
          <div className="flex max-w-full items-center gap-1.5">
            {renaming ? (
              <InlineEdit
                value={node.label}
                placeholder="Name"
                label="Computer name"
                startEditing
                onEditEnd={() => setRenaming(false)}
                className="text-start text-base font-medium text-fg"
                onSave={(label) => rename.run({ nodeId: node.id, label })}
              />
            ) : (
              <span className="truncate text-base font-medium text-fg">{node.label}</span>
            )}
            {node.kind === "local" && <LabelChip>Brain</LabelChip>}
            {nodeDesktopState(node) === "on" && (
              <LabelChip className="gap-0.5 max-sm:hidden">
                <Icon icon={Monitor} size="xs" />
                Desktop
              </LabelChip>
            )}
            {nodeScreenState(node) === "on" && (
              <LabelChip className="gap-0.5 max-sm:hidden">
                <Icon icon={Monitor} size="xs" />
                Screen
              </LabelChip>
            )}
          </div>
          <span className="max-w-full truncate text-sm text-fg-secondary">{desc}</span>
        </div>
        {pendingCaps.length > 0 && node.capabilities.length > 0 && (
          <button
            type="button"
            onClick={onToggle}
            className="shrink-0 text-xs font-medium text-warn-fg hover:underline"
          >
            {pendingCaps.length} to approve
          </button>
        )}
        {statusPill(node)}
        <button
          type="button"
          aria-label={expanded ? "Hide details" : "Show details"}
          aria-expanded={expanded}
          onClick={onToggle}
          className="inline-flex size-7 items-center justify-center rounded-full text-icon-secondary hover:bg-secondary"
        >
          <Icon
            icon={ChevronDown}
            size="sm"
            className={cn("transition-transform duration-200", expanded && "rotate-180")}
          />
        </button>
        <Menu
          label={`${node.label} actions`}
          align="end"
          trigger={(p) => (
            <button
              {...p}
              type="button"
              aria-label={`${node.label} actions`}
              className="inline-flex size-7 items-center justify-center rounded-full text-icon-secondary hover:bg-secondary aria-expanded:bg-secondary"
            >
              <Icon icon={Ellipsis} size="sm" />
            </button>
          )}
        >
          <MenuItem icon={Pencil} onSelect={() => setRenaming(true)}>
            Rename
          </MenuItem>
          <MenuItem icon={ShieldCheck} onSelect={() => !expanded && onToggle()}>
            Capabilities…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger disabled={node.kind === "local"} onSelect={() => setConfirmRemove(true)}>
            Remove
          </MenuItem>
        </Menu>
      </div>
      {(rename.error ?? revoke.error) && <ErrorLine className="px-4">{rename.error ?? revoke.error}</ErrorLine>}
      {expanded && (
        <div className="flex min-w-0 flex-col gap-4 px-4 pt-1 pb-4 sm:ps-[60px]">
          <CapabilityEditor node={node} />
          <NodeDesktop node={node} />
          {node.roots.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-secondary">Allowed folders</span>
              <div className="flex flex-wrap gap-1">
                {node.roots.map((r) => (
                  <code key={r} className="rounded-sm bg-secondary px-1.5 py-px font-mono text-2xs text-fg-secondary">
                    {r}
                  </code>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-secondary">Bots using this computer</span>
            {using.length === 0 ? (
              <span className="text-sm text-fg-tertiary">None</span>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {using.map((b) => (
                  <span key={b.id} className="inline-flex items-center gap-1.5 text-sm text-fg">
                    <Avatar shape={b.avatar.shape} color={b.avatar.color} size={20} />
                    {b.name}
                    {b.hostNodeId !== node.id && <span className="text-xs text-fg-tertiary">(also reaches)</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${node.label}?`}
        body="Its key is revoked and it disconnects at once. Bots that run there move back to this server on their next session."
        confirmLabel="Remove"
        danger
        pending={revoke.pending}
        error={revoke.error}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          const r = await revoke.run({ nodeId: node.id })
          if (r.ok) setConfirmRemove(false)
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------------------------- desktops

/** Settings › Computers › a node: whether its Bots get full desktops, and what to install if not. */
function NodeDesktop({ node }: { readonly node: NodeSummary }): ReactNode {
  const state = nodeDesktopState(node)
  const screen = nodeScreenState(node)
  // a Mac shares its own screen instead of giving desktops
  if (screen !== "off" && state === "off") {
    return (
      <div className="flex min-w-0 flex-col gap-1.5" data-testid="node-screen" data-screen={screen}>
        <span className="text-xs text-fg-secondary">This Mac's screen</span>
        {screen === "unapproved" ? (
          <span className="text-sm text-fg-secondary">Turn on This Mac's screen above to let Bots use it.</span>
        ) : node.screenMissing && node.screenMissing.length > 0 ? (
          <ScreenPermissionsNote missing={node.screenMissing} nodeName={node.label} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-fg">
            <Icon icon={Check} size="sm" className="text-success-fg" />
            Bots use it one at a time, while you're away from it. Watch and take over from their Computer tab.
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="node-desktop" data-desktop={state}>
      <span className="text-xs text-fg-secondary">Full desktop</span>
      {state === "on" ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-fg">
          <Icon icon={Check} size="sm" className="text-success-fg" />
          Each Bot that works here gets its own screen to watch and take over.
        </span>
      ) : state === "unapproved" ? (
        <span className="text-sm text-fg-secondary">
          This computer offers full desktops. Turn on Full desktop above to use them.
        </span>
      ) : (
        <DesktopSetupNote
          missing={node.desktopMissing ?? []}
          nodeName={node.kind === "local" ? "this server" : node.label}
          platform={node.platform}
          local={node.kind === "local"}
        />
      )}
    </div>
  )
}

/** Switch per declared capability; approved = the effective set (declared ∩ approved). */
function CapabilityEditor({
  node,
  onDone,
  confirmLabel,
}: {
  readonly node: NodeSummary
  readonly onDone?: () => void
  readonly confirmLabel?: string
}): ReactNode {
  const set = useCommand("nodes.setCapabilities", node.id)
  // first approval defaults to everything the node declared; afterwards the effective set
  const initial = () => new Set(node.capabilities.length > 0 ? node.capabilities : node.declaredCapabilities)
  const [draft, setDraft] = useState<ReadonlySet<string>>(initial)
  const [seen, setSeen] = useState({ caps: node.capabilities, declared: node.declaredCapabilities })
  if (seen.caps !== node.capabilities || seen.declared !== node.declaredCapabilities) {
    setSeen({ caps: node.capabilities, declared: node.declaredCapabilities })
    setDraft(initial())
  }
  const dirty = draft.size !== node.capabilities.length || node.capabilities.some((c) => !draft.has(c))
  const declared = [...new Set([...node.declaredCapabilities, ...node.capabilities])].sort((a, b) =>
    capabilityName(a).localeCompare(capabilityName(b)),
  )
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-fg-secondary">Capabilities</span>
      {declared.length === 0 ? (
        <span className="text-sm text-fg-tertiary">This computer hasn't said what it can do yet.</span>
      ) : (
        <div className="flex flex-col rounded-xl bg-chrome hairline border-line-tertiary">
          {declared.map((cap, i) => {
            const info = capabilityInfo(cap)
            return (
              <label
                key={cap}
                className={cn(
                  "flex min-h-[52px] cursor-pointer items-center gap-3 px-3 py-2",
                  i > 0 && "border-t-[0.5px] border-line-tertiary",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-fg">
                    {info.title} <span className="font-mono text-2xs text-fg-quaternary">{cap}</span>
                  </span>
                  <span className="text-xs text-fg-secondary">{info.description}</span>
                </div>
                <Switch
                  checked={draft.has(cap)}
                  label={info.title}
                  onCheckedChange={(on) =>
                    setDraft((d) => {
                      const next = new Set(d)
                      if (on) next.add(cap)
                      else next.delete(cap)
                      return next
                    })
                  }
                />
              </label>
            )
          })}
        </div>
      )}
      {set.error && <ErrorLine className="px-0">{set.error}</ErrorLine>}
      {(dirty || onDone) && declared.length > 0 && (
        <div className="flex justify-end gap-2">
          <PillButton
            size="md"
            variant="primary"
            loading={set.pending}
            onClick={async () => {
              const r = await set.run({ nodeId: node.id, approved: [...draft] })
              if (r.ok) onDone?.()
            }}
          >
            {confirmLabel ?? (node.capabilities.length === 0 ? "Approve" : "Save capabilities")}
          </PillButton>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------- pairing

function useCountdown(until: number | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === undefined) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [until])
  if (until === undefined) return undefined
  const s = Math.max(0, Math.round((until - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function PairDialog({
  knownIds,
  onClose,
}: {
  readonly knownIds: ReadonlyArray<string>
  readonly onClose: () => void
}): ReactNode {
  const create = useCommand("nodes.createPairingCode")
  const nodes = useRosterValue<ReadonlyArray<NodeSummary>>(nodesAtom, [])
  const known = useRef(new Set(knownIds))
  const [code, setCode] = useState<{ code: string; expiresAt: number; command: string } | undefined>(undefined)
  const newCode = async () => {
    const r = await create.run(undefined as never)
    if (r.ok) setCode(r.value)
  }
  useEffect(() => {
    void newCode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const left = useCountdown(code?.expiresAt)
  // the server serves the installer: the command downloads, pairs and starts the node
  const installs = code?.command.startsWith("curl ") ?? false
  const expired = code !== undefined && code.expiresAt <= Date.now() && left === "0:00"
  const arrived = useMemo(() => nodes.find((n) => !known.current.has(n.id)), [nodes])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={560} label="Pair a computer">
      {arrived ? (
        <>
          <DialogHeader
            title={`Approve ${arrived.label}?`}
            description="It paired with OpenBot. Choose what your Bots may do on it."
            onClose={onClose}
          />
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col rounded-xl bg-elevated hairline border-line-secondary">
              {[
                ["Name", arrived.label],
                ["Computer", `${arrived.hostname} · ${arrived.platform}`],
                ["Node version", arrived.version ?? "Unknown"],
                ["Allowed folders", arrived.roots.join(", ") || "Default"],
              ].map(([k, v], i) => (
                <div
                  key={k}
                  className={cn(
                    "flex min-h-9 items-center gap-3 px-3 text-sm",
                    i > 0 && "border-t-[0.5px] border-line-tertiary",
                  )}
                >
                  <span className="w-32 shrink-0 text-fg">{k}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-secondary">{v}</span>
                </div>
              ))}
            </div>
            {/* the brain may pre-approve a fresh node's first declaration (brain-nodes
                `autoApproveFirstHello`): the owner still confirms the set here */}
            <CapabilityEditor node={arrived} onDone={onClose} confirmLabel="Approve" />
          </DialogBody>
          <DialogFooter>
            <PillButton variant="ghost" size="card" onClick={onClose}>
              Later
            </PillButton>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogHeader
            title="Pair a computer"
            description="Give your Bots hands on another machine: a laptop, a VPS or a container."
            onClose={onClose}
          />
          <DialogBody className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <span className="text-sm text-fg">1. On that computer, run</span>
              {code ? (
                <CommandBlock command={code.command} />
              ) : (
                <div className="h-9 animate-pulse rounded-lg bg-quaternary" />
              )}
              <span className="text-xs text-fg-tertiary">
                {installs ? (
                  "Linux or macOS. It installs the OpenBot node, pairs it and keeps it running. That computer needs to reach this server."
                ) : (
                  <>
                    It needs the OpenBot node daemon (<code className="font-mono">openbot-node</code>) and network
                    access to this server.
                  </>
                )}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm text-fg">
                {installs ? "2. The code it pairs with" : "2. Or enter this code when it asks"}
              </span>
              <div
                className="flex h-16 items-center justify-center rounded-2xl bg-secondary"
                data-testid="pairing-code"
              >
                {code ? (
                  <span
                    className={cn(
                      "text-3xl font-medium tracking-[.12em] tabular-nums",
                      expired ? "text-fg-quaternary line-through" : "text-fg",
                    )}
                  >
                    {code.code}
                  </span>
                ) : create.error ? (
                  <span className="text-sm text-danger-fg">{create.error}</span>
                ) : (
                  <Spinner size={16} />
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-fg-secondary">
                <span>{code ? (expired ? "This code expired." : `Single use · expires in ${left}`) : " "}</span>
                <button
                  type="button"
                  onClick={() => void newCode()}
                  className="ms-auto inline-flex items-center gap-1 text-fg-secondary hover:text-fg"
                >
                  <Icon icon={RefreshCw} size="xs" />
                  New code
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-fg-secondary">
              <Spinner size={14} />
              Waiting for the computer to connect…
            </div>
          </DialogBody>
          <DialogFooter>
            <PillButton variant="secondary" size="card" onClick={onClose}>
              Done
            </PillButton>
          </DialogFooter>
        </>
      )}
    </Dialog>
  )
}
