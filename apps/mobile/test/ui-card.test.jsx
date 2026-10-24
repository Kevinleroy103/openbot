import { beforeEach, expect, mock, test } from "bun:test"
import * as React from "react"
import { Children, createElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { actCardAtom } from "@openbot/client"
import { AlreadyAnswered, UiCard } from "@openbot/contracts"
import { Exit, Schema } from "effect"
import answers from "./fixtures/answers.json"
import chart from "./fixtures/ui-chart.json"
import choice from "./fixtures/ui-choice.json"
import compact from "./fixtures/ui-compact.json"
import comparison from "./fixtures/ui-comparison.json"
import everything from "./fixtures/ui-everything.json"
import hostile from "./fixtures/ui-hostile.json"

const entryId = "ent_card"
const realUseState = React.useState
let slots
let cursor
const alert = mock(() => {})
const act = mock(async () => actExit)
let actExit
let pressables

mock.module("@effect/atom-react", () => ({
  useAtomValue: () => undefined,
  useAtomSet: (atom, options) => {
    if (atom === actCardAtom(entryId) && options?.mode === "promiseExit") return act
    return () => {}
  },
}))

mock.module("react", () => ({
  ...React,
  useState: (initial) => {
    if (slots === undefined) return realUseState(initial)
    const index = cursor++
    const state = slots
    if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial
    return [state[index], (next) => (state[index] = typeof next === "function" ? next(state[index]) : next)]
  },
}))

const box = ({ children }) => createElement("div", null, children)
const svg =
  (name) =>
  ({ children, ...props }) =>
    createElement(name, props, children)
mock.module("react-native", () => ({
  ActivityIndicator: () => createElement("progress"),
  Alert: { alert },
  Platform: { OS: "ios", select: (options) => options.ios ?? options.default },
  Pressable: ({ children, onPress, disabled, accessibilityRole, accessibilityState }) => {
    pressables.push({ onPress, disabled, children })
    return createElement(
      "button",
      { role: accessibilityRole, disabled, "aria-checked": accessibilityState?.checked },
      typeof children === "function" ? children({ pressed: false }) : children,
    )
  },
  ScrollView: box,
  StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 },
  Text: ({ children, onPress }) => createElement("span", onPress ? { "data-link": "" } : null, children),
  TextInput: ({ value, editable, placeholder, accessibilityLabel }) =>
    createElement("input", {
      value,
      onChange: () => {},
      readOnly: editable === false,
      placeholder,
      "aria-label": accessibilityLabel,
    }),
  View: box,
  useColorScheme: () => "light",
}))
mock.module("react-native-svg", () => ({
  default: svg("svg"),
  Circle: svg("circle"),
  Line: svg("line"),
  Polyline: svg("polyline"),
  Rect: svg("rect"),
}))
mock.module("expo-image", () => ({ Image: ({ source, alt }) => createElement("img", { src: source.uri, alt }) }))
mock.module("expo-haptics", () => ({ impactAsync: async () => {}, ImpactFeedbackStyle: { Light: "light" } }))
mock.module("expo-linking", () => ({ openURL: mock(() => {}) }))
mock.module("../src/nav.ts", () => ({ openWeb: mock(() => {}) }))
mock.module("../src/ui/Icon.tsx", () => ({ Icon: ({ name }) => createElement("i", { "data-icon": name }) }))

const { CardView } = await import("../src/chat/Cards.tsx")
const { UiCardView } = await import("../src/chat/UiCard.tsx")
const { Markdown } = await import("../src/chat/Markdown.tsx")
// useColorScheme is mocked to "light", so this is the light theme.
const { useTheme: lightTheme } = await import("../src/theme.ts")
const theme = lightTheme()

const decode = Schema.decodeUnknownSync(UiCard)
const render = (card, state = { status: "info" }) =>
  renderToStaticMarkup(
    createElement(CardView, {
      card: decode(card),
      state,
      request: undefined,
      bot: undefined,
      entryId,
      theme,
      media: { origin: "https://box.example", headers: { authorization: "Bearer t" } },
    }),
  )
