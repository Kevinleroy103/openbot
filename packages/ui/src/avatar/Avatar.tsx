import type { CSSProperties, ReactNode } from "react"
import { cn } from "../cn.ts"
import { avatarBodies } from "./shapes.ts"
import { type AvatarColor, type AvatarExpression, type AvatarShape, avatarFill, normalizeAvatar } from "./palette.ts"

/** Size scale (grok-bot-ui.md §4.2): mentions 16/20, header pill 22–24, activity 28, rows 36, tiles 56–60, details 64, hero 72. */
export type AvatarSize = 16 | 20 | 22 | 24 | 28 | 36 | 56 | 60 | 64 | 72 | (number & {})

export type AvatarGaze = "center" | "left" | "right" | "up" | "down"

/** Status mark (grok-design-system.md BOT AVATARS). */
export type AvatarStatus = "working" | "attention" | "offline" | "error" | "unread"

export interface AvatarProps {
  /** Stored shape/color are open strings; unknown values fall back to blob/gray. */
  readonly shape?: AvatarShape | (string & {})
  readonly color?: AvatarColor | (string & {})
  readonly size?: AvatarSize
  readonly expression?: AvatarExpression
  readonly gaze?: AvatarGaze
  /** Bot is running a turn: body bobs, eyes glance around and blink. */
  readonly working?: boolean
  /** Occasional idle blink (off by default to keep long lists calm). */
  readonly idle?: boolean
  readonly status?: AvatarStatus
  /** Tailwind ring color class for the status cut-out (default matches the sidebar). */
  readonly statusRingClassName?: string
  /** Eye color (default white). The activity row uses the chrome color. */
  readonly eyeColor?: string
  /** Paint a cut-out outline of this color around the body (overlapping group avatars). */
  readonly outlineColor?: string
  /** Dashed placeholder ("Create new Bot"). */
  readonly ghost?: boolean
  /** Accessible name; when omitted the avatar is decorative. */
  readonly label?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const statusClass: Record<AvatarStatus, string> = {
  working: "bg-success",
  attention: "bg-warn",
  offline: "bg-icon-tertiary",
  error: "bg-danger",
  unread: "bg-accent-fg",
}

const gazeOffset: Record<AvatarGaze, readonly [number, number]> = {
  center: [0, 0],
  left: [-8, 1],
  right: [8, -1],
  up: [1, -8],
  down: [0, 7],
}

/** Small avatars get chunkier eyes so they still read at 16–22 px. */
const sizeBoost = (size: number) => (size <= 20 ? 1.35 : size <= 28 ? 1.18 : 1)

interface EyeSpec {
  readonly kind: "capsule" | "arc"
  readonly w: number
  readonly h: number
  readonly dy?: number
}

const eyes = (expression: AvatarExpression): readonly [EyeSpec, EyeSpec, number /* spacing */, readonly [number, number] /* shift */] => {
  switch (expression) {
    case "happy":
      return [{ kind: "arc", w: 15, h: 9 }, { kind: "arc", w: 15, h: 9 }, 25, [0, 1]]
    case "surprised":
      return [{ kind: "capsule", w: 14, h: 26 }, { kind: "capsule", w: 14, h: 26 }, 27, [0, -1]]
    case "sleepy":
      return [{ kind: "capsule", w: 16, h: 6, dy: 5 }, { kind: "capsule", w: 16, h: 6, dy: 5 }, 25, [0, 0]]
    case "inspecting":
      return [{ kind: "capsule", w: 11, h: 11, dy: 5 }, { kind: "capsule", w: 11, h: 22 }, 24, [5, -1]]
    case "neutral":
      return [{ kind: "capsule", w: 11, h: 22 }, { kind: "capsule", w: 11, h: 22 }, 24, [0, 0]]
  }
}

const Eye = ({ spec, x, y, scale, color }: { spec: EyeSpec; x: number; y: number; scale: number; color: string }) => {
  const w = spec.w * scale
  const h = spec.h * scale
  const cy = y + (spec.dy ?? 0) * scale
  return (
    <g transform={`translate(${x.toFixed(2)} ${cy.toFixed(2)})`}>
      <g className="ob-avatar-eye">
        {spec.kind === "capsule" ? (
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) / 2} fill={color} />
        ) : (
          <path
            d={`M${(-w / 2).toFixed(2)} ${(h / 2).toFixed(2)}Q0 ${(-h * 1.1).toFixed(2)} ${(w / 2).toFixed(2)} ${(h / 2).toFixed(2)}`}
            fill="none"
            stroke={color}
            strokeWidth={5.5 * scale}
            strokeLinecap="round"
          />
        )}
      </g>
    </g>
  )
}

