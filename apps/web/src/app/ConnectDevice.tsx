// "Allow this computer": the desktop app opened this page (`#/connect-device?code=…`) with the code it
// shows; allowing it gives the app a session of its own (`POST /api/auth/device/approve`).
import { useToast } from "@openbot/ui"
import { type ReactNode, useState } from "react"
import { ConfirmDialog } from "../details/kit.tsx"

export function ConnectDeviceDialog({
  code,
  onClose,
}: {
  readonly code: string
  readonly onClose: () => void
}): ReactNode {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const { toast } = useToast()
  const allow = async () => {
    setPending(true)
    setError(undefined)
    try {
      const res = await fetch("/api/auth/device/approve", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? `OpenBot answered ${res.status}`)
      toast({ title: "The desktop app is connected. You can go back to it." })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <ConfirmDialog
      open
      title="Allow the OpenBot app on this computer?"
      body={
        <>
          It will open OpenBot and show your notifications. Allow it only if the app shows this code:{" "}
          <span className="font-mono font-semibold tracking-wider text-fg">{code}</span>
        </>
      }
      confirmLabel="Allow"
      pending={pending}
      error={error}
      onConfirm={() => void allow()}
      onCancel={onClose}
    />
  )
}
