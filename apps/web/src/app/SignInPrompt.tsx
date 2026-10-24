// "Let a browser sign in?": a browser on the login page asked to ("Sign in with another device",
// roster `signIns`). The owner lets it in by picking, of three, the number that browser shows; a wrong
// number cancels the request, "Not me" turns it down (`POST /api/auth/device/approve`), "Later" only
// hides it here. Every signed-in app shows it; answering on one ends it everywhere.
import { signInRequestsOf, type SignInRequest } from "@openbot/contracts"
import { Dialog, DialogFooter, DialogHeader, PillButton, useToast } from "@openbot/ui"
import { type ReactNode, useEffect, useState } from "react"
import { useRoster } from "./data.ts"

const ago = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / 60_000)
  return minutes < 1 ? "just now" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`
}

export function SignInPrompt(): ReactNode {
  const roster = useRoster()
  const [now, setNow] = useState(() => Date.now())
  // requests expire on their own: look again now and then
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const [later, setLater] = useState<ReadonlySet<string>>(new Set())
  const request = signInRequestsOf(roster.state, now).find((r) => !later.has(r.code))
  if (request === undefined) return null
  return (
    <SignInDialog
      key={request.code}
      request={request}
      now={now}
      onLater={() => setLater((s) => new Set(s).add(request.code))}
    />
  )
}

function SignInDialog({
  request,
  now,
  onLater,
}: {
  readonly request: SignInRequest
  readonly now: number
  readonly onLater: () => void
}): ReactNode {
  const [pending, setPending] = useState<number | "refuse" | undefined>()
  const { toast } = useToast()
  const answer = async (choice: number | "refuse") => {
    setPending(choice)
    try {
      const res = await fetch("/api/auth/device/approve", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          choice === "refuse" ? { code: request.code, refuse: true } : { code: request.code, match: choice },
        ),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? `OpenBot answered ${res.status}`)
      toast({
        title: choice === "refuse" ? "Turned down. That browser stays signed out." : `${request.from} is signed in.`,
      })
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), tone: "danger" })
    } finally {
      setPending(undefined)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onLater()} width={420} label="Let a browser sign in?">
      <DialogHeader
        title="Let a browser sign in?"
        description={
          <>
            <span className="font-medium text-fg">{request.from}</span> asked to sign in to OpenBot{" "}
            {ago(request.at, now)}. If that was you, pick the number it shows. If it wasn't, choose Not me.
          </>
        }
      />
      <div className="flex justify-center gap-3 px-4 pb-2 pt-1" data-testid="sign-in-choices">
        {request.choices.map((n) => (
          <button
            key={n}
            type="button"
            disabled={pending !== undefined}
            onClick={() => void answer(n)}
            aria-label={`The browser shows ${n}`}
            className="h-16 w-20 rounded-2xl bg-secondary text-[28px] font-semibold tabular-nums text-fg transition-colors hover:bg-secondary-hover disabled:opacity-60"
          >
            {n}
          </button>
        ))}
      </div>
      <DialogFooter>
        {/* focus starts here: no number looks chosen, and a stray Enter only puts it off */}
        <PillButton variant="secondary" size="card" onClick={onLater} disabled={pending !== undefined} data-autofocus>
          Later
        </PillButton>
        <PillButton
          variant="danger"
          size="card"
          loading={pending === "refuse"}
          disabled={pending !== undefined}
          onClick={() => void answer("refuse")}
        >
          Not me
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}
