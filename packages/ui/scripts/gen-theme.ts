/**
 * OpenBot token generator (Tailwind v4). Port of the grok-ds prototype generator
 * (vendor/scratch/grok-ds/proto/gen-theme.ts, an OpenBot research artifact), reading the measured
 * "Sand" theme values from `./sand-values.ts` instead of the vendor JSON.
 *
 *   bun run packages/ui/scripts/gen-theme.ts        → rewrites packages/ui/src/tokens.css
 *
 * Output is a pure function of the tables below: no timestamps, stable ordering, so regeneration is
 * byte-for-byte deterministic (see test/tokens.test.ts).
 *
 * Every theme value is emitted as `light-dark(LIGHT, DARK)` on `:root`, so `[data-theme]` (or any
 * `color-scheme`) on a subtree switches theme with no other CSS. Dark is the default.
 */
import { sandValues } from "./sand-values.ts"

/** [sand key, OpenBot token name] — the semantic surface/text/icon/border set. */
const semantic: ReadonlyArray<readonly [string, string]> = [
  ["bg-pane", "pane"],
  ["bg-chrome", "chrome"],
  ["bg-sidebar", "sidebar"],
  ["bg-elevated", "elevated"],
  ["bg-elevated-hover", "elevated-hover"],
  ["bg-luminous", "luminous"],
  ["bg-scrim", "scrim"],
  ["bg-scrim-heavy", "scrim-heavy"],
  ["bg-hover", "hover"],
  ["bg-active", "active"],
  ["bg-primary", "primary"],
  ["bg-primary-hover", "primary-hover"],
  ["bg-primary-disabled", "primary-disabled"],
  ["bg-secondary", "secondary"],
  ["bg-secondary-hover", "secondary-hover"],
  ["bg-secondary-disabled", "secondary-disabled"],
  ["bg-tertiary", "tertiary"],
  ["bg-quaternary", "quaternary"],
  ["fill-bubble-agent", "bubble-agent"],
  ["fill-bubble-user", "bubble-user"],
  ["text-primary", "fg"],
  ["text-secondary", "fg-secondary"],
  ["text-tertiary", "fg-tertiary"],
  ["text-quaternary", "fg-quaternary"],
  ["text-on-primary", "fg-on-primary"],
  ["text-inverted", "fg-inverted"],
  ["icon-primary", "icon"],
  ["icon-secondary", "icon-secondary"],
  ["icon-tertiary", "icon-tertiary"],
  ["icon-quaternary", "icon-quaternary"],
  ["icon-official", "icon-official"],
  ["border-primary-translucent", "line"],
  ["border-secondary-translucent", "line-secondary"],
  ["border-tertiary-translucent", "line-tertiary"],
  ["border-quaternary-translucent", "line-quaternary"],
  ["border-focus-primary", "focus"],
]

const roles = ["accent", "danger", "success", "warn"] as const
export const hues = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta", "brown"] as const

const shadows: ReadonlyArray<readonly [string, string]> = [
  ["shadow-control", "sh-control"],
  ["shadow-card", "sh-card"],
  ["shadow-inline-ambient", "sh-inline-ambient"],
  ["shadow-inline-key", "sh-inline-key"],
  ["shadow-popover-ambient", "sh-popover-ambient"],
  ["shadow-popover-key", "sh-popover-key"],
  ["shadow-modal-ambient", "sh-modal-ambient"],
  ["shadow-modal-key", "sh-modal-key"],
  ["shadow-window-ambient", "sh-window-ambient"],
  ["shadow-window-edge", "sh-window-edge"],
  ["shadow-ring", "sh-ring"],
]

/**
 * Bot avatar body colors (D6.3; order mirrors `AvatarColors` in @openbot/contracts). Hues reuse the
 * theme's "bright" step; black and gray are OpenBot choices (black lifts to charcoal in dark mode so it
 * stays visible on the #0e0e0e sidebar).
 */
const avatarColors: ReadonlyArray<readonly [name: string, value: string]> = [
  ["black", "light-dark(#1c1c1c, #3a3a3a)"],
  ["brown", "var(--ob-brown-bright)"],
  ["red", "var(--ob-red-bright)"],
  ["orange", "var(--ob-orange-bright)"],
  ["yellow", "var(--ob-yellow-bright)"],
  ["green", "var(--ob-green-bright)"],
  ["cyan", "var(--ob-cyan-bright)"],
  ["blue", "var(--ob-blue-bright)"],
  ["violet", "var(--ob-purple-bright)"],
  ["magenta", "var(--ob-magenta-bright)"],
  ["gray", "light-dark(#8e8e8e, #7a7a7a)"],
]

