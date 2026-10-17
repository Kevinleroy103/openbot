// Playwright-style key combos ("Enter", "Control+a", "Shift+Tab") → CDP Input.dispatchKeyEvent params.

export interface KeyEventParams {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly text?: string | undefined
  readonly modifiers: number
}

/** CDP modifier bits. */
export const Modifier = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const

const MODIFIER_ALIASES: Record<string, keyof typeof Modifier> = {
  alt: "Alt",
  option: "Alt",
  control: "Control",
  ctrl: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  shift: "Shift",
}

const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
}
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i }

const PUNCT: Record<string, { code: string; vk: number }> = {
  "-": { code: "Minus", vk: 189 },
  "=": { code: "Equal", vk: 187 },
  "[": { code: "BracketLeft", vk: 219 },
  "]": { code: "BracketRight", vk: 221 },
  ";": { code: "Semicolon", vk: 186 },
  "'": { code: "Quote", vk: 222 },
  ",": { code: "Comma", vk: 188 },
  ".": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 },
  "\\": { code: "Backslash", vk: 220 },
  "`": { code: "Backquote", vk: 192 },
}

/** Key descriptor for a single key name (no modifiers). */
export const describeKey = (name: string): { key: string; code: string; vk: number; text?: string } | undefined => {
  const named = NAMED[name.toLowerCase()]
  if (named) return named
  if (name.length === 1) {
    const ch = name
    const upper = ch.toUpperCase()
    if (/[a-z]/i.test(ch)) return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch }
    if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch }
    const p = PUNCT[ch]
    return { key: ch, code: p?.code ?? "", vk: p?.vk ?? 0, text: ch }
  }
  return undefined
}

/** Parse "Control+Shift+a". Returns undefined for an unknown key. */
export const parseKeyCombo = (combo: string): KeyEventParams | undefined => {
  const parts = combo === "+" ? ["+"] : combo.split("+").map((p) => p.trim())
  if (parts.length === 0) return undefined
  let modifiers = 0
  for (const m of parts.slice(0, -1)) {
    const alias = MODIFIER_ALIASES[m.toLowerCase()]
    if (!alias) return undefined
    modifiers |= Modifier[alias]
  }
  const last = parts[parts.length - 1] ?? ""
  const lastAlias = MODIFIER_ALIASES[last.toLowerCase()]
  if (lastAlias) {
    return { key: lastAlias, code: `${lastAlias}Left`, windowsVirtualKeyCode: { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[lastAlias], modifiers: modifiers | Modifier[lastAlias] }
  }
  const k = describeKey(last)
  if (!k) return undefined
  const shifted = (modifiers & Modifier.Shift) !== 0
  const textAllowed = (modifiers & (Modifier.Control | Modifier.Meta | Modifier.Alt)) === 0
  let text = textAllowed ? k.text : undefined
  let key = k.key
  if (text && shifted && /^[a-z]$/.test(text)) {
    text = text.toUpperCase()
    key = text
  }
  return { key, code: k.code, windowsVirtualKeyCode: k.vk, text, modifiers }
}

/** Modifier bits from a `{alt, ctrl, meta, shift}` object. */
export const modifierBits = (m: { readonly alt?: boolean | undefined; readonly ctrl?: boolean | undefined; readonly meta?: boolean | undefined; readonly shift?: boolean | undefined } | undefined): number =>
  m ? (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0) : 0
