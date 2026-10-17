// Answering a runtime request (`requests.respond`), one command atom per request so answering two
// cards at once never interrupts either (packages/client commands.ts).
import { useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import type { ApprovalRuleInput, RequestId, RuntimeResponseInput } from "@openbot/contracts"
import { commandAtom, respondRequestAtom } from "@openbot/client"
import { useToast } from "@openbot/ui"

export const describeFailure = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail") as { readonly error?: unknown } | undefined
  const e = failure?.error as { _tag?: string; message?: string; reason?: string; status?: string } | undefined
  if (e?._tag === "RequestNotPending") return `This request is already ${e.status ?? "closed"}.`
  if (typeof e?.message === "string" && e.message.length > 0) return e.message
  if (typeof e?.reason === "string") return e.reason
  return "Couldn't reach OpenBot. Check your connection and try again."
}

export const useRespond = (requestId: RequestId | string | undefined) => {
  const set = useAtomSet(respondRequestAtom(requestId ?? "none"), { mode: "promiseExit" })
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const respond = async (response: RuntimeResponseInput, tag = "respond"): Promise<boolean> => {
    if (requestId === undefined) return false
    setBusy(tag)
    try {
      const exit = await set({ requestId: requestId as RequestId, response })
      if (Exit.isFailure(exit)) {
        toast({ title: describeFailure(exit), tone: "danger" })
        return false
      }
      return true
    } finally {
      setBusy(null)
    }
  }
  return { respond, busy }
}

/** "Always allow next time" on an expired approval: saves the suggested rule. */
export const useSaveRule = (key: string) => {
  const set = useAtomSet(commandAtom("rules.upsert", key), { mode: "promiseExit" })
  const { toast } = useToast()
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle")
  const save = async (rule: ApprovalRuleInput) => {
    setState("saving")
    const exit = await set({ rule })
    if (Exit.isFailure(exit)) {
      toast({ title: describeFailure(exit), tone: "danger" })
      setState("idle")
    } else setState("saved")
  }
  return { save, state }
}
