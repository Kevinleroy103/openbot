import { expect, mock, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

const Container = ({ children }) => createElement("div", null, children)
mock.module("react-native", () => ({
  Platform: { select: (o) => o.default },
  Pressable: ({ children, accessibilityRole }) => createElement("button", { role: accessibilityRole }, children),
  ScrollView: Container,
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  Text: ({ children }) => createElement("span", null, children),
  View: Container,
}))
mock.module("expo-image", () => ({
  Image: ({ source }) => createElement("img", { src: source.uri, "data-headers": JSON.stringify(source.headers) }),
}))
mock.module("expo-linking", () => ({ openURL: () => {} }))
mock.module("../src/ui/Icon.tsx", () => ({ Icon: () => null }))

const { Markdown } = await import("../src/chat/Markdown.tsx")

const theme = { fg: "#fff", fgSecondary: "#aaa", line: "#333", accentFg: "#09f", codeBg: "#111", secondary: "#222" }
const image = { origin: "https://brain.example", headers: { authorization: "Bearer s" } }
const render = (text) => renderToStaticMarkup(createElement(Markdown, { text, theme, image }))

test("a remote image waits behind a tap-to-load placeholder naming its host", () => {
  const html = render("![shot](https://cdn.example/a.png)")
  expect(html).not.toContain("<img")
  expect(html).toContain('<button role="button"><span>Load image from cdn.example</span></button>')
})

test("an attachment loads at once from the brain, with the session headers", () => {
  const html = render("![shot](/api/attachments/att_1)")
  expect(html).toContain('src="https://brain.example/api/attachments/att_1"')
  expect(html).toContain("Bearer s")
  expect(html).not.toContain("Load image")
})

test("the brain's absolute attachment URL loads at once too, but on another port it waits", () => {
  expect(render("![a](https://brain.example/api/attachments/att_1)")).toContain(
    'src="https://brain.example/api/attachments/att_1"',
  )
  const html = render("![a](https://brain.example:8443/api/attachments/att_1)")
  expect(html).not.toContain("<img")
  expect(html).toContain("Load image from brain.example:8443")
})