const buildMap = (): Array<readonly [string, string]> => {
  const map: Array<readonly [string, string]> = [...semantic]
  for (const r of roles)
    map.push(
      [`bg-${r}-primary`, r],
      [`bg-${r}-primary-hover`, `${r}-hover`],
      [`bg-${r}-primary-disabled`, `${r}-disabled`],
      [`bg-${r}-secondary`, `${r}-soft`],
      [`bg-${r}-secondary-hover`, `${r}-soft-hover`],
      [`bg-${r}-secondary-disabled`, `${r}-soft-disabled`],
      [`bg-${r}-bright`, `${r}-bright`],
      [`text-${r}-primary`, `${r}-fg`],
      [`border-${r}-quaternary`, `${r}-line-faint`],
    )
  for (const h of hues)
    map.push(
      [`bg-${h}-primary`, h],
      [`bg-${h}-primary-hover`, `${h}-hover`],
      [`bg-${h}-secondary`, `${h}-soft`],
      [`bg-${h}-bright`, `${h}-bright`],
      [`text-${h}-primary`, `${h}-fg`],
      [`fill-${h}-bubble-user`, `${h}-bubble`],
    )
  return map
}

const pad = (x: string, n: number) => x + " ".repeat(Math.max(1, n - x.length))

const value = (sandKey: string): readonly [string, string] => {
  const v = sandValues[sandKey]
  if (!v) throw new Error(`gen-theme: missing sand value ${sandKey}`)
  return v
}

