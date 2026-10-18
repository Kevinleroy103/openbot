// Details › Computer: the bot's live screen thumbnail (opens the full-screen ComputerView), where it
// runs (host node + status), what that computer lacks for full desktops (with install commands),
// Reset computer (`computer.reset`: stops its desktop and everything on it), and a terminal in its
// workspace.
import { useAtomSet } from "@effect/atom-react"
import { nodesAtom } from "@openbot/client"
import type { Bot, NodeSummary } from "@openbot/contracts"
import { PillButton, StatusPill } from "@openbot/ui"
import { RotateCcw, SquareTerminal } from "lucide-react"
import { type ReactNode, useState } from "react"
import { DesktopSetupNote } from "../computer/DesktopSetupNote.tsx"
import { ScreenPermissionsNote } from "../computer/ScreenPermissionsNote.tsx"
import { computerInitialTabAtom, useComputer } from "../computer/useComputer.ts"
import { ScreenThumbnail } from "../computer/ScreenThumbnail.tsx"
import { useComputerView, useSettingsDialog } from "../contracts.ts"
import { ConfirmDialog, Section, SectionSheet, SheetLine, StatusDot, capabilityName, formatAgo, nodeTone, useCommand, useRosterValue } from "./kit.tsx"

export function ComputerTab({ bot }: { readonly bot: Bot }): ReactNode {
  const nodes = useRosterValue<ReadonlyArray<NodeSummary>>(nodesAtom, [])
  const node = nodes.find((n) => n.id === bot.hostNodeId)
  const view = useComputerView()
  const settings = useSettingsDialog()
  const setInitialTab = useAtomSet(computerInitialTabAtom)
  const { status } = useComputer(bot.id)
  const reset = useCommand("computer.reset", bot.id)
  const [confirmReset, setConfirmReset] = useState(false)
  const caps = new Set((node?.capabilities ?? []).map(capabilityName))
  const hasTerminal = caps.has("pty")
  const nodeName = node ? (node.kind === "local" ? "this server" : node.label) : "its computer"
  const missing = status.value?.missing ?? []
  // a desktop to reset: the node offers desktops and the bot's is (or may be) running
  const canReset = status.value?.surface === "desktop" && status.value.state !== "unsupported"

  const open = (tab: "screen" | "terminal") => {
    setInitialTab(tab)
    view.open(bot.id)
  }

  return (
    <div className="flex flex-col gap-6">
      <ScreenThumbnail botId={bot.id} botName={bot.name} nodeLabel={node ? (node.kind === "local" ? "this server" : node.label) : undefined} onOpen={() => open("screen")} className="pt-1" />
      <Section title="Computer">
        <SectionSheet>
          <SheetLine label={node ? (node.kind === "local" ? "This server" : node.label) : bot.hostNodeId} hint={node ? `${node.hostname} · ${node.platform}` : "Unknown computer"}>
            <StatusPill tone={nodeTone(node)} dot className="h-[22px] text-xs">
              {node?.status === "online" ? "Online" : node?.status === "degraded" ? "Degraded" : node?.lastSeenAt ? `Offline · ${formatAgo(node.lastSeenAt)}` : "Offline"}
            </StatusPill>
          </SheetLine>
          {node && (
            <SheetLine label="Can use">
              <span className="flex min-w-0 max-w-[72%] flex-wrap justify-end gap-1">
                {[...caps].slice(0, 6).map((c) => (
                  <span key={c} className="rounded-sm bg-secondary px-1.5 py-px text-2xs text-fg-secondary">
                    {c}
                  </span>
                ))}
                {caps.size === 0 && <span className="text-sm text-fg-tertiary">Nothing approved</span>}
              </span>
            </SheetLine>
          )}
          {bot.boundNodeIds.length > 0 && (
            <SheetLine label="Also reaches">
              <span className="flex min-w-0 flex-col items-end gap-0.5">
                {bot.boundNodeIds.map((id) => {
                  const n = nodes.find((x) => x.id === id)
                  return (
                    <span key={id} className="inline-flex items-center gap-1.5 text-sm text-fg-secondary">
                      <StatusDot tone={nodeTone(n)} />
                      {n?.label ?? id}
                    </span>
                  )
                })}
              </span>
            </SheetLine>
          )}
        </SectionSheet>
        {missing.length > 0 && (status.value?.surface === "screen"
          ? <ScreenPermissionsNote missing={missing} nodeName={nodeName} className="px-1" />
          : <DesktopSetupNote missing={missing} nodeName={nodeName} platform={node?.platform} local={node?.kind === "local"} className="px-1" />)}
        <div className="flex flex-wrap items-center gap-2 px-1">
          <PillButton
            size="md"
            variant="secondary"
            leadingIcon={SquareTerminal}
            disabled={!hasTerminal || node?.status !== "online"}
            title={!hasTerminal ? "This computer has no terminal capability" : undefined}
            onClick={() => open("terminal")}
            data-testid="open-terminal"
          >
            Open terminal
          </PillButton>
          {canReset && (
            <PillButton size="md" variant="secondary" leadingIcon={RotateCcw} onClick={() => setConfirmReset(true)} data-testid="reset-computer">
              Reset computer
            </PillButton>
          )}
          <button type="button" className="ms-auto px-2 text-sm text-fg-secondary transition-colors hover:text-fg" onClick={() => settings.show("computers")}>
            Manage computers
          </button>
        </div>
      </Section>
      <ConfirmDialog
        open={confirmReset}
        title={`Reset ${bot.name}'s computer?`}
        body="Open apps and unsaved work on its screen are lost."
        confirmLabel="Reset"
        danger
        pending={reset.pending}
        error={reset.error}
        onCancel={() => {
          reset.clearError()
          setConfirmReset(false)
        }}
        onConfirm={async () => {
          const r = await reset.run({ botId: bot.id })
          if (r.ok) {
            setConfirmReset(false)
            status.refresh()
          }
        }}
      />
    </div>
  )
}
