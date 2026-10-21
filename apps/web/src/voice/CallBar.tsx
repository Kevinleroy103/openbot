// The call bar (experiment; Grok Bot's design): floats over the app while a voice call with a Bot is
// on. The Bot's avatar (working while it speaks), a dotted waveform that follows whoever is talking,
// the transcript (what was said, and the work handed to the Bot), mute and hang up.
import { useRoster } from "../app/data.ts"
import { Avatar, IconButton, cn } from "@openbot/ui"
import { MessageCircle, Mic, MicOff, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { callLevel, callState, dismissCall, hangUp, setMuted, subscribeCall } from "./voiceCall.ts"

export const useVoiceCall = () => useSyncExternalStore(subscribeCall, callState)

const DOTS = 14

/** Dots that rise with the level of whoever is talking (read every frame, outside React). */
function Waveform({ active }: { readonly active: boolean }): ReactNode {
  const dots = useRef<Array<HTMLSpanElement | null>>([])
  useEffect(() => {
    let frame = 0
    const levels: Array<number> = Array(DOTS).fill(0)
    const tick = () => {
      const level = active ? callLevel() : 0
      levels.shift()
      levels.push(level)
      dots.current.forEach((dot, i) => {
        if (dot === null) return
        const value = levels[i] ?? 0
        dot.style.transform = `scaleY(${1 + value * 5})`
        dot.style.opacity = String(0.35 + value * 0.65)
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active])
  return (
    <div className="flex h-8 w-28 items-center justify-between px-1" aria-hidden>
      {Array.from({ length: DOTS }, (_, i) => (
        <span key={i} ref={(el) => void (dots.current[i] = el)} className="h-1 w-1 rounded-full bg-accent transition-transform duration-75" />
      ))}
    </div>
  )
}

const PHASE_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
}

export function CallBar(): ReactNode {
  const call = useVoiceCall()
  const roster = useRoster()
  const [transcript, setTranscript] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  // braces: newer browsers return a promise from scrollIntoView, which React would take for a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [call.lines.length, transcript])
  if (call.botId === undefined) return null
  const bot = roster.botById(call.botId)
  const ended = call.phase === "ended"
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex flex-col items-center gap-2 px-3" data-testid="call-bar">
      {transcript && call.lines.length > 0 && (
        <div className="pointer-events-auto max-h-[40vh] w-full max-w-[520px] overflow-y-auto rounded-3xl bg-elevated/95 p-4 text-sm shadow-lg backdrop-blur hairline border-line-tertiary" data-testid="call-transcript">
          {call.lines.map((line) => (
            <p key={line.id} className={cn("py-1", line.who === "you" ? "text-fg" : line.who === "bot" ? "text-fg-secondary" : "text-fg-tertiary italic")}>
              {line.who === "you" ? "You: " : line.who === "bot" ? `${bot?.name ?? "Bot"}: ` : line.pending ? "Working on: " : "Done: "}
              {line.text}
            </p>
          ))}
          <div ref={end} />
        </div>
      )}
      {call.error !== undefined && <p className="pointer-events-auto rounded-full bg-elevated px-4 py-2 text-sm text-danger-fg shadow">{call.error}</p>}
      <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-elevated py-2 ps-3 pe-2 shadow-xl hairline border-line-tertiary" aria-label={`Call with ${bot?.name ?? "Bot"}`}>
        {bot !== undefined && <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={36} working={call.phase === "speaking"} />}
        <Waveform active={!ended && !call.muted} />
        <span className="w-20 text-xs text-fg-tertiary" data-testid="call-phase">{ended ? "Call ended" : call.muted ? "Muted" : PHASE_LABEL[call.phase]}</span>
        <IconButton icon={MessageCircle} label={transcript ? "Hide transcript" : "Show transcript"} size={44} variant={transcript ? "secondary" : "ghost"} onClick={() => setTranscript((t) => !t)} />
        {!ended && <IconButton icon={call.muted ? MicOff : Mic} label={call.muted ? "Unmute" : "Mute"} size={44} variant={call.muted ? "secondary" : "ghost"} onClick={() => setMuted(!call.muted)} />}
        <button
          type="button"
          aria-label={ended ? "Close" : "End call"}
          title={ended ? "Close" : "End call"}
          onClick={ended ? dismissCall : hangUp}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-danger text-white transition-opacity hover:opacity-85"
        >
          <X className="size-5" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