const STATIC = `/* 4. Type, radii, elevation, motion (Grok Bot "sand" scale; docs/research/grok-design-system.md). */
@theme {
  --font-sans: "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  /* size / line-height / tracking */
  --text-2xs: 11px;  --text-2xs--line-height: 16px;  --text-2xs--letter-spacing: .005em;  /* caption    */
  --text-xs: 12px;   --text-xs--line-height: 16px;   --text-xs--letter-spacing: 0em;      /* label      */
  --text-sm: 13px;   --text-sm--line-height: 18px;   --text-sm--letter-spacing: 0em;      /* body2      */
  --text-base: 14px; --text-base--line-height: 20px; --text-base--letter-spacing: 0em;    /* body1      */
  --text-lg: 15px;   --text-lg--line-height: 22px;   --text-lg--letter-spacing: 0em;      /* chat prose */
  --text-xl: 17px;   --text-xl--line-height: 24px;   --text-xl--letter-spacing: -.008em;  /* heading3   */
  --text-2xl: 22px;  --text-2xl--line-height: 28px;  --text-2xl--letter-spacing: -.012em; /* heading2   */
  --text-3xl: 26px;  --text-3xl--line-height: 32px;  --text-3xl--letter-spacing: -.015em; /* heading1   */

  --radius-xs: 2px;          /* quote bars */
  --radius-sm: 4px;          /* key caps, tiny badges, label chips */
  --radius-md: 6px;          /* menu rows, square icon buttons, tooltips */
  --radius-lg: 8px;          /* inputs, ghost selects */
  --radius-xl: 10px;         /* sidebar rows, sheets, banners */
  --radius-2xl: 12px;        /* menus, pinned grid, screen cards */
  --radius-3xl: 14px;        /* dialogs, command palette, settings cards */
  --radius-4xl: 16px;        /* in-chat cards */
  --radius-bubble: 18px;     /* chat bubbles */
  --radius-composer: 22px;   /* collapsed composer (44 / 2) */

  --shadow-control: 0 1px 3px 0 var(--ob-sh-control);
  --shadow-card: 0 0 0 1px var(--ob-line-quaternary), 0 2px 8px var(--ob-sh-card);
  --shadow-inline: 0 4px 12px -1px var(--ob-sh-inline-ambient), 0 2px 4px -2px var(--ob-sh-inline-key), 0 0 0 1px var(--ob-sh-ring);
  --shadow-popover: 0 10px 20px -3px var(--ob-sh-popover-ambient), 0 4px 6px -4px var(--ob-sh-popover-key), 0 0 0 1px var(--ob-sh-ring);
  --shadow-modal: 0 20px 32px -5px var(--ob-sh-modal-ambient), 0 8px 12px -6px var(--ob-sh-modal-key), 0 0 0 1px var(--ob-sh-ring);
  --shadow-window: 0 22px 70px 4px var(--ob-sh-window-ambient), 0 0 0 .5px var(--ob-sh-window-edge);
  --shadow-composer: 0 2px 8px -1px #0000000d, 0 1px 2px #00000008, 0 0 0 1px #e4e4e40a;

  --ease-standard: cubic-bezier(.2, 0, 0, 1);
  --ease-emphasized: cubic-bezier(.1, .9, .2, 1);
  --ease-out-soft: cubic-bezier(.22, 1, .36, 1);
  --ease-out-quint: cubic-bezier(.16, 1, .3, 1);
  --ease-in-out-strong: cubic-bezier(.77, 0, .175, 1);
  --ease-overshoot: cubic-bezier(.34, 1.56, .64, 1);
  --ease-exit: cubic-bezier(.4, 0, 1, 1);
  --ease-spring: linear(0, .01588 2%, .05618 4%, .11201 6%, .1768 8%, .2458 10%, .31562 12%, .38392 14%, .44914 16%, .51029 18%, .56683 20%, .61852 22%, .66534 24%, .70743 26%, .74501 28%, .77838 30%, .80788 32%, .83383 34%, .85658 36%, .87645 38%, .89376 40%, .92183 44%, .94282 48%, .95838 52%, .96984 56%, .97823 60%, .98435 64%, .98878 68%, .99198 72%, .99594 80%, .99829 90%, 1 100%);

  --animate-fade-in: ob-fade-in .13s var(--ease-out-soft) both;
  --animate-blur-in: ob-blur-in .2s ease-out both;
  --animate-pop-in: ob-pop-in .34s var(--ease-overshoot) backwards;
  --animate-rise-in: ob-rise-in .18s var(--ease-out-soft) both;
  --animate-dialog-in: ob-dialog-in .16s var(--ease-out-quint) both;
  --animate-dot: ob-dot 1.4s ease-in-out infinite;
  --animate-shimmer: ob-shimmer 2.2s steps(60) infinite;
  --animate-spin: ob-spin .8s linear infinite;

  @keyframes ob-fade-in { from { opacity: 0 } to { opacity: 1 } }
  @keyframes ob-blur-in { from { opacity: 0; filter: blur(4px) } to { opacity: 1; filter: blur(0) } }
  @keyframes ob-pop-in { from { opacity: 0; transform: scale(.6) } to { opacity: 1; transform: scale(1) } }
  @keyframes ob-rise-in { from { opacity: 0; transform: scale(.92) translateY(4px) } to { opacity: 1; transform: none } }
  @keyframes ob-dialog-in { from { opacity: 0; transform: scale(.97) } to { opacity: 1; transform: none } }
  @keyframes ob-dot { 0%, 60%, 100% { opacity: .35 } 30% { opacity: 1 } }
  @keyframes ob-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
  @keyframes ob-spin { to { transform: rotate(360deg) } }
}

/* 5. Avatar motion (OpenBot original): body bob + squash, eyes glance around, blink. */
@keyframes ob-avatar-bob {
  0%, 100% { transform: translateY(0) scale(1, 1) }
  25% { transform: translateY(-3.5%) scale(.97, 1.03) }
  50% { transform: translateY(0) scale(1.03, .97) }
  75% { transform: translateY(-1.5%) scale(.99, 1.01) }
}
@keyframes ob-avatar-glance {
  0%, 12% { transform: translate(0, 0) }
  22%, 40% { transform: translate(-7%, 2%) }
  52%, 70% { transform: translate(7%, -3%) }
  82%, 100% { transform: translate(0, 0) }
}
@keyframes ob-avatar-blink {
  0%, 44%, 50%, 92%, 100% { transform: scaleY(1) }
  47%, 96% { transform: scaleY(.15) }
}
@keyframes ob-avatar-idle-blink {
  0%, 94%, 100% { transform: scaleY(1) }
  97% { transform: scaleY(.15) }
}
.ob-avatar-body, .ob-avatar-eyes, .ob-avatar-eye { transform-box: fill-box; }
.ob-avatar-body { transform-origin: 50% 100%; }
.ob-avatar-eyes, .ob-avatar-eye { transform-origin: 50% 50%; }
.ob-avatar[data-working] .ob-avatar-body { animation: ob-avatar-bob 1.6s var(--ease-standard) infinite; }
.ob-avatar[data-working] .ob-avatar-eyes { animation: ob-avatar-glance 3.2s var(--ease-out-soft) infinite; }
.ob-avatar[data-working] .ob-avatar-eye { animation: ob-avatar-blink 3.2s linear infinite; }
.ob-avatar[data-idle] .ob-avatar-eye { animation: ob-avatar-idle-blink 5s linear infinite; }

/* 6. Utilities. */
@utility scrollbar-thin {
  scrollbar-width: thin;
  scrollbar-color: var(--ob-line-tertiary) transparent;
}
@utility shimmer-text {
  color: transparent;
  background-image: linear-gradient(90deg,
    var(--ob-shimmer-dim, color-mix(in srgb, var(--ob-shimmer-ink, var(--ob-fg)) 40%, transparent)) 0%,
    var(--ob-shimmer-dim, color-mix(in srgb, var(--ob-shimmer-ink, var(--ob-fg)) 40%, transparent)) 25%,
    var(--ob-shimmer-ink, var(--ob-fg)) 60%,
    var(--ob-shimmer-dim, color-mix(in srgb, var(--ob-shimmer-ink, var(--ob-fg)) 40%, transparent)) 75%,
    var(--ob-shimmer-dim, color-mix(in srgb, var(--ob-shimmer-ink, var(--ob-fg)) 40%, transparent)) 100%);
  background-size: 200% 100%;
  background-clip: text;
  -webkit-background-clip: text;
}
@utility hairline { border-width: .5px; }

@layer base {
  html, body { height: 100%; overscroll-behavior-y: none; }
  body {
    background-color: var(--ob-pane);
    color: var(--ob-fg);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-feature-settings: "calt" 1, "case" 1;
  }
  :focus-visible { outline: 2px solid var(--ob-focus); outline-offset: 1px; }
  ::selection { background-color: var(--ob-accent-soft-hover); }
  @media (prefers-reduced-motion: reduce) {
    *, ::before, ::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; }
  }
}
`

