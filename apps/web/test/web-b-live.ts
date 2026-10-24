// Test-only stand-in for the brain's live-view sockets, so the W2.3 screenshot test can exercise
// ComputerView with real frames and input relay against the dev mock (which has no screen):
//   - `/rpc`: a WebSocket proxy to the mock's `/rpc` that rewrites `computer.status / ensure / lease`
//     replies into a ready browser surface (the rest passes through untouched);
//   - `/ws/computer/:botId?mode=view|control`: sends the brain-nodes wire format (Lease + Url notices,
//     then `[u32 BE N][meta JSON][jpeg]` frames) and records control-mode input events;
//   - `/ws/terminal/:botId`: a tiny echo "pty" speaking the terminal wire format.
import type { Server, ServerWebSocket } from "bun"

type Kind =
  | { kind: "rpc"; upstream?: WebSocket; queue: string[] }
  | { kind: "screen"; botId: string; mode: "view" | "control" }
  | { kind: "terminal" }

export interface LiveStub {
  /** Input events received on control sockets (parsed JSON). */
  readonly inputs: Array<Record<string, unknown>>
  /** Raw keystroke bytes received on terminal sockets. */
  readonly terminalInput: string[]
  holder: "user" | "bot"
  readonly fetch: (req: Request, server: Server<Kind>) => Response | undefined | Promise<Response | undefined>
  readonly websocket: {
    open(ws: ServerWebSocket<Kind>): void
    message(ws: ServerWebSocket<Kind>, message: string | Buffer): void
    close(ws: ServerWebSocket<Kind>): void
  }
}

export const encodeFrame = (meta: object, image: Uint8Array): Uint8Array => {
  const header = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + header.length + image.length)
  new DataView(out.buffer).setUint32(0, header.length, false)
  out.set(header, 4)
  out.set(image, 4 + header.length)
  return out
}

export const makeLiveStub = (options: {
  readonly mockRpcUrl: string
  readonly jpeg: Uint8Array
  readonly width: number
  readonly height: number
}): LiveStub => {
  const screens = new Set<ServerWebSocket<Kind>>()
  const pending = new Map<string, { tag: string; payload: Record<string, unknown> }>()
  let seq = 0
  const frame = () =>
    encodeFrame(
      {
        seq: seq++,
        mime: "image/jpeg",
        width: options.width,
        height: options.height,
        viewportWidth: options.width,
        viewportHeight: options.height,
        timestamp: Date.now(),
      },
      options.jpeg,
    )
  const stub: LiveStub = {
    inputs: [],
    terminalInput: [],
    holder: "bot",
    fetch: (req, server) => {
      const url = new URL(req.url)
      if (url.pathname === "/rpc")
        return server.upgrade(req, { data: { kind: "rpc", queue: [] } })
          ? undefined
          : new Response("upgrade failed", { status: 400 })
      const screen = /^\/ws\/computer\/([^/]+)$/.exec(url.pathname)
      if (screen) {
        const mode = url.searchParams.get("mode") === "control" ? "control" : "view"
        if (mode === "control" && stub.holder !== "user") return new Response("Take control first", { status: 403 })
        return server.upgrade(req, { data: { kind: "screen", botId: decodeURIComponent(screen[1]!), mode } })
          ? undefined
          : new Response("upgrade failed", { status: 400 })
      }
      if (/^\/ws\/terminal\//.test(url.pathname))
        return server.upgrade(req, { data: { kind: "terminal" } })
          ? undefined
          : new Response("upgrade failed", { status: 400 })
      return undefined
    },
    websocket: {
      open(ws) {
        const d = ws.data
        if (d.kind === "rpc") {
          const up = new WebSocket(options.mockRpcUrl)
          d.upstream = up
          up.onopen = () => {
            for (const m of d.queue) up.send(m)
            d.queue.length = 0
          }
          up.onmessage = (e) => ws.send(rewrite(String(e.data)))
          up.onclose = () => ws.close()
          return
        }
        if (d.kind === "screen") {
          screens.add(ws)
          ws.send(JSON.stringify({ _tag: "Lease", holder: stub.holder }))
          ws.send(JSON.stringify({ _tag: "Url", url: "https://example.test/portal", title: "Facilities portal" }))
          ws.send(frame())
          return
        }
        ws.send(new TextEncoder().encode("openbot@node:~/workspace$ "))
      },
      message(ws, message) {
        const d = ws.data
        if (d.kind === "rpc") {
          const text = String(message)
          track(text)
          if (d.upstream?.readyState === WebSocket.OPEN) d.upstream.send(text)
          else d.queue.push(text)
          return
        }
        if (d.kind === "screen") {
          if (d.mode === "control" && typeof message === "string") {
            try {
              stub.inputs.push(JSON.parse(message) as Record<string, unknown>)
            } catch {
              // ignore
            }
          }
          return
        }
        if (typeof message === "string") return // {"resize":…}
        const text = new TextDecoder().decode(message)
        stub.terminalInput.push(text)
        ws.send(new TextEncoder().encode(text === "\r" ? "\r\nopenbot@node:~/workspace$ " : text))
      },
      close(ws) {
        const d = ws.data
        if (d.kind === "rpc") d.upstream?.close()
        if (d.kind === "screen") screens.delete(ws)
      },
    },
  }

  const track = (text: string) => {
    try {
      const raw = JSON.parse(text) as unknown
      for (const m of Array.isArray(raw) ? raw : [raw]) {
        const msg = m as { _tag?: string; id?: unknown; tag?: string; payload?: Record<string, unknown> }
        if (msg._tag === "Request" && typeof msg.tag === "string" && msg.tag.startsWith("computer."))
          pending.set(String(msg.id), { tag: msg.tag, payload: msg.payload ?? {} })
      }
    } catch {
      // not JSON
    }
  }

  const status = (botId: string) => ({
    botId,
    nodeId: "node_local",
    state: "ready",
    surface: "browser",
    controller: stub.holder,
    viewPath: `/ws/computer/${botId}`,
  })

  const rewrite = (text: string): string => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return text
    }
    const list = Array.isArray(raw) ? raw : [raw]
    let changed = false
    const out = list.map((m) => {
      const msg = m as { _tag?: string; requestId?: unknown }
      if (msg._tag !== "Exit") return m
      const req = pending.get(String(msg.requestId))
      if (!req) return m
      pending.delete(String(msg.requestId))
      const botId = String(req.payload["botId"] ?? "")
      if (req.tag === "computer.lease") {
        const take = req.payload["take"] === true
        stub.holder = take ? "user" : "bot"
        for (const s of screens) {
          if (s.data.kind !== "screen") continue
          s.send(JSON.stringify({ _tag: "Lease", holder: stub.holder }))
          if (!take && s.data.mode === "control") s.close(1000, "control released")
        }
      }
      changed = true
      return { ...msg, exit: { _tag: "Success", value: status(botId) } }
    })
    return changed ? JSON.stringify(Array.isArray(raw) ? out : out[0]) : text
  }

  // keep painting (idle pages do not repaint, but a periodic frame keeps the test deterministic)
  setInterval(() => {
    for (const s of screens) s.send(frame())
  }, 1000).unref?.()

  return stub
}
