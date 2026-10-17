import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "./cn.ts"

/** Icon box / glyph sizes (grok-design-system.md ICONS): xs 14/10, sm 16/12, md 18/14, lg 20/16, xl 22/18. */
export const iconSizes = {
  xs: [14, 10],
  sm: [16, 12],
  md: [18, 14],
  lg: [20, 16],
  xl: [22, 18],
} as const satisfies Record<string, readonly [box: number, glyph: number]>

export type IconSize = keyof typeof iconSizes

export interface IconProps {
  readonly icon: LucideIcon
  readonly size?: IconSize
  /** Override the glyph size in px (box keeps the scale size). */
  readonly glyph?: number
  readonly className?: string
  /** Accessible name; decorative when omitted. */
  readonly label?: string
  readonly strokeWidth?: number
}

/** Lucide wrapper: a fixed square box with a centered glyph at the default stroke width (2). */
export function Icon({ icon: Glyph, size = "lg", glyph, className, label, strokeWidth = 2 }: IconProps): ReactNode {
  const [box, px] = iconSizes[size]
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: box, height: box }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <Glyph size={glyph ?? px} strokeWidth={strokeWidth} aria-hidden focusable={false} />
    </span>
  )
}