const textOf = (node) => {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (isValidElement(node)) return textOf(node.props.children)
  return Children.toArray(node).map(textOf).join("")
}
const elements = (node) => {
  if (!isValidElement(node)) return []
  return [node, ...Children.toArray(node.props.children).flatMap(elements)]
}
const named = (tree, name) => elements(tree).filter((e) => e.type.name === name)
// Calls a component as a plain function that keeps its useState slots between calls: a rerender with new props.
const mount = (component) => {
  const state = []
  return (props) => {
    slots = state
    cursor = 0
    try {
      return component(props)
    } finally {
      slots = undefined
    }
  }
}
const media = { origin: "https://box.example", headers: {} }
const pending = (card) => ({ card: decode(card), state: { status: "pending" }, entryId, theme, media })
const pressable = (label) => pressables.find((p) => textOf(p.children).includes(label))
const checked = (html, label) =>
  html
    .split("<button")
    .find((b) => b.includes(`<span>${label}</span>`))
    ?.includes('aria-checked="true"')

beforeEach(() => {
  pressables = []
  actExit = Exit.void
  act.mockClear()
  alert.mockClear()
})

test("every known block of a card renders, and an unknown block shows the can't-show line", () => {
  const html = render(everything, { status: "pending" })
  for (const text of [
    "Block gallery",
    "Every block type",
    "Bold",
    "Lekë",
    "1,204",
    "+12%",
    "eu-central",
    "340 ms",
    "€64/mo",
    "Recommended for prod",
    "Popular",
    "Visual diff",
    "Failed",
    "In progress",
    "Alert fired",
    "18 min",
    "Web p95",
    "Mobile p95",
    "Open the dashboard",
    "This part can&#x27;t be shown in this version of the app.",
    "Toppings",
    "Anything we should change?",
    "Looks good",
    "Ask for changes",
    "Discard",
  ])
    expect(html).toContain(text)
  expect(html).toContain('src="https://box.example/api/attachments/att_gallery"')
  expect(html.match(/<polyline/g)).toHaveLength(2)
  expect(pressable("Open the dashboard").onPress).toBeFunction()
})

test("options stack with the pick marked, and a bar chart highlights its x", () => {
  const options = render(comparison)
  expect(options.match(/My pick/g)).toHaveLength(1)
  expect(options.indexOf("My pick")).toBeLessThan(options.indexOf("British Airways"))
  const bars = render(chart)
  const fills = [...bars.matchAll(/<rect[^>]*fill="([^"]+)"/g)].map((m) => m[1])
  expect(fills).toHaveLength(7)
  expect(fills.filter((f) => f === theme.accentFg)).toHaveLength(1)
  expect(bars).toContain("5.8")
})

test("a collapsed card shows only its fallback until tapped", () => {
  const html = render(compact)
  expect(html).toContain("All 6 checks passed on the search release branch.")
  expect(html).not.toContain("Web typecheck")
  expect(html).not.toContain("Search release checks")
})

test("a card of an unknown version shows its fallback", () => {
  const html = render({ ...choice, version: 2 }, { status: "pending" })
  expect(html).toContain(choice.fallback)
  expect(html).not.toContain("Send choice")
})

test("a pending card starts from its defaults and sends them with the pressed action", async () => {
  const html = render(choice, { status: "pending" })
  expect(checked(html, "10:00 – 10:30")).toBe(true)
  expect(checked(html, "13:30 – 14:00")).toBe(false)
  expect(html).toContain('value="Design review"')
  expect(html).not.toContain("readOnly")
  await pressable("Send choice").onPress()
  expect(act).toHaveBeenCalledWith({
    entryId,
    actionId: "send",
    values: { slot: ["1000"], title: "Design review" },
  })
  expect(alert).not.toHaveBeenCalled()
})

test("a refused action shows why, and the card stays as it was", async () => {
  render(choice, { status: "pending" })
  actExit = Exit.fail(new AlreadyAnswered({ entryId }))
  await pressable("Send choice").onPress()
  expect(alert).toHaveBeenCalledWith("Couldn't send that", "This card was already answered.")
})

test("an answered card shows what was sent, read-only, with its actions disabled", () => {
  const html = render(choice, { status: "resolved", answer: { ...answers["ui-choice"], at: 1 } })
  expect(checked(html, "13:30 – 14:00")).toBe(true)
  expect(checked(html, "10:00 – 10:30")).toBe(false)
  expect(html).toContain('value="Design sync"')
  expect(html).toContain("readOnly")
  expect(pressables.every((p) => p.disabled)).toBe(true)
  expect(html).toMatch(/data-icon="check".*Send choice/)

  const many = render(everything, { status: "resolved", answer: { ...answers["ui-everything"], at: 1 } })
  expect(checked(many, "Chili")).toBe(true)
  expect(checked(many, "Basil")).toBe(false)
})

