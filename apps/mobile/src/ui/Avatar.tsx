// A bot's avatar: the web app's bodies (@openbot/ui/avatar-model) drawn with react-native-svg, two
// capsule eyes. Group chats overlap up to three members.
import { avatarBodies, normalizeAvatar } from "@openbot/ui/avatar-model"
import type { ReactNode } from "react"
import { View } from "react-native"
import Svg, { Path, Rect } from "react-native-svg"
import { avatarColor, useTheme } from "../theme.ts"

/** Small avatars get chunkier eyes so they still read (the web's `sizeBoost`). */
const sizeBoost = (size: number) => (size <= 20 ? 1.35 : size <= 28 ? 1.18 : 1)

export function Avatar({
  avatar,
  size = 36,
  outline,
}: {
  readonly avatar: { readonly shape?: string; readonly color?: string } | undefined
  readonly size?: number
  /** a cut-out of this color around the body (overlapping group avatars) */
  readonly outline?: string
}): ReactNode {
  const theme = useTheme()
  const a = normalizeAvatar(avatar)
  const body = avatarBodies[a.shape]
  const scale = body.eyeScale * sizeBoost(size)
  const [cx, cy] = body.face
  const half = (24 * scale) / 2
  const w = 11 * scale
  const h = 22 * scale
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: "visible" }}>
      {outline && (
        <Path d={body.d} fill={outline} stroke={outline} strokeWidth={(3 / size) * 200} strokeLinejoin="round" />
      )}
      <Path d={body.d} fill={avatarColor(a.color, theme.dark)} />
      <Rect x={cx - half - w / 2} y={cy - h / 2} width={w} height={h} rx={w / 2} fill="#ffffff" />
      <Rect x={cx + half - w / 2} y={cy - h / 2} width={w} height={h} rx={w / 2} fill="#ffffff" />
    </Svg>
  )
}

export function AvatarStack({
  avatars,
  size = 40,
  outline,
}: {
  readonly avatars: ReadonlyArray<{ readonly shape?: string; readonly color?: string } | undefined>
  readonly size?: number
  readonly outline: string
}): ReactNode {
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
    <View style={{ width: size, height: size }}>
      {shown.map((a, i) => {
        const [x, y] = positions[i] ?? [0, 0]
        return (
          <View key={i} style={{ position: "absolute", left: x, top: y }}>
            <Avatar avatar={a} size={inner} {...(i === 0 ? {} : { outline })} />
          </View>
        )
      })}
    </View>
  )
}
