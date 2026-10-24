import { beforeEach, expect, mock, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { conversationAtom, outboxAtom, rosterAtom } from "@openbot/client"
import { emptyConversationState, emptyRosterState, NotFound } from "@openbot/contracts"
import { AsyncResult } from "effect/reactivity"

const conversationId = "cnv_missing"
let result
let outbox
const back = mock(() => {})

mock.module("@effect/atom-react", () => ({
  useAtomValue: (atom) => {
    if (atom === conversationAtom(conversationId)) return result
    if (atom === rosterAtom) return AsyncResult.success(emptyRosterState)
    if (atom === outboxAtom(conversationId)) return outbox
    throw new Error("Unexpected atom")
  },
  useAtomSet: () => () => {},
}))

const Container = ({ children }) => createElement("div", null, children)
mock.module("react-native", () => ({
  ActionSheetIOS: {},
  Alert: {},
  FlatList: ({ data, ListEmptyComponent }) => createElement("div", null, data.length === 0 ? ListEmptyComponent : "Transcript"),
  KeyboardAvoidingView: Container,
  Platform: { OS: "ios" },
  Pressable: Container,
  StyleSheet: { create: (styles) => styles },
  Text: Container,
  View: Container,
  useColorScheme: () => "dark",
}))
mock.module("expo-router", () => ({
  useLocalSearchParams: () => ({ id: conversationId }),
  router: { canGoBack: () => true, back, replace: mock(() => {}) },
}))
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
mock.module("../src/runtime.tsx", () => ({ useConnection: () => ({}) }))
mock.module("../src/nav.ts", () => ({ openWeb: mock(() => {}) }))
mock.module("../src/chat/Composer.tsx", () => ({ Composer: () => createElement("input", { "aria-label": "Message" }) }))
mock.module("../src/chat/Rows.tsx", () => ({ RowView: () => null, StatusLine: () => null }))
mock.module("../src/ui/Avatar.tsx", () => ({ Avatar: () => null, AvatarStack: () => null }))
mock.module("../src/ui/glass.tsx", () => ({
  Glass: Container,
  GlassCircle: ({ label, onPress }) => createElement("button", { onClick: onPress }, label),
}))

const { default: Chat } = await import("../app/chat/[id].tsx")

beforeEach(() => {
  result = AsyncResult.initial()
  outbox = []
})

test("a terminal conversation error replaces Loading and removes the composer", () => {
  result = AsyncResult.fail(new NotFound({ entity: "conversation", id: conversationId }))
  outbox = [{ clientNonce: "pending", input: { text: "Unsent message" }, createdAt: 1, status: "sending" }]
  const html = renderToStaticMarkup(createElement(Chat))
  expect(html).toContain("Couldn&#x27;t load this conversation. Go back and try again.")
  expect(html).toContain("Back")
  expect(html).not.toContain("Loading")
  expect(html).not.toContain('aria-label="Message"')
})

test("an initial conversation still loads, and a synchronized empty chat does not", () => {
  expect(renderToStaticMarkup(createElement(Chat))).toContain("Loading")
  result = AsyncResult.success({ ...emptyConversationState, synchronized: true })
  const html = renderToStaticMarkup(createElement(Chat))
  expect(html).not.toContain("Loading")
  expect(html).not.toContain("load this conversation")
  expect(html).toContain('aria-label="Message"')
})