test("hostile content renders inert: no script, data or http links, no remote images, HTML as text", () => {
  const html = render(hostile)
  expect(html).toContain("&lt;b&gt;Hostile&lt;/b&gt; card")
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  expect(html).not.toContain("data-link")
  expect(html).not.toContain('role="link"')
  expect(html).not.toContain("tracker.example")
  expect([...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])).toEqual([
    "https://box.example/api/attachments/att_missing",
  ])
  expect(html).toContain("A".repeat(400))
})

test("a ui text block links https only, while chat markdown keeps its http links", () => {
  const html = render({
    ...choice,
    blocks: [
      {
        type: "text",
        markdown: "[insecure](http://example.com/path) http://bare.example [secure](https://example.com)",
      },
    ],
  })
  expect(html.match(/data-link/g)).toHaveLength(1)
  expect(renderToStaticMarkup(createElement(Markdown, { text: "[chat](http://example.com)", theme }))).toContain(
    "data-link",
  )
})

test("a ui text block shows attachment images and drops remote ones, while chat markdown offers to load them", () => {
  const markdown = "![Diagram](/api/attachments/att_diagram) ![Tracker](https://tracker.example/pixel.png)"
  const html = render({ ...choice, blocks: [{ type: "text", markdown }] })
  expect([...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])).toEqual([
    "https://box.example/api/attachments/att_diagram",
  ])
  expect(html).toContain("Tracker")
  expect(html).not.toContain("Load image from")
  const chat = renderToStaticMarkup(
    createElement(Markdown, { text: markdown, theme, image: { origin: "https://box.example", headers: {} } }),
  )
  expect(chat).toContain("Load image from tracker.example")
})

test("update_ui keeps the owner's edits to blocks that remain, drops removed ones and takes new defaults", () => {
  const draw = mount(UiCardView)
  const send = (blocks) => {
    named(draw(pending({ ...choice, blocks })), "ActionButton")[0].props.onPress()
    return act.mock.lastCall[0].values
  }
  named(draw(pending(choice)), "BlockView")[0].props.form.set("slot", ["1330"])
  const newField = { type: "input", id: "newField", label: "New field", default: "New default" }
  const blocks = [
    choice.blocks.find((b) => b.id === "slot"),
    { type: "input", id: "title", label: "Meeting title", default: "Updated title" },
    newField,
  ]
  expect(send(blocks)).toEqual({ slot: ["1330"], title: "Updated title", newField: "New default" })
  expect(send([newField])).toEqual({ newField: "New default" })
})

test("a dense grouped bar chart draws every bar with a positive width", () => {
  const series = ["A", "B", "C", "D"].map((name) => ({
    name,
    points: Array.from({ length: 60 }, (_, i) => ({ x: String(i), y: i + 1 })),
  }))
  const html = render({ ...choice, blocks: [{ type: "chart", kind: "bar", series }] })
  const widths = [...html.matchAll(/<rect[^>]*width="([^"]+)"/g)].map((m) => Number(m[1]))
  expect(widths).toHaveLength(240)
  expect(widths.every((w) => w > 0)).toBe(true)
})

test("an image that failed to load tries again when update_ui points it at another attachment", () => {
  const imageBlock = (attachmentId) => {
    const card = pending({ ...choice, blocks: [{ type: "image", attachmentId, alt: "Diagram" }] })
    const view = named(mount(UiCardView)(card), "BlockView")[0]
    return view.type(view.props)
  }
  const missing = imageBlock("att_missing")
  const draw = mount(missing.type)
  draw(missing.props).props.onError()
  expect(draw(missing.props).props.source).toBeUndefined()
  expect(draw(imageBlock("att_gallery").props).props.source.uri).toBe("https://box.example/api/attachments/att_gallery")
})

test("a card with a subtitle and no title shows the subtitle", () => {
  const card = { ...choice }
  delete card.title
  expect(render(card)).toContain(choice.subtitle)
})
