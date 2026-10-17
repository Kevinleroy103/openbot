import type { ReactNode } from "react"
import { cn } from "../cn.ts"
import { Avatar } from "./Avatar.tsx"
import { type AvatarColor, AvatarColors, type AvatarShape, AvatarShapes, avatarFill } from "./palette.ts"

export interface AvatarPickerProps {
  readonly shape: AvatarShape | (string & {})
  readonly color: AvatarColor | (string & {})
  readonly onChange?: (next: { shape: AvatarShape; color: AvatarColor }) => void
  readonly className?: string
}

/**
 * Avatar editor "Bot" tab body: a 5-column shape grid in the current color (selected ringed) and the
 * 11 color dots (6 + 5 rows, selected ringed). Wrap it in a Popover with SegmentedTabs in apps/web.
 */
export function AvatarPicker({ shape, color, onChange, className }: AvatarPickerProps): ReactNode {
  const currentShape = (AvatarShapes as ReadonlyArray<string>).includes(shape) ? (shape as AvatarShape) : "blob"
  const currentColor = (AvatarColors as ReadonlyArray<string>).includes(color) ? (color as AvatarColor) : "gray"
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div role="radiogroup" aria-label="Shape" className="grid grid-cols-5 justify-items-center gap-x-1 gap-y-2">
        {AvatarShapes.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === currentShape}
            aria-label={s}
            title={s}
            onClick={() => onChange?.({ shape: s, color: currentColor })}
            className={cn(
              "inline-flex size-11 items-center justify-center rounded-full transition-colors duration-100 hover:bg-hover",
              s === currentShape && "ring-[1.5px] ring-line ring-offset-0",
            )}
          >
            <Avatar shape={s} color={currentColor} size={36} />
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Color" className="flex flex-col items-center gap-2">
        {[AvatarColors.slice(0, 6), AvatarColors.slice(6)].map((rowColors, r) => (
          <div key={r} className="flex justify-center gap-1">
            {rowColors.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === currentColor}
                aria-label={c}
                title={c}
                onClick={() => onChange?.({ shape: currentShape, color: c })}
                className={cn(
                  "inline-flex size-9 items-center justify-center rounded-full transition-transform duration-100 hover:scale-105",
                  c === currentColor && "ring-[1.5px] ring-line",
                )}
              >
                <span className="size-6 rounded-full" style={{ background: avatarFill(c) }} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
