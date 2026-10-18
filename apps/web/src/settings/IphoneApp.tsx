// Settings › General › iPhone app: a one-time code (5 minutes) that the OpenBot app scans to connect
// (`POST /api/auth/app-code`, shown as `openbot://connect?origin=…&code=…` in a QR code).
import { PillButton } from "@openbot/ui"
import QRCode from "qrcode"
import { type ReactNode, useEffect, useState } from "react"
import { CommandBlock } from "../details/kit.tsx"
import { SettingsRow } from "./layout.tsx"

const loopback = (origin: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)

export function IphoneAppRow(): ReactNode {
  const [code, setCode] = useState<{ readonly link: string; readonly svg: string; readonly expiresAt: number } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!code) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [code])
  const show = async () => {
    setError(undefined)
    try {
      const res = await fetch("/api/auth/app-code", { method: "POST", credentials: "same-origin" })
      const body = (await res.json()) as { code?: string; expiresInSeconds?: number; error?: string }
      if (!res.ok || !body.code) throw new Error(body.error ?? `OpenBot answered ${res.status}`)
      const link = `openbot://connect?origin=${encodeURIComponent(location.origin)}&code=${encodeURIComponent(body.code)}`
      const svg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#121212", light: "#ffffff" } })
      setCode({ link, svg, expiresAt: Date.now() + (body.expiresInSeconds ?? 300) * 1000 })
      setNow(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0
  const expired = code !== undefined && left === 0
  return (
    <SettingsRow
      title="iPhone app"
      description="Scan the code with the OpenBot app to connect your iPhone. Each code works once, for 5 minutes."
      wide
      control={
        <PillButton variant="secondary" size="md" onClick={() => void show()} data-testid="iphone-code">
          {code ? "New code" : "Show code"}
        </PillButton>
      }
    >
      {code && (
        <div className="flex flex-col items-center gap-3 pt-3">
          <div
            className={expired ? "opacity-30" : undefined}
            style={{ width: 200, height: 200, borderRadius: 16, overflow: "hidden" }}
            data-testid="iphone-qr"
            // generated from our own link by the qrcode library
            dangerouslySetInnerHTML={{ __html: code.svg }}
          />
          <span className="text-sm text-fg-secondary">{expired ? "This code expired." : `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</span>
          {loopback(location.origin) && (
            <span className="text-center text-sm text-warn-fg">This page is open on this computer's own address, which your iPhone can't reach. Open OpenBot through its network address and show the code there.</span>
          )}
          <div className="w-full">
            <CommandBlock command={code.link} />
          </div>
        </div>
      )}
      {error && <p className="pt-2 text-sm text-danger-fg">{error}</p>}
    </SettingsRow>
  )
}
