// Key names of the `computer` tool → xdotool keysyms. Anthropic's computer use speaks xdotool's
// `key` syntax ("Return", "ctrl+l", "alt+Tab", "KP_0"); models also send DOM / macOS names
// ("Enter", "ArrowDown", "cmd+c"), which are mapped here. Unknown names pass through unchanged
// (xdotool resolves any X keysym name, and maps other single characters itself).

const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  // a Linux desktop has no Command key: copy/paste/select-all shortcuts use Ctrl
  cmd: "ctrl",
  command: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  super: "super",
  win: "super",
  windows: "super",
  meta: "super",
}

const NAMED: Record<string, string> = {
  enter: "Return",
  return: "Return",
  kp_enter: "KP_Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  back_space: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  page_up: "Page_Up",
  pgup: "Page_Up",
  prior: "Page_Up",
  pagedown: "Page_Down",
  page_down: "Page_Down",
  pgdn: "Page_Down",
  next: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrow_up: "Up",
  arrow_down: "Down",
  arrow_left: "Left",
  arrow_right: "Right",
  space: "space",
  spacebar: "space",
  capslock: "Caps_Lock",
  caps_lock: "Caps_Lock",
  numlock: "Num_Lock",
  num_lock: "Num_Lock",
  scrolllock: "Scroll_Lock",
  printscreen: "Print",
  print: "Print",
  prtsc: "Print",
  menu: "Menu",
  contextmenu: "Menu",
  pause: "Pause",
  break: "Break",
  plus: "plus",
  minus: "minus",
}

const PUNCTUATION: Record<string, string> = {
  " ": "space",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  ":": "colon",
  "'": "apostrophe",
  '"': "quotedbl",
  "`": "grave",
  "~": "asciitilde",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  "[": "bracketleft",
  "]": "bracketright",
  "{": "braceleft",
  "}": "braceright",
  "<": "less",
  ">": "greater",
  "?": "question",
  _: "underscore",
  "|": "bar",
}

/**
 * A modifier name → keysym. On a Mac (`mac`) Command is a key of its own: cmd / command stay
 * `super` (the Command key) instead of becoming Ctrl.
 */
const modifierOf = (lower: string, mac: boolean): string | undefined => {
  const base = lower.replace(/_[lr]$/, "")
  if (mac && (base === "cmd" || base === "command")) return "super"
  return MODIFIERS[lower] ?? MODIFIERS[base]
}

/** One key name → xdotool keysym (modifiers, named keys, F-keys, punctuation; others unchanged). */
export const xdoKeyName = (name: string, mac = false): string => {
  if (name.length === 1) return PUNCTUATION[name] ?? name
  const lower = name.toLowerCase()
  const mod = modifierOf(lower, mac)
  if (mod) return mod
  const named = NAMED[lower]
  if (named) return named
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (f) return `F${f[1]}`
  return name
}

/** `"ctrl+shift+t"` → `"ctrl+shift+t"`, `"cmd+c"` → `"ctrl+c"`, `"ctrl++"` → `"ctrl+plus"`. Undefined when empty. */
export const xdoCombo = (combo: string, mac = false): string | undefined => {
  const trimmed = combo.trim()
  if (trimmed === "") return undefined
  // split on "+" that is followed by something, so a trailing "+" is the plus key ("ctrl++")
  const parts = trimmed.split(/\+(?=.)/).map((p) => p.trim())
  // "ctrl+" (a modifier with nothing after it) is malformed; a lone "+" is the plus key
  if (parts.some((p) => p === "" || (p.length > 1 && p.endsWith("+")))) return undefined
  return parts.map((p) => xdoKeyName(p, mac)).join("+")
}

/**
 * The `key` action's text: one combo, or several separated by spaces (xdotool presses them in
 * order: `"ctrl+a Delete"`). Returns the xdotool arguments, or undefined when there is no key.
 */
export const xdoKeySequence = (text: string | undefined, mac = false): ReadonlyArray<string> | undefined => {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed === "") return text.length > 0 && text.trim() === "" ? ["space"] : undefined
  const combos: Array<string> = []
  for (const token of trimmed.split(/\s+/)) {
    const c = xdoCombo(token, mac)
    if (c === undefined) return undefined
    combos.push(c)
  }
  return combos
}

/**
 * Modifier keys held during a click or scroll (`text: "shift"` or `"ctrl+shift"`), as keysyms for
 * `xdotool keydown`. Undefined when the text names something other than modifier keys.
 */
export const heldModifiers = (text: string | undefined, mac = false): ReadonlyArray<string> | undefined => {
  if (text === undefined || text.trim() === "") return []
  const parts = text
    .trim()
    .split(/[+\s]+/)
    .filter((p) => p !== "")
  const out: Array<string> = []
  for (const p of parts) {
    const mod = modifierOf(p.toLowerCase(), mac)
    if (!mod) return undefined
    if (!out.includes(mod)) out.push(mod)
  }
  return out
}

/** Keys pressed for `hold_key` (`"shift"`, `"ctrl+alt"`, `"a"`), released in reverse order. */
export const holdKeys = (text: string | undefined, mac = false): ReadonlyArray<string> | undefined => {
  const c = text === undefined ? undefined : xdoCombo(text, mac)
  return c === undefined ? undefined : c.split(/\+(?=.)/)
}
