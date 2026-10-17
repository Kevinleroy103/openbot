import type { HTMLAttributes, ReactNode, Ref } from "react"
import { cn } from "../cn.ts"

// -------------------------------------------------------------------------------------------- Bubble

export type BubbleSide = "bot" | "user"
/** Where a bubble sits in a run of consecutive messages from the same side. */
export type BubblePosition = "single" | "first" | "middle" | "last"

/** Position of item `index` in a run of `length` consecutive same-side items. */
export const groupPosition = (index: number, length: number): BubblePosition =>
  length <= 1 ? "single" : index === 0 ? "first" : index === length - 1 ? "last" : "middle"

/**
 * Grouped-corner logic (grok-bot-ui.md §4.4). Radius 18; where grouped bubbles touch, the inner corners
 * drop to 6 px. Returns [top-left, top-right, bottom-right, bottom-left] in px.
 *   user: first 18 18 6 18 · middle 18 6 6 18 · last 18 6 18 18
 *   bot:  first 18 18 18 6 · middle 6 18 18 6 · last 6 18 18 18
 */
export const bubbleCorners = (side: BubbleSide, position: BubblePosition): readonly [number, number, number, number] => {
  const R = 18
  const r = 6
  if (position === "single") return [R, R, R, R]
  if (side === "user") {
    if (position === "first") return [R, R, r, R]
    if (position === "middle") return [R, r, r, R]
    return [R, r, R, R]
  }
  if (position === "first") return [R, R, R, r]
  if (position === "middle") return [r, R, R, r]
  return [r, R, R, R]
}

/** Tailwind classes for the grouped corners (rounded-bubble + 6 px overrides). */
export const bubbleCornerClass = (side: BubbleSide, position: BubblePosition): string => {
  const [tl, tr, br, bl] = bubbleCorners(side, position)
  return cn("rounded-bubble", tl === 6 && "rounded-tl-md", tr === 6 && "rounded-tr-md", br === 6 && "rounded-br-md", bl === 6 && "rounded-bl-md")
}

export interface BubbleProps extends HTMLAttributes<HTMLDivElement> {
  readonly side: BubbleSide
  readonly position?: BubblePosition
  /** Emoji-only messages render without a bubble at 32/38. */
  readonly emojiOnly?: boolean
  readonly ref?: Ref<HTMLDivElement>
}

