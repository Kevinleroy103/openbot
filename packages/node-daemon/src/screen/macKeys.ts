// Keys on a Mac: the `computer` tool's key names (as xdotool keysyms from ../desktop/keys.ts, with
// cmd kept as `super` = Command) and the web viewer's DOM `KeyboardEvent.code` → macOS virtual key
// codes (Carbon `kVK_*`, ANSI positions) and CGEvent modifier flags.

/** CGEventFlags masks. */
export const MAC_FLAGS = {
  shift: 0x20000,
  ctrl: 0x40000,
  alt: 0x80000,
  super: 0x100000,
} as const
export type MacModifier = keyof typeof MAC_FLAGS

/** Virtual key codes of the modifier keys (left side). */
export const MODIFIER_KEYCODES: Readonly<Record<MacModifier, number>> = { shift: 56, ctrl: 59, alt: 58, super: 55 }

const LETTERS: Readonly<Record<string, number>> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
}
const DIGITS: Readonly<Record<string, number>> = {
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "5": 23,
  "6": 22,
  "7": 26,
  "8": 28,
  "9": 25,
  "0": 29,
}

/** Unshifted punctuation keysyms. */
const PUNCT: Readonly<Record<string, number>> = {
  equal: 24,
  minus: 27,
  bracketright: 30,
  bracketleft: 33,
  apostrophe: 39,
  semicolon: 41,
  backslash: 42,
  comma: 43,
  slash: 44,
  period: 47,
  grave: 50,
  space: 49,
}
/** Shifted punctuation keysyms → the unshifted key they are typed with. */
const SHIFTED: Readonly<Record<string, number>> = {
  exclam: 18,
  at: 19,
  numbersign: 20,
  dollar: 21,
  percent: 23,
  asciicircum: 22,
  ampersand: 26,
  asterisk: 28,
  parenleft: 25,
  parenright: 29,
  underscore: 27,
  plus: 24,
  braceleft: 33,
  braceright: 30,
  bar: 42,
  colon: 41,
  quotedbl: 39,
  less: 43,
  greater: 47,
  question: 44,
  asciitilde: 50,
}

const NAMED: Readonly<Record<string, number>> = {
  Return: 36,
  KP_Enter: 76,
  Tab: 48,
  BackSpace: 51,
  Escape: 53,
  Delete: 117,
  Insert: 114,
  Home: 115,
  End: 119,
  Page_Up: 116,
  Page_Down: 121,
  Left: 123,
  Right: 124,
  Down: 125,
  Up: 126,
  Caps_Lock: 57,
  Help: 114,
  KP_0: 82,
  KP_1: 83,
  KP_2: 84,
  KP_3: 85,
  KP_4: 86,
  KP_5: 87,
  KP_6: 88,
  KP_7: 89,
  KP_8: 91,
  KP_9: 92,
  KP_Decimal: 65,
  KP_Multiply: 67,
  KP_Add: 69,
  KP_Subtract: 78,
  KP_Divide: 75,
  KP_Equal: 81,
}
const FKEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]

export interface MacKey {
  readonly keyCode: number
  /** modifier flags the key needs (shift for `A`, `!`, …) */
  readonly flags: number
}

/** One keysym → key code (+ shift when the keysym is a shifted character). Undefined when unknown. */
export const macKey = (keysym: string): MacKey | undefined => {
  if (keysym.length === 1) {
    const lower = keysym.toLowerCase()
    if (LETTERS[lower] !== undefined) return { keyCode: LETTERS[lower]!, flags: keysym !== lower ? MAC_FLAGS.shift : 0 }
    if (DIGITS[keysym] !== undefined) return { keyCode: DIGITS[keysym]!, flags: 0 }
  }
  if (keysym in MODIFIER_KEYCODES) return { keyCode: MODIFIER_KEYCODES[keysym as MacModifier], flags: 0 }
  if (PUNCT[keysym] !== undefined) return { keyCode: PUNCT[keysym]!, flags: 0 }
  if (SHIFTED[keysym] !== undefined) return { keyCode: SHIFTED[keysym]!, flags: MAC_FLAGS.shift }
  if (NAMED[keysym] !== undefined) return { keyCode: NAMED[keysym]!, flags: 0 }
  const f = /^F([1-9]|1[0-9]|20)$/.exec(keysym)
  if (f) return { keyCode: FKEYS[Number(f[1]) - 1]!, flags: 0 }
  return undefined
}

/** `"super+shift+t"` → the key with every modifier's flag. A lone modifier is that modifier key. */
export const macCombo = (combo: string): MacKey | undefined => {
  const parts = combo.split(/\+(?=.)/)
  const last = parts.at(-1)!
  let flags = 0
  for (const p of parts.slice(0, -1)) {
    if (!(p in MAC_FLAGS)) return undefined
    flags |= MAC_FLAGS[p as MacModifier]
  }
  const key = macKey(last)
  if (key === undefined) return undefined
  return { keyCode: key.keyCode, flags: flags | key.flags }
}

/** Modifier flags for held keysyms (`hold` of a plan); non-modifiers add nothing. */
export const flagsOf = (keysyms: ReadonlyArray<string>): number =>
  keysyms.reduce((f, k) => (k in MAC_FLAGS ? f | MAC_FLAGS[k as MacModifier] : f), 0)

/** DOM `KeyboardEvent.code` → key code (the web viewer's keyboard while the owner has control). */
const DOM_CODES: Readonly<Record<string, number>> = {
  Enter: 36,
  NumpadEnter: 76,
  Tab: 48,
  Space: 49,
  Backspace: 51,
  Escape: 53,
  Delete: 117,
  Insert: 114,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  CapsLock: 57,
  ShiftLeft: 56,
  ShiftRight: 60,
  ControlLeft: 59,
  ControlRight: 62,
  AltLeft: 58,
  AltRight: 61,
  MetaLeft: 55,
  MetaRight: 54,
  Minus: 27,
  Equal: 24,
  BracketLeft: 33,
  BracketRight: 30,
  Backslash: 42,
  Semicolon: 41,
  Quote: 39,
  Backquote: 50,
  Comma: 43,
  Period: 47,
  Slash: 44,
  IntlBackslash: 10,
  Numpad0: 82,
  Numpad1: 83,
  Numpad2: 84,
  Numpad3: 85,
  Numpad4: 86,
  Numpad5: 87,
  Numpad6: 88,
  Numpad7: 89,
  Numpad8: 91,
  Numpad9: 92,
  NumpadDecimal: 65,
  NumpadMultiply: 67,
  NumpadAdd: 69,
  NumpadSubtract: 78,
  NumpadDivide: 75,
}

export const domCodeToMac = (code: string | undefined): number | undefined => {
  if (code === undefined) return undefined
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return LETTERS[letter[1]!.toLowerCase()]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return DIGITS[digit[1]!]
  const f = /^F([1-9]|1[0-9]|20)$/.exec(code)
  if (f) return FKEYS[Number(f[1]) - 1]
  return DOM_CODES[code]
}

/** DOM modifiers → CGEvent flags (meta is Command). */
export const domFlags = (
  m:
    | {
        readonly alt?: boolean | undefined
        readonly ctrl?: boolean | undefined
        readonly meta?: boolean | undefined
        readonly shift?: boolean | undefined
      }
    | undefined,
): number =>
  (m?.shift ? MAC_FLAGS.shift : 0) |
  (m?.ctrl ? MAC_FLAGS.ctrl : 0) |
  (m?.alt ? MAC_FLAGS.alt : 0) |
  (m?.meta ? MAC_FLAGS.super : 0)
