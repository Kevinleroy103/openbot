// "Bots can't use ‹Mac›'s screen until…": the macOS permissions a Mac's node still needs for its own
// screen (`screen@1`), from `computer.status.missing` / `NodeSummary.screenMissing`.
import { cn } from "@openbot/ui"
import type { ReactNode } from "react"
import { describeMissing } from "./desktop.ts"

export function ScreenPermissionsNote({
  missing,
  nodeName,
  className,
}: {
  readonly missing: ReadonlyArray<string>
  readonly nodeName: string
  readonly className?: string
}): ReactNode {
  return (
    <p className={cn("text-sm text-fg-secondary", className)} data-testid="screen-permissions">
      On <span className="whitespace-nowrap">{nodeName}</span>, allow {describeMissing(missing)} for openbot-node in
      System Settings › Privacy &amp; Security. If it isn't listed, add{" "}
      <code className="font-mono text-xs">~/.local/bin/openbot-node</code> with the + button.
    </p>
  )
}