/** Generate the full `tokens.css` text. Pure and deterministic. */
export const generateTokensCss = (): string => {
  const map = buildMap()
  const rows: string[] = []
  for (const [sand, ob] of [...map, ...shadows]) {
    const [l, d] = value(sand)
    rows.push(`  ${pad(`--ob-${ob}:`, 30)}light-dark(${pad(l + ",", 11)}${d});`)
  }
  for (const [name, v] of avatarColors) rows.push(`  ${pad(`--ob-avatar-${name}:`, 30)}${v};`)
  const themeInline = [
    ...map.map(([, ob]) => `  --color-${ob}: var(--ob-${ob});`),
    ...avatarColors.map(([name]) => `  --color-avatar-${name}: var(--ob-avatar-${name});`),
  ].join("\n")
  return `/* ===== OpenBot design tokens — GENERATED by packages/ui/scripts/gen-theme.ts; do not edit by hand. =====
 * Values measured from Grok Bot 0.70.2 "Sand Light"/"Sand Dark" (docs/research/grok-design-system.md).
 * Import after \`@import "tailwindcss"\` (see styles.css). */

/* 1. Theme values: light-dark(LIGHT, DARK). Dark is the default; [data-theme="light"|"system"] switches any subtree. */
:root, [data-theme="dark"] { color-scheme: dark; }
[data-theme="light"] { color-scheme: light; }
[data-theme="system"] { color-scheme: light dark; }
:root {
${rows.join("\n")}
}

/* 2. Drop Tailwind's default palette so only semantic tokens exist. */
@theme {
  --color-*: initial;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-white: #fff;
  --color-black: #000;
}

/* 3. Semantic colors -> utilities: bg-pane, text-fg-secondary, border-line-secondary, bg-accent-soft, text-warn-fg ... */
@theme inline {
${themeInline}
}

${STATIC}`
}

export const tokensPath = new URL("../src/tokens.css", import.meta.url).pathname

if (import.meta.main) {
  const css = generateTokensCss()
  await Bun.write(tokensPath, css)
  console.log(`wrote ${tokensPath} (${css.split("\n").length} lines)`)
}
