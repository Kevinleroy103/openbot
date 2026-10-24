// A page of the web app inside the app (Settings, Computers, a Bot's computer, new chats), signed in
// with the app's own session through a one-time code.
import { router, useLocalSearchParams } from "expo-router"
import { createElement, type ReactNode, useEffect, useState } from "react"
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { WebView } from "react-native-webview"
import { useConnection } from "../src/runtime.tsx"
import { webPageUrl } from "../src/session.ts"
import { useTheme } from "../src/theme.ts"

export default function Web(): ReactNode {
  const { path, title } = useLocalSearchParams<{ path?: string; title?: string }>()
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const connection = useConnection()
  const [url, setUrl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let live = true
    webPageUrl(connection, path ?? "#/")
      .then((u) => live && setUrl(u))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [connection, path])

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View
        style={[
          styles.bar,
          { paddingTop: Platform.OS === "ios" ? 14 : insets.top + 8, borderColor: theme.lineTertiary },
        ]}
      >
        <Text numberOfLines={1} style={[styles.title, { color: theme.fg }]}>
          {title ?? "OpenBot"}
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" style={styles.done}>
          <Text style={{ color: theme.accentFg, fontSize: 17, fontWeight: "600" }}>Done</Text>
        </Pressable>
      </View>
      {error !== undefined ? (
        <Text style={[styles.message, { color: theme.dangerFg }]}>{error}</Text>
      ) : url === undefined ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.fg} />
      ) : Platform.OS === "web" ? (
        createElement("iframe", { src: url, style: { flex: 1, border: 0, width: "100%", height: "100%" } })
      ) : (
        <WebView
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: theme.bg }}
          sharedCookiesEnabled
          allowsInlineMediaPlayback
          startInLoadingState
          renderLoading={() => <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.fg} />}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: "600", maxWidth: "70%" },
  done: { position: "absolute", right: 16, bottom: 12 },
  message: { textAlign: "center", marginTop: 40, paddingHorizontal: 32, fontSize: 15 },
})
