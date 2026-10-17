// `computer.status` / `computer.ensure` / `computer.lease` for one bot, folded into what the UI needs:
// can we stream a screen right now, and if not, why.
import { computerStatusAtom } from "@openbot/client"
import type { BotId, ComputerStatus } from "@openbot/contracts"
import { Atom } from "effect/reactivity"
import { useMemo } from "react"
import { useCommand, useQuery } from "../details/kit.tsx"

export type ScreenAvailability =
  | { readonly kind: "loading" }
  /** The host node has no browser (or only the not-yet-built desktop view). */
  | { readonly kind: "unsupported"; readonly message: string }
  /** The host node is offline / unreachable. */
  | { readonly kind: "unreachable"; readonly message: string }
  /** A browser view exists but no window is open yet (needs `computer.ensure`). */
  | { readonly kind: "absent" }
  /** `ready` or `starting`: connect the viewer socket. */
  | { readonly kind: "stream" }

export const availabilityOf = (status: ComputerStatus | undefined, error: string | undefined): ScreenAvailability => {
  if (!status) return error ? { kind: "unreachable", message: error } : { kind: "loading" }
  if (status.surface !== "browser" || status.state === "unsupported") return { kind: "unsupported", message: status.message ?? "This computer has no screen to show" }
  if (status.state === "error") return { kind: "unreachable", message: status.message ?? "Can't reach the screen" }
  if (status.state === "absent") return { kind: "absent" }
  return { kind: "stream" }
}

export function useComputer(botId: BotId) {
  const status = useQuery(computerStatusAtom(botId))
  const ensure = useCommand("computer.ensure", botId)
  const lease = useCommand("computer.lease", botId)
  const availability = useMemo(() => availabilityOf(status.value, status.error), [status.value, status.error])
  return { status, availability, ensure, lease }
}

/** Which tab ComputerView opens on (set by the details pane right before `useComputerView().open`). */
export const computerInitialTabAtom: Atom.Writable<"screen" | "terminal"> = Atom.make<"screen" | "terminal">("screen").pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/computerInitialTab"),
)
