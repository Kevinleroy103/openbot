import { ChevronRight, X } from "lucide-react"
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react"
import { cn } from "../cn.ts"
import { Icon } from "../Icon.tsx"
import { Spinner } from "./buttons.tsx"

// ---------------------------------------------------------------------------------------- KeyBadge

export interface KeyBadgeProps {
  readonly children: ReactNode
  /** `option` = A/B/C key on question rows (18×20); `kbd` = keyboard cap (⌘K, Tab, ↩). */
  readonly variant?: "option" | "kbd"
  readonly className?: string
}

export function KeyBadge({ children, variant = "kbd", className }: KeyBadgeProps): ReactNode {
  return variant === "option" ? (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-5 w-[18px] shrink-0 items-center justify-center rounded-sm bg-[color-mix(in_srgb,var(--ob-fg)_7%,transparent)] text-2xs text-fg-tertiary hairline border-line-tertiary",
        className,
      )}
    >
      {children}
    </span>
  ) : (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-sm bg-secondary px-1 font-sans text-xs text-fg-secondary tabular-nums hairline border-line-quaternary",
        className,
      )}
    >
      {children}
    </kbd>
  )
}

// -------------------------------------------------------------------------------------- StatusPill

export type StatusTone = "warn" | "success" | "danger" | "accent" | "neutral"

export interface StatusPillProps {
  readonly tone?: StatusTone
  readonly children: ReactNode
  /** Leading 6 px dot ("● Ready to send"). */
  readonly dot?: boolean
  /** Leading spinner ("Running", "Action needed"). */
  readonly spinner?: boolean
  readonly className?: string
}

const toneClass: Record<StatusTone, string> = {
  warn: "bg-warn-soft text-warn-fg",
  success: "bg-success-soft text-success-fg",
  danger: "bg-danger-soft text-danger-fg",
  accent: "bg-accent-soft text-accent-fg",
  neutral: "bg-secondary text-fg-secondary",
}
const toneDot: Record<StatusTone, string> = { warn: "bg-warn", success: "bg-success", danger: "bg-danger", accent: "bg-accent", neutral: "bg-icon-tertiary" }

export function StatusPill({ tone = "neutral", children, dot = false, spinner = false, className }: StatusPillProps): ReactNode {
  return (
    <span role="status" className={cn("inline-flex h-6 shrink-0 animate-fade-in items-center gap-1.5 rounded-full px-2.5 text-sm whitespace-nowrap", toneClass[tone], className)}>
      {spinner ? <Spinner size={12} /> : dot ? <span className={cn("size-1.5 rounded-full", toneDot[tone])} /> : null}
      {children}
    </span>
  )
}

// -------------------------------------------------------------------------------------------- Card

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** `chat` = in-transcript card (bot-bubble fill, 16 px radius); `elevated` = outside chat (24 px, card shadow). */
  readonly variant?: "chat" | "elevated"
  readonly ref?: Ref<HTMLElement>
}

/** Typed card shell (question, approval, handoff, routine…): 6 % fill, radius 16, padding 12, 10 px gaps. */
export function Card({ variant = "chat", className, children, ref, ...rest }: CardProps): ReactNode {
  return (
    <section
      ref={ref}
      className={cn(
        "flex w-full max-w-[min(80%,560px)] flex-col gap-2.5 p-3 text-fg",
        variant === "chat" ? "rounded-4xl bg-bubble-agent" : "rounded-[24px] bg-elevated shadow-card",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  )
}

export interface CardHeaderProps {
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  /** StatusPill or other trailing control. */
  readonly status?: ReactNode
  readonly icon?: ReactNode
  readonly onClose?: () => void
  readonly closeLabel?: string
  readonly className?: string
}

export function CardHeader({ title, subtitle, status, icon, onClose, closeLabel = "Dismiss", className }: CardHeaderProps): ReactNode {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
        <h3 className="text-lg font-normal text-fg">{title}</h3>
        {subtitle && <p className="text-sm text-fg-secondary">{subtitle}</p>}
      </div>
      {status}
      {onClose && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="-me-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-icon-secondary transition-colors duration-100 hover:bg-secondary hover:text-icon"
        >
          <Icon icon={X} size="md" />
        </button>
      )}
    </div>
  )
}

export function CardBody({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cn("text-lg text-fg", className)}>{children}</div>
}

/** "View the full request ›" style link inside cards. */
export function CardLink({ children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return (
    <button type="button" className={cn("inline-flex w-fit items-center gap-0.5 text-base text-fg-secondary transition-colors hover:text-fg", className)} {...rest}>
      {children}
      <Icon icon={ChevronRight} size="sm" />
    </button>
  )
}

/** Card footer: buttons start-aligned; put a `ms-auto` element for a right-aligned tertiary action. */
export function CardActions({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cn("flex flex-wrap items-center gap-2 pt-1", className)}>{children}</div>
}

// ------------------------------------------------------------------------------------------- Sheet

/** Inner white sheet in a card: radius 10, rows split by hairlines. */
export function Sheet({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl bg-elevated hairline border-line-quaternary [&>*+*]:border-t-[0.5px] [&>*+*]:border-line-secondary",
        className,
      )}
    >
      {children}
    </div>
  )
}

export interface SheetRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly leading?: ReactNode
  readonly trailing?: ReactNode
  readonly selected?: boolean
}

/** Clickable sheet row (question option, connector row). */
export function SheetRow({ leading, trailing, selected, className, children, type = "button", ...rest }: SheetRowProps): ReactNode {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cn(
        "flex min-h-[38px] w-full items-center gap-2.5 px-3 py-2 text-start text-lg text-fg transition-colors duration-[120ms] hover:bg-hover disabled:pointer-events-none",
        selected && "bg-active",
        className,
      )}
      {...rest}
    >
      {leading}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
    </button>
  )
}

/** Question option: A/B/C key + label. */
export function OptionRow({ optionKey, children, ...rest }: SheetRowProps & { readonly optionKey: string }): ReactNode {
  return (
    <SheetRow leading={<KeyBadge variant="option">{optionKey}</KeyBadge>} {...rest}>
      {children}
    </SheetRow>
  )
}

/** Label / value row inside a sheet (email draft From/To, harness details). */
export function SheetField({ label, children, className }: { readonly label: ReactNode; readonly children: ReactNode; readonly className?: string }): ReactNode {
  return (
    <div className={cn("flex min-h-[38px] items-center gap-3 px-3 py-2 text-base", className)}>
      <span className="w-20 shrink-0 text-fg-secondary">{label}</span>
      <span className="min-w-0 flex-1 text-fg">{children}</span>
    </div>
  )
}
