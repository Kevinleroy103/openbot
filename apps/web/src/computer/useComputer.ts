// `computer.status` / `computer.ensure` / `computer.lease` / `computer.reset` for one bot, folded into
// what the UI needs: can we stream a screen right now, which kind (the bot's whole desktop over noVNC,
// or its browser window over the CDP screencast), and if not, why.
import { computerStatusAtom } from "@openbot/client"
import type { BotId, ComputerStatus } from "@openbot/contracts"
import { Atom } from "effect/reactivity"
import { useMemo } from "react"
import { useCommand, useQuery } from "../details/kit.tsx"

/**
 * Which live view a node offers: a whole desktop (`desktop@1`, noVNC), a Mac's own screen
 * (`screen@1`, screenshot frames like the CDP screencast) or a browser window (CDP).
 */
export type ScreenSurface = "browser" | "desktop" | "screen"

export type ScreenAvailability =
  | { readonly kind: "loading" }
  /** The host node has no screen to show (no `browser@1` / `desktop@1`); `missing` = what to install. */
  | { readonly kind: "unsupported"; readonly message: string; readonly missing?: ReadonlyArray<string> | undefined }
  /** The host node is offline / unreachable, or the screen failed to start. */
  | {
      readonly kind: "unreachable"
      readonly message: string
      readonly surface?: ScreenSurface | undefined
      /** what the computer lacks (a Mac's permissions) */
      readonly missing?: ReadonlyArray<string> | undefined
    }
  /** No screen yet: a desktop that is asleep, or no browser window (needs `computer.ensure`). */
  | { readonly kind: "absent"; readonly surface: ScreenSurface }
  /** `ready` or `starting`: connect the viewer socket. */
  | { readonly kind: "stream"; readonly surface: ScreenSurface }

export const availabilityOf = (status: ComputerStatus | undefined, error: string | undefined): ScreenAvailability => {
  if (!status) return error ? { kind: "unreachable", message: error } : { kind: "loading" }
  if (status.surface === "none" || status.state === "unsupported") {
    return {
      kind: "unsupported",
      message: status.message ?? "This computer has no screen to show",
      ...(status.missing ? { missing: status.missing } : {}),
    }
  }
  const surface: ScreenSurface = status.surface
  if (status.state === "error") {
    return {
      kind: "unreachable",
      message: status.message ?? "Can't reach the screen",
      surface,
      ...(status.missing ? { missing: status.missing } : {}),
    }
  }
  // a Mac's screen is always there: watching it checks it
  if (status.state === "absent" && surface !== "screen") return { kind: "absent", surface }
  return { kind: "stream", surface }
}

export function useComputer(botId: BotId) {
  const status = useQuery(computerStatusAtom(botId))
  const ensure = useCommand("computer.ensure", botId)
  const lease = useCommand("computer.lease", botId)
  const availability = useMemo(() => availabilityOf(status.value, status.error), [status.value, status.error])
  return { status, availability, ensure, lease }
}

/** Which tab ComputerView opens on (set by the details pane right before `useComputerView().open`). */
export const computerInitialTabAtom: Atom.Writable<"screen" | "terminal"> = Atom.make<"screen" | "terminal">(
  "screen",
).pipe(Atom.keepAlive, Atom.withLabel("openbot/web/computerInitialTab"))