/** Chat bubble: bot = 6 % ink fill on the left, user = user-bubble color (bot hue when tinted) on the right. */
export function Bubble({ side, position = "single", emojiOnly = false, className, children, ref, ...rest }: BubbleProps): ReactNode {
  if (emojiOnly)
    return (
      <div ref={ref} data-side={side} className={cn("text-[32px] leading-[38px]", side === "user" ? "self-end" : "self-start", className)} {...rest}>
        {children}
      </div>
    )
  return (
    <div
      ref={ref}
      data-side={side}
      data-position={position}
      className={cn(
        "max-w-[min(80%,560px)] px-3 py-[7px] text-lg break-words whitespace-pre-wrap",
        bubbleCornerClass(side, position),
        side === "user" ? "self-end bg-bubble-user text-fg-on-primary" : "self-start bg-bubble-agent text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/** Vertical stack for a transcript: bubbles stack 4 px apart within a group; new groups add margin. */
export function BubbleGroup({ side, children, className }: { readonly side: BubbleSide; readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cn("flex flex-col gap-1", side === "user" ? "items-end" : "items-start", className)}>{children}</div>
}

// ----------------------------------------------------------------------------------------- EventLine

/** Centered transcript event line ("Created routine ⏱ Morning briefing", "2 messages with ◉ Scout"). */
export function EventLine({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cn("flex min-h-6 w-full flex-wrap items-center justify-center gap-0.5 py-2 text-sm text-fg-secondary", className)}>{children}</div>
}

export interface EventChipProps extends HTMLAttributes<HTMLElement> {
  /** 16 px avatar or icon. */
  readonly leading?: ReactNode
  /** Render as a button (clickable object) or a plain span. */
  readonly interactive?: boolean
}

/** Inline object in an event line: avatar/icon + name, pill hover. */
export function EventChip({ leading, interactive = true, className, children, ...rest }: EventChipProps): ReactNode {
  const cls = cn(
    "inline-flex h-6 min-w-0 items-center gap-1 rounded-full ps-1 pe-1.5 text-fg-secondary",
    interactive && "transition-colors duration-[120ms] hover:bg-secondary hover:text-fg",
    className,
  )
  return interactive ? (
    <button type="button" className={cls} {...(rest as HTMLAttributes<HTMLButtonElement>)}>
      {leading}
      <span className="truncate">{children}</span>
    </button>
  ) : (
    <span className={cls} {...rest}>
      {leading}
      <span className="truncate">{children}</span>
    </span>
  )
}

// ----------------------------------------------------------------------------- Timestamp / divider

export function Timestamp({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cn("flex h-7 items-center justify-center py-1.5 text-sm text-fg-secondary", className)}>{children}</div>
}

/** Unread divider: hairline with a centered NEW label, both in the accent (bot) color. */
export function NewDivider({ label = "NEW", className }: { readonly label?: string; readonly className?: string }): ReactNode {
  return (
    <div role="separator" aria-label="New messages" className={cn("flex items-center gap-3 py-2 text-xs font-medium text-accent-fg", className)}>
      <span className="h-px flex-1 bg-[color-mix(in_srgb,var(--ob-accent-fg)_30%,transparent)]" />
      {label}
      <span className="h-px flex-1 bg-[color-mix(in_srgb,var(--ob-accent-fg)_30%,transparent)]" />
    </div>
  )
}

// ------------------------------------------------------------------------------ Activity / typing

/** Text with Grok's activity shimmer (ink sweeping over 40 % ink, 2.2 s steps(60)). */
export function ShimmerText({ children, className, active = true }: { readonly children: ReactNode; readonly className?: string; readonly active?: boolean }): ReactNode {
  return <span className={cn(active ? "shimmer-text animate-shimmer" : "text-fg-secondary", className)}>{children}</span>
}

/**
 * The single status row of a bot above the composer: animated avatar (28 px) + shimmering phrase.
 * With `onClick` its content is a button (e.g. what is in progress opens where it can be followed).
 */
export function ActivityRow({
  avatar,
  label,
  className,
  onClick,
  title,
  ...rest
}: {
  readonly avatar: ReactNode
  readonly label?: ReactNode
  readonly className?: string
  readonly onClick?: (() => void) | undefined
  /** Tooltip of the clickable row. */
  readonly title?: string | undefined
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick" | "title" | "className">): ReactNode {
  const body = (
    <>
      {avatar}
      {label && <ShimmerText className="animate-shimmer text-base leading-[22px]">{label}</ShimmerText>}
    </>
  )
  return (
    <div role="status" aria-live="polite" className={cn("flex h-9 animate-rise-in items-center gap-2 ps-2", className)} {...rest}>
      {onClick === undefined ? (
        body
      ) : (
        <button
          type="button"
          onClick={onClick}
          title={title}
          className="-ms-1 flex h-9 min-w-0 items-center gap-2 rounded-full ps-1 pe-3 text-start transition-colors duration-100 hover:bg-hover active:bg-hover"
        >
          {body}
        </button>
      )}
    </div>
  )
}

export function TypingDots({ className }: { readonly className?: string }): ReactNode {
  return (
    <span className={cn("inline-flex h-7 items-center gap-1", className)} aria-label="Typing" role="status">
      <span className="size-1.5 animate-dot rounded-full bg-fg-tertiary [animation-delay:-.32s]" />
      <span className="size-1.5 animate-dot rounded-full bg-fg-tertiary [animation-delay:-.16s]" />
      <span className="size-1.5 animate-dot rounded-full bg-fg-tertiary" />
    </span>
  )
}

// ------------------------------------------------------------------------------------- Small badges

/** Sidebar label chip ("Ops", "Research"). */
export function LabelChip({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center rounded-sm bg-secondary px-1 text-xs text-fg-secondary hairline border-line-tertiary", className)}>
      {children}
    </span>
  )
}

/** Unread count badge (danger soft). */
export function CountBadge({ count, className }: { readonly count: number; readonly className?: string }): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full bg-danger-soft px-1.5 text-xs font-medium text-danger-fg tabular-nums hairline border-line-quaternary",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

/** Unread dot (accent). */
export function UnreadDot({ className }: { readonly className?: string }): ReactNode {
  return <span aria-label="Unread" role="status" className={cn("inline-block size-2 shrink-0 rounded-full bg-accent-fg", className)} />
}