/** A bot avatar: original SVG body × 11 colors, two capsule eyes, expressions and a working animation. */
export function Avatar({
  shape,
  color,
  size = 36,
  expression = "neutral",
  gaze = "center",
  working = false,
  idle = false,
  status,
  statusRingClassName = "ring-sidebar",
  eyeColor = "#ffffff",
  ghost = false,
  outlineColor,
  label,
  className,
  style,
}: AvatarProps): ReactNode {
  const avatar = normalizeAvatar({ ...(shape ? { shape } : {}), ...(color ? { color } : {}) })
  const body = avatarBodies[avatar.shape]
  const fill = avatarFill(avatar.color)
  const [left, right, spacing, shift] = eyes(expression)
  const scale = body.eyeScale * sizeBoost(size)
  const g = gazeOffset[gaze]
  const cx = body.face[0] + (shift[0] + g[0]) * body.eyeScale
  const cy = body.face[1] + (shift[1] + g[1]) * body.eyeScale
  const half = (spacing * scale) / 2
  const dot = size >= 56 ? 10 : 8
  return (
    <span
      className={cn("ob-avatar relative inline-flex shrink-0 align-middle", className)}
      style={{ width: size, height: size, ...style }}
      data-shape={avatar.shape}
      data-color={avatar.color}
      data-expression={expression}
      {...(working ? { "data-working": "" } : {})}
      {...(idle && !working ? { "data-idle": "" } : {})}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} className="overflow-visible" focusable="false">
        <g className="ob-avatar-body">
          {outlineColor && <path d={body.d} fill={outlineColor} stroke={outlineColor} strokeWidth={(3 / size) * 200} strokeLinejoin="round" />}
          {ghost ? (
            <path d={body.d} fill={fill} fillOpacity={0.12} stroke={fill} strokeWidth={4} strokeDasharray="9 7" strokeLinecap="round" />
          ) : (
            <path d={body.d} fill={fill} />
          )}
          {!ghost && (
            <g className="ob-avatar-eyes">
              <Eye spec={left} x={cx - half} y={cy} scale={scale} color={eyeColor} />
              <Eye spec={right} x={cx + half} y={cy} scale={scale} color={eyeColor} />
            </g>
          )}
        </g>
      </svg>
      {status && (
        <span
          className={cn("absolute rounded-full ring-2", statusClass[status], statusRingClassName)}
          style={{ width: dot, height: dot, right: size >= 56 ? 3 : 0, bottom: size >= 56 ? 3 : 0 }}
          data-status={status}
        />
      )}
    </span>
  )
}

export interface AvatarStackProps {
  readonly avatars: ReadonlyArray<{ readonly shape?: string; readonly color?: string; readonly key?: string }>
  readonly size?: number
  /** Cut-out color separating overlapped avatars (match the background). */
  readonly outlineColor?: string
  readonly className?: string
}

/** Group avatar: 2–3 member avatars overlapped diagonally, each cut out with a background-colored outline. */
export function AvatarStack({ avatars, size = 36, outlineColor = "var(--ob-sidebar)", className }: AvatarStackProps): ReactNode {
  const shown = avatars.slice(0, 3)
  const inner = Math.round(size * (shown.length > 2 ? 0.6 : 0.68))
  const positions: ReadonlyArray<readonly [number, number]> =
    shown.length > 2
      ? [
          [(size - inner) / 2, 0],
          [0, size - inner],
          [size - inner, size - inner],
        ]
      : [
          [0, 0],
          [size - inner, size - inner],
        ]
  return (
    <span className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }} aria-hidden>
      {shown.map((a, i) => {
        const [x, y] = positions[i] ?? [0, 0]
        return (
          <span key={a.key ?? i} className="absolute inline-flex" style={{ left: x, top: y }}>
            <Avatar shape={a.shape} color={a.color} size={inner} {...(i === 0 ? {} : { outlineColor })} />
          </span>
        )
      })}
    </span>
  )
}
