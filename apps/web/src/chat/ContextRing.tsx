// Context meter with Compact / New session (OpenBot original, grok-bot-ui-activity.md F.10.4):
// a 28 px round button with a 16 px ring inside the composer; click opens a 280 px popover.
import { type ReactNode, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import type { BotId, ContextUsage } from "@openbot/contracts"
import { commandAtom } from "@openbot/client"
import { PillButton, Popover, useToast } from "@openbot/ui"
import { formatTokens } from "../app/format.ts"
import { describeFailure } from "../cards/useRespond.ts"

export interface ContextRingProps {
  readonly botId: BotId
  readonly botName: string
  readonly usage: ContextUsage
}

const toneFor = (pct: number) => (pct >= 90 ? "var(--ob-danger)" : pct >= 70 ? "var(--ob-warn)" : "var(--ob-icon-tertiary)")

/** A 16 px gauge: hairline ring with a filled pie for the used share (reads as a meter, not a spinner). */
export function Ring({ pct, size = 16 }: { readonly pct: number; readonly size?: number }): ReactNode {
  const c = size / 2
  const r = c - 1
  const inner = r - 2
  const frac = Math.max(0, Math.min(pct, 100)) / 100
  const a = frac * 2 * Math.PI
  const x = c + inner * Math.sin(a)
  const y = c - inner * Math.cos(a)
  const pie =
    frac >= 0.999 ? <circle cx={c} cy={c} r={inner} fill={toneFor(pct)} /> : frac > 0 ? <path d={`M${c} ${c}L${c} ${c - inner}A${inner} ${inner} 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`} fill={toneFor(pct)} /> : null
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={c} cy={c} r={r - 0.25} fill="none" stroke={toneFor(pct)} strokeOpacity={0.7} strokeWidth={1.5} />
      {pie}
    </svg>
  )
}

export function ContextRing({ botId, botName, usage }: ContextRingProps): ReactNode {
  const pct = usage.windowTokens > 0 ? Math.round((usage.usedTokens / usage.windowTokens) * 100) : 0
  const compact = useAtomSet(commandAtom("bots.compact", botId), { mode: "promiseExit" })
  const newSession = useAtomSet(commandAtom("bots.newSession", botId), { mode: "promiseExit" })
  const { toast } = useToast()
  const [busy, setBusy] = useState<"compact" | "new" | null>(null)
  const run = async (kind: "compact" | "new", close: () => void) => {
    setBusy(kind)
    const exit = kind === "compact" ? await compact({ botId }) : await newSession({ botId })
    setBusy(null)
    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
    else {
      toast({ title: kind === "compact" ? `Compacted ${botName}'s context` : `Started a new session for ${botName}` })
      close()
    }
  }
  return (
    <Popover
      side="top"
      align="end"
      label="Context"
      className="w-[280px] rounded-2xl p-3"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label={`Context ${pct}% · ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.windowTokens)}`}
          title={`Context ${pct}% · ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.windowTokens)}`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-secondary aria-expanded:bg-secondary"
        >
          <Ring pct={pct} />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center text-sm">
            <span className="font-medium text-fg">Context</span>
            <span className="ms-auto text-fg-secondary tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 70 ? toneFor(pct) : "var(--ob-fg-secondary)" }} />
          </div>
          <div className="flex text-xs text-fg-secondary">
            <span>Used</span>
            <span className="ms-auto tabular-nums">
              {formatTokens(usage.usedTokens)} / {formatTokens(usage.windowTokens)} tokens
            </span>
          </div>
          <p className="text-2xs text-fg-quaternary">{botName} has one session for all of its chats (DM, groups, routines). Compacting keeps a summary; a new session starts empty for all of them. Memory and files stay.</p>
          <div className="flex items-center gap-2">
            <PillButton size="md" loading={busy === "compact"} disabled={busy !== null} onClick={() => run("compact", close)}>
              {busy === "compact" ? "Compacting…" : "Compact"}
            </PillButton>
            <PillButton size="md" variant="tertiary" className="ms-auto" loading={busy === "new"} disabled={busy !== null} onClick={() => run("new", close)}>
              New session
            </PillButton>
          </div>
        </div>
      )}
    </Popover>
  )
}
