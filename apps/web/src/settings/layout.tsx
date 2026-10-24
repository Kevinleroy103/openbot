// Settings page building blocks (grok-bot-ui.md §4.11): page title 17/24, group labels 12/16
// secondary, white cards (radius 14, 0.5 px border) whose rows have a 14 px title, a 13 px secondary
// description and a control at the right.
import { cn } from "@openbot/ui"
import type { ReactNode } from "react"

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5 pe-8">
      <div className="flex min-h-8 items-center gap-3">
        <h2 className="min-w-0 flex-1 text-xl font-medium text-fg">{title}</h2>
        {actions}
      </div>
      {description && <p className="max-w-[560px] text-sm text-fg-secondary">{description}</p>}
    </div>
  )
}

export function GroupLabel({
  children,
  trailing,
  className,
}: {
  readonly children: ReactNode
  readonly trailing?: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <div className={cn("mt-8 mb-2 flex items-center gap-2 px-1", className)}>
      <span className="min-w-0 flex-1 text-sm text-fg-secondary">{children}</span>
      {trailing}
    </div>
  )
}

export function SettingsCard({
  children,
  className,
  testId,
}: {
  readonly children: ReactNode
  readonly className?: string
  readonly testId?: string
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className={cn("flex flex-col rounded-3xl bg-elevated py-1 hairline border-line-tertiary", className)}
    >
      {children}
    </div>
  )
}

export function SettingsRow({
  title,
  description,
  control,
  children,
  className,
  wide = false,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly control?: ReactNode
  readonly children?: ReactNode
  readonly className?: string
  /** A wide control (text field): on narrow screens it goes under the label at full width. */
  readonly wide?: boolean
}): ReactNode {
  return (
    <div className={cn("flex flex-col gap-2 px-4 py-3", className)}>
      <div className={cn("flex items-center gap-4", wide && "max-sm:flex-col max-sm:items-stretch max-sm:gap-2.5")}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="text-base text-fg">{title}</div>
          {description && <div className="text-sm text-fg-secondary">{description}</div>}
        </div>
        {control !== undefined && <div className={cn("shrink-0", wide && "max-sm:w-full")}>{control}</div>}
      </div>
      {children}
    </div>
  )
}

/** Hairline between rows inside a SettingsCard. */
export function RowDivider(): ReactNode {
  return <div className="mx-4 h-0 border-t-[0.5px] border-line-tertiary" />
}
