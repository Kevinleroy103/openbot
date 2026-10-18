// A Bot's avatar as a PNG data URL, for system notifications (they take an image, not our SVG
// component): its body in its color (resolved from the theme's `--ob-avatar-<color>`) with two white
// capsule eyes, like `Avatar` draws it. Cached per shape, color and theme.
import { avatarBodies, normalizeAvatar } from "@openbot/ui"

const SIZE = 256
const cache = new Map<string, Promise<string | undefined>>()

/** The theme's color for an avatar color, as `rgb(…)`. */
const resolvedFill = (color: string): string => {
  const probe = document.createElement("span")
  probe.style.display = "none"
  probe.style.color = `var(--ob-avatar-${color})`
  document.body.append(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value || "#8e8e8e"
}

const draw = async (shape: string, color: string): Promise<string | undefined> => {
  const avatar = normalizeAvatar({ shape, color })
  const body = avatarBodies[avatar.shape]
  const scale = body.eyeScale
  const [cx, cy] = body.face
  const w = 11 * scale
  const h = 22 * scale
  const half = 12 * scale
  const eye = (x: number) =>
    `<rect x="${(x - w / 2).toFixed(2)}" y="${(cy - h / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${(w / 2).toFixed(2)}" fill="#fff"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 116 116" width="${SIZE}" height="${SIZE}"><path d="${body.d}" fill="${resolvedFill(avatar.color)}"/>${eye(cx - half)}${eye(cx + half)}</svg>`
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext("2d")
  if (context === null) return undefined
  context.drawImage(image, 0, 0, SIZE, SIZE)
  return canvas.toDataURL("image/png")
}

export const botIconUrl = (avatar: { readonly shape: string; readonly color: string }): Promise<string | undefined> => {
  const key = `${avatar.shape}:${avatar.color}:${document.documentElement.dataset.theme ?? ""}`
  let icon = cache.get(key)
  if (icon === undefined) {
    icon = draw(avatar.shape, avatar.color).catch(() => undefined)
    cache.set(key, icon)
  }
  return icon
}
