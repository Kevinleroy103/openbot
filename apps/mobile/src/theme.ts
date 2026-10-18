// Colors of the iPhone app: the web app's design tokens (packages/ui/src/tokens.css), light and dark,
// following the system appearance.
import type { AvatarColor } from "@openbot/ui/avatar-model"
import { useColorScheme } from "react-native"

export interface Theme {
  readonly dark: boolean
  /** screen background (Home, chat) */
  readonly bg: string
  /** raised surfaces: cards, sheets, the user's bubbles in light mode */
  readonly elevated: string
  readonly fg: string
  readonly fgSecondary: string
  readonly fgTertiary: string
  readonly fgQuaternary: string
  readonly icon: string
  readonly iconSecondary: string
  readonly line: string
  readonly lineSecondary: string
  readonly lineTertiary: string
  readonly bubbleBot: string
  readonly bubbleUser: string
  readonly bubbleUserFg: string
  readonly secondary: string
  readonly primary: string
  readonly onPrimary: string
  readonly accent: string
  readonly accentFg: string
  readonly danger: string
  readonly dangerFg: string
  readonly success: string
  readonly warn: string
  readonly codeBg: string
  /** behind glass where liquid glass is unavailable */
  readonly glassFallback: string
}

const dark: Theme = {
  dark: true,
  bg: "#121212",
  elevated: "#1f1f1f",
  fg: "#f5f5f5",
  fgSecondary: "rgba(245,245,245,0.66)",
  fgTertiary: "rgba(245,245,245,0.54)",
  fgQuaternary: "rgba(245,245,245,0.38)",
  icon: "rgba(245,245,245,0.9)",
  iconSecondary: "rgba(245,245,245,0.64)",
  line: "rgba(245,245,245,0.22)",
  lineSecondary: "rgba(245,245,245,0.1)",
  lineTertiary: "rgba(245,245,245,0.06)",
  bubbleBot: "#1f1f1f",
  bubbleUser: "#2e2e2e",
  bubbleUserFg: "#f5f5f5",
  secondary: "rgba(245,245,245,0.06)",
  primary: "#f5f5f5",
  onPrimary: "#121212",
  accent: "#1884fc",
  accentFg: "#4d9bff",
  danger: "#cf2b35",
  dangerFg: "#ff6463",
  success: "#14c370",
  warn: "#f69412",
  codeBg: "rgba(245,245,245,0.06)",
  glassFallback: "rgba(40,40,40,0.82)",
}

const light: Theme = {
  dark: false,
  bg: "#fcfcfc",
  elevated: "#ffffff",
  fg: "#1c1c1c",
  fgSecondary: "rgba(28,28,28,0.68)",
  fgTertiary: "rgba(28,28,28,0.56)",
  fgQuaternary: "rgba(28,28,28,0.4)",
  icon: "rgba(28,28,28,0.92)",
  iconSecondary: "rgba(28,28,28,0.66)",
  line: "rgba(28,28,28,0.24)",
  lineSecondary: "rgba(28,28,28,0.12)",
  lineTertiary: "rgba(28,28,28,0.08)",
  bubbleBot: "rgba(28,28,28,0.06)",
  bubbleUser: "#1c1c1c",
  bubbleUserFg: "#ffffff",
  secondary: "rgba(28,28,28,0.06)",
  primary: "#1c1c1c",
  onPrimary: "#ffffff",
  accent: "#1680f3",
  accentFg: "#0b6dd3",
  danger: "#e72e3b",
  dangerFg: "#cd2834",
  success: "#10ab61",
  warn: "#f59312",
  codeBg: "rgba(28,28,28,0.05)",
  glassFallback: "rgba(245,245,245,0.86)",
}

export const useTheme = (): Theme => (useColorScheme() === "light" ? light : dark)

/** Avatar body colors (tokens.css `--ob-avatar-*`). */
export const avatarColor = (color: AvatarColor, isDark: boolean): string => {
  const pair: Record<AvatarColor, readonly [string, string]> = {
    black: ["#1c1c1c", "#3a3a3a"],
    brown: ["#a06b39", "#a16b39"],
    red: ["#fb2b3e", "#fc2c3e"],
    orange: ["#fd690f", "#f9670e"],
    yellow: ["#f59312", "#f69412"],
    green: ["#14c16f", "#14c370"],
    cyan: ["#13b7a2", "#13b8a3"],
    blue: ["#1e86fc", "#1884fc"],
    violet: ["#8f59f9", "#905afb"],
    magenta: ["#f93498", "#fb3499"],
    gray: ["#8e8e8e", "#7a7a7a"],
  }
  return pair[color][isDark ? 1 : 0]
}
