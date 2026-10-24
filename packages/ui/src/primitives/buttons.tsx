import { LoaderCircle, type LucideIcon } from "lucide-react"
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react"
import { cn } from "../cn.ts"
import { Icon, type IconSize } from "../Icon.tsx"

// ------------------------------------------------------------------------------------------- Spinner

export function Spinner({
  size = 14,
  className,
  label,
}: {
  readonly size?: number
  readonly className?: string
  readonly label?: string
}): ReactNode {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    >
      <LoaderCircle size={size} strokeWidth={2} className="animate-spin" aria-hidden />
    </span>
  )
}

// ---------------------------------------------------------------------------------------- IconButton

export type IconButtonSize = 20 | 24 | 28 | 36 | 44
export type IconButtonVariant = "ghost" | "secondary" | "elevated" | "primary" | "accent"

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly icon: LucideIcon
  /** Required accessible name (also used as the native tooltip unless `title` is given). */
  readonly label: string
  readonly size?: IconButtonSize
  readonly variant?: IconButtonVariant
  /** Round (default) or 6 px square corners. */
  readonly shape?: "round" | "square"
  readonly iconSize?: IconSize
  readonly ref?: Ref<HTMLButtonElement>
}

const iconButtonBox: Record<IconButtonSize, string> = {
  20: "size-5",
  24: "size-6",
  28: "size-7",
  36: "size-9",
  44: "size-11",
}
const iconButtonGlyph: Record<IconButtonSize, IconSize> = { 20: "xs", 24: "sm", 28: "lg", 36: "lg", 44: "xl" }

const iconButtonVariant: Record<IconButtonVariant, string> = {
  ghost: "text-icon-secondary hover:bg-secondary hover:text-icon aria-expanded:bg-secondary aria-expanded:text-icon",
  secondary: "bg-secondary text-icon hover:bg-secondary-hover aria-expanded:bg-secondary-hover",
  elevated: "bg-elevated text-icon hairline border-line-tertiary shadow-control hover:bg-elevated-hover",
  primary: "bg-primary text-fg-inverted hover:bg-primary-hover",
  accent: "bg-accent text-white hover:bg-accent-hover",
}

/** Square-box icon button: 36 px round for sidebar Search/New and pane Close; 28 px inside the composer. */
export function IconButton({
  icon,
  label,
  size = 36,
  variant = "ghost",
  shape = "round",
  iconSize,
  className,
  type = "button",
  title,
  ref,
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center transition-colors duration-100 ease-out outline-offset-1",
        "disabled:pointer-events-none disabled:opacity-40",
        iconButtonBox[size],
        shape === "round" ? "rounded-full" : "rounded-md",
        iconButtonVariant[variant],
        className,
      )}
      {...rest}
    >
      <Icon icon={icon} size={iconSize ?? iconButtonGlyph[size]} />
    </button>
  )
}

// ---------------------------------------------------------------------------------------- PillButton

export type PillButtonVariant =
  "primary" | "secondary" | "ghost" | "tertiary" | "danger" | "danger-soft" | "accent" | "accent-soft" | "outline"
export type PillButtonSize = "xs" | "sm" | "md" | "card" | "lg"

export interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: PillButtonVariant
  readonly size?: PillButtonSize
  readonly leadingIcon?: LucideIcon
  readonly trailingIcon?: LucideIcon
  /** Shows a spinner in place of the leading icon and disables the button. */
  readonly loading?: boolean
  readonly ref?: Ref<HTMLButtonElement>
}

const pillVariant: Record<PillButtonVariant, string> = {
  primary: "bg-primary text-fg-inverted hover:bg-primary-hover disabled:bg-primary-disabled",
  secondary: "bg-secondary text-fg hover:bg-secondary-hover disabled:bg-secondary-disabled",
  ghost: "text-fg hover:bg-secondary",
  tertiary: "text-fg hover:bg-secondary",
  danger: "bg-danger text-white hover:bg-danger-hover disabled:bg-danger-disabled",
  "danger-soft": "bg-danger-soft text-danger-fg hover:bg-danger-soft-hover",
  accent: "bg-accent text-white hover:bg-accent-hover disabled:bg-accent-disabled",
  "accent-soft": "bg-accent-soft text-accent-fg hover:bg-accent-soft-hover",
  outline: "hairline border-line text-fg hover:bg-secondary",
}

const pillSize: Record<PillButtonSize, string> = {
  xs: "h-6 gap-1 px-2 text-xs",
  sm: "h-[26px] gap-1 px-2.5 text-sm",
  md: "h-7 gap-1 px-3 text-sm",
  card: "h-8 gap-1.5 px-3 text-base",
  lg: "h-9 gap-1.5 px-4 text-base",
}

const pillIcon: Record<PillButtonSize, IconSize> = { xs: "xs", sm: "sm", md: "sm", card: "md", lg: "md" }

/** Every button in Grok's system is a pill: rounded-full, 120 ms color transitions, medium weight. */
export function PillButton({
  variant = "secondary",
  size = "md",
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ref,
  ...rest
}: PillButtonProps): ReactNode {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap transition-colors duration-[120ms] ease-out",
        "disabled:cursor-default disabled:text-[color-mix(in_srgb,currentColor_45%,transparent)]",
        pillSize[size],
        pillVariant[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === "xs" ? 12 : 14} />
      ) : leadingIcon ? (
        <Icon icon={leadingIcon} size={pillIcon[size]} className="-ms-0.5" />
      ) : null}
      {children}
      {trailingIcon && <Icon icon={trailingIcon} size={pillIcon[size]} className="-me-1 opacity-70" />}
    </button>
  )
}

// ---------------------------------------------------------------------------------------- HeaderPill

export interface HeaderPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Usually a 24 px `<Avatar>`. */
  readonly avatar?: ReactNode
  readonly ref?: Ref<HTMLButtonElement>
}

/** Floating chat header: elevated pill with the bot avatar + name; opens the details pane. */
export function HeaderPill({ avatar, children, className, type = "button", ref, ...rest }: HeaderPillProps): ReactNode {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex h-[41px] max-w-full min-w-0 items-center gap-2 rounded-full bg-elevated py-[7.5px] ps-[7.5px] pe-[13.5px]",
        "hairline border-line-secondary shadow-inline transition-colors duration-[120ms] hover:bg-elevated-hover",
        className,
      )}
      {...rest}
    >
      {avatar}
      <span className="truncate text-base font-medium text-fg">{children}</span>
    </button>
  )
}
