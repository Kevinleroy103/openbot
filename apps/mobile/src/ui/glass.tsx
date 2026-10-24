// Liquid glass (iOS 26, expo-glass-effect) for the floating chrome: round buttons, the title pill,
// the composer. Older iOS gets the system blur; Android and web a translucent fill.
import { BlurView } from "expo-blur"
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect"
import * as Haptics from "expo-haptics"
import type { ReactNode } from "react"
import { Platform, Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native"
import { useTheme } from "../theme.ts"
import { Icon, type IconName } from "./Icon.tsx"

/** Real liquid glass is drawn by iOS 26 itself. */
export const liquidGlass = Platform.OS === "ios" && isLiquidGlassAvailable()

export function Glass({
  style,
  children,
  interactive = false,
}: {
  readonly style?: StyleProp<ViewStyle>
  readonly children?: ReactNode
  /** the glass reacts to touches (buttons) */
  readonly interactive?: boolean
}): ReactNode {
  const theme = useTheme()
  if (liquidGlass) {
    return (
      <GlassView
        style={style}
        isInteractive={interactive}
        glassEffectStyle="regular"
        colorScheme={theme.dark ? "dark" : "light"}
      >
        {children}
      </GlassView>
    )
  }
  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={60}
        tint={theme.dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        style={[style, styles.clip]}
      >
        {children}
      </BlurView>
    )
  }
  return (
    <View
      style={[
        style,
        styles.clip,
        {
          backgroundColor: theme.glassFallback,
          borderColor: theme.lineSecondary,
          borderWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      {children}
    </View>
  )
}

/** A round glass button with an SF Symbol (back, more, search, new, attach). */
export function GlassCircle({
  icon,
  onPress,
  label,
  size = 44,
  iconSize = 19,
  style,
}: {
  readonly icon: IconName
  readonly onPress: () => void
  readonly label: string
  readonly size?: number
  readonly iconSize?: number
  readonly style?: StyleProp<ViewStyle>
}): ReactNode {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined)
        onPress()
      }}
      style={style}
    >
      <Glass
        interactive
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name={icon} size={iconSize} color={theme.icon} />
      </Glass>
    </Pressable>
  )
}

const styles = StyleSheet.create({ clip: { overflow: "hidden" } })
