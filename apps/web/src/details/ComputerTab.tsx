// Details › Computer: where the bot runs (host node + status), its live screen thumbnail (opens the
// full-screen ComputerView) and a terminal in its workspace.
import { useAtomSet } from "@effect/atom-react"
import { nodesAtom } from "@openbot/client"
import type { Bot, NodeSummary } from "@openbot/contracts"
import { PillButton, StatusPill } from "@openbot/ui"
import { SquareTerminal } from "lucide-react"
import type { ReactNode } from "react"
import { computerInitialTabAtom } from "../computer/useComputer.ts"
import { ScreenThumbnail } from "../computer/ScreenThumbnail.tsx"
import { useComputerView, useSettingsDialog } from "../contracts.ts"
import { Section, SectionSheet, SheetLine, StatusDot, capabilityName, formatAgo, nodeTone, useRosterValue } from "./kit.tsx"

export function ComputerTab({ bot }: { readonly bot: Bot }): ReactNode {
  const nodes = useRosterValue<ReadonlyArray<NodeSummary>>(nodesAtom, [])
  const node = nodes.find((n) => n.id === bot.hostNodeId)
  const view = useComputerView()
  const settings = useSettingsDialog()
  const setInitialTab = useAtomSet(computerInitialTabAtom)
  const caps = new Set((node?.capabilities ?? []).map(capabilityName))
  const hasTerminal = caps.has("pty")
  const nodeLabel = node ? (node.kind === "local" ? "this server" : node.label) : undefined

  const open = (tab: "screen" | "terminal") => {
    setInitialTab(tab)
    view.open(bot.id)
  }

  return (
    <div className="flex flex-col gap-6">
      <ScreenThumbnail botId={bot.id} botName={bot.name} nodeLabel={nodeLabel} onOpen={() => open("screen")} className="pt-1" />
      <Section title="Computer">
        <SectionSheet>
          <SheetLine label={node ? (node.kind === "local" ? "This server" : node.label) : bot.hostNodeId} hint={node ? `${node.hostname} · ${node.platform}` : "Unknown computer"}>
            <StatusPill tone={nodeTone(node)} dot className="h-[22px] text-xs">
              {node?.status === "online" ? "Online" : node?.status === "degraded" ? "Degraded" : node?.lastSeenAt ? `Offline · ${formatAgo(node.lastSeenAt)}` : "Offline"}
            </StatusPill>
          </SheetLine>
          {node && (
            <SheetLine label="Can use">
              <span className="flex min-w-0 flex-wrap justify-end gap-1">
                {[...caps].slice(0, 5).map((c) => (
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
        <div className="flex items-center gap-2 px-1">
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
          <button type="button" className="ms-auto px-2 text-sm text-fg-secondary transition-colors hover:text-fg" onClick={() => settings.show("computers")}>
            Manage computers
          </button>
        </div>
      </Section>
    </div>
  )
}
