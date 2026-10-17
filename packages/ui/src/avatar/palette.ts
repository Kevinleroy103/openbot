/**
 * Avatar palette + default-avatar rule. `@openbot/ui` cannot import `@openbot/contracts`, so this file
 * MIRRORS `AvatarColors`, `AvatarShapes`, `fnv1a32` and `defaultBotAvatar` from
 * packages/contracts/src/domain.ts (docs/interfaces.md §8.9). Keep the arrays in the same order.
 */

export const AvatarColors = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const
export type AvatarColor = (typeof AvatarColors)[number]

export const AvatarShapes = ["blob", "cloud", "square", "sparkle", "clover", "heart", "flower", "teardrop", "tablet", "wedge", "house", "star", "hex"] as const
export type AvatarShape = (typeof AvatarShapes)[number]

export const AvatarExpressions = ["neutral", "happy", "surprised", "sleepy", "inspecting"] as const
export type AvatarExpression = (typeof AvatarExpressions)[number]

/** 32-bit FNV-1a over the UTF-16 code units of `text` (unsigned). Same as contracts. */
export const fnv1a32 = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Deterministic default avatar for a bot id: shape = AvatarShapes[h % 13], color = AvatarColors[floor(h / 13) % 11]. */
export const defaultBotAvatar = (id: string): { readonly shape: AvatarShape; readonly color: AvatarColor } => {
  const hash = fnv1a32(id)
  return {
    shape: AvatarShapes[hash % AvatarShapes.length]!,
    color: AvatarColors[Math.floor(hash / AvatarShapes.length) % AvatarColors.length]!,
  }
}

export const isAvatarColor = (value: string): value is AvatarColor => (AvatarColors as ReadonlyArray<string>).includes(value)
export const isAvatarShape = (value: string): value is AvatarShape => (AvatarShapes as ReadonlyArray<string>).includes(value)

/** Stored avatars are open strings; unknown values fall back so old/new data never breaks rendering. */
export const normalizeAvatar = (avatar: { readonly shape?: string; readonly color?: string } | undefined): { shape: AvatarShape; color: AvatarColor } => ({
  shape: avatar?.shape && isAvatarShape(avatar.shape) ? avatar.shape : "blob",
  color: avatar?.color && isAvatarColor(avatar.color) ? avatar.color : "gray",
})

/** CSS color for an avatar body (theme-aware CSS variable from tokens.css). */
export const avatarFill = (color: AvatarColor): string => `var(--ob-avatar-${color})`

/** Theme hue (tokens.css `--ob-<hue>*`) for a bot color; black and gray are neutral (no tint). */
export const avatarHue = (color: AvatarColor): string | undefined => {
  switch (color) {
    case "black":
    case "gray":
      return undefined
    case "violet":
      return "purple"
    default:
      return color
  }
}

/**
 * Per-bot tint ("Accent: Bot color", grok-design-system.md PER-BOT TINT): CSS variables to put on the chat
 * container so the accent, the user bubble and the send button take the bot's hue. Neutral colors return
 * `{}`. `branded` also tints the agent bubble with the hue's soft fill.
 */
export const botTintStyle = (color: string, options?: { readonly branded?: boolean }): Record<string, string> => {
  if (!isAvatarColor(color)) return {}
  const hue = avatarHue(color)
  if (!hue) return {}
  const style: Record<string, string> = {
    "--ob-accent": `var(--ob-${hue})`,
    "--ob-accent-hover": `var(--ob-${hue}-hover)`,
    "--ob-accent-soft": `var(--ob-${hue}-soft)`,
    "--ob-accent-bright": `var(--ob-${hue}-bright)`,
    "--ob-accent-fg": `var(--ob-${hue}-fg)`,
    "--ob-bubble-user": `var(--ob-${hue}-bubble)`,
    "--ob-fg-on-primary": "#ffffff",
  }
  if (options?.branded) style["--ob-bubble-agent"] = `var(--ob-${hue}-soft)`
  return style
}
