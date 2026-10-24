// Terminal on the bot's host node: xterm.js ↔ `/ws/terminal/:botId` (brain-nodes ComputerService,
// `pty.open` in the bot's workspace). Binary frames are terminal bytes both ways; JSON text frames
// carry resize (up) and exit / error (down). See ./protocol.ts.
import "@xterm/xterm/css/xterm.css"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { Icon, Spinner, cn } from "@openbot/ui"
import { RotateCcw } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { decodeTerminalControl, encodeTerminalResize, terminalSocketUrl } from "./protocol.ts"

type TerminalPhase = "connecting" | "open" | "closed"

const THEME = {
  background: "#141414",
  foreground: "#e8e8e8",
  cursor: "#f5f5f5",
  cursorAccent: "#141414",
  selectionBackground: "#3a5f8f80",
  black: "#1c1c1c",
  red: "#ff6463",
  green: "#00ba69",
  yellow: "#e28600",
  blue: "#4d9bff",
  magenta: "#ff55a4",
  cyan: "#00b7a2",
  white: "#d8d8d8",
  brightBlack: "#6b6b6b",
  brightRed: "#ff8382",
  brightGreen: "#31d68a",
  brightYellow: "#f5a623",
  brightBlue: "#7ab4ff",
  brightMagenta: "#ff7dbb",
  brightCyan: "#3fd6c3",
  brightWhite: "#ffffff",
} as const

export function TerminalPane({
  botId,
  botName,
  active = true,
  className,
}: {
  readonly botId: string
  readonly botName: string
  readonly active?: boolean
  readonly className?: string
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [phase, setPhase] = useState<TerminalPhase>("connecting")
  const [note, setNote] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const term = new Terminal({
      fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // host not laid out yet; the ResizeObserver fits again
    }
    setPhase("connecting")
    setNote(undefined)

    const encoder = new TextEncoder()
    const ws = new WebSocket(terminalSocketUrl(botId, term.cols, term.rows))
    ws.binaryType = "arraybuffer"
    let opened = false
    ws.onopen = () => {
      opened = true
      if (disposed) return
      setPhase("open")
      ws.send(encodeTerminalResize(term.cols, term.rows))
      term.focus()
    }
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        const control = decodeTerminalControl(e.data)
        if (!control) return
        if ("error" in control) {
          setNote(control.error)
          term.write(`\r\n\x1b[31m${control.error}\x1b[0m\r\n`)
        } else {
          const how =
            control.exit !== null ? `exit code ${control.exit}` : control.signal ? `signal ${control.signal}` : "exited"
          term.write(`\r\n\x1b[2m[process ${how}]\x1b[0m\r\n`)
          setNote(`The shell ended (${how}).`)
        }
        return
      }
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data))
    }
    ws.onclose = () => {
      if (disposed) return
      setPhase("closed")
      setNote((n) => n ?? (opened ? "The terminal disconnected." : `Can't open a terminal on ${botName}'s computer.`))
    }
    const send = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data))
    }
    const dataSub = term.onData(send)
    const binarySub = term.onBinary((data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff
      ws.send(bytes)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeTerminalResize(cols, rows))
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore: hidden host
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      dataSub.dispose()
      binarySub.dispose()
      resizeSub.dispose()
      ws.onclose = null
      ws.onmessage = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "terminal closed")
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [botId, botName, generation])

  // refit + focus when the tab becomes visible again
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-[#141414] ring-[0.5px] ring-white/10",
        className,
      )}
    >
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1.5" data-testid="terminal-host" />
      {phase === "connecting" && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/80">
            <Spinner size={12} />
            Opening a terminal on {botName}'s computer…
          </span>
        </div>
      )}
      {phase === "closed" && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-[#242424] py-1 ps-4 pe-1 text-sm text-white/70 shadow-popover ring-[0.5px] ring-white/10">
            <span>{note ?? "The terminal disconnected."}</span>
            <button
              type="button"
              onClick={() => setGeneration((g) => g + 1)}
              className="inline-flex h-[26px] items-center gap-1 rounded-full bg-white px-2.5 text-sm font-medium text-[#121212] hover:bg-white/90"
            >
              <Icon icon={RotateCcw} size="sm" className="-ms-0.5" />
              Reconnect
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
