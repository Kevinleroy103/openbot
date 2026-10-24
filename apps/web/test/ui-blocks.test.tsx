import { expect, test } from "bun:test"
import { UiCard, type UiBlock } from "@openbot/contracts"
import { Schema } from "effect"
import { UiCardContent } from "../src/cards/UiCard.tsx"
import choiceFixture from "./fixtures/ui/ui-choice.json"
import everythingFixture from "./fixtures/ui/ui-everything.json"
import answers from "./fixtures/ui/answers.json"
import { renderToStaticMarkup } from "react-dom/server"
import { UiBlockView } from "../src/cards/UiBlocks.tsx"
import { UiChart } from "../src/cards/UiChart.tsx"

const render = (block: UiBlock) =>
  renderToStaticMarkup(
    <UiBlockView block={block} values={{}} onChange={() => {}} disabled={false} answered={false} namePrefix="card" />,
  )

test("unknown blocks leave a placeholder without losing the card", () => {
  expect(render({ type: "map" } as unknown as UiBlock)).toContain("Can&#x27;t show this part")
})

test("UI markdown never embeds a remote image or executes HTML", () => {
  const html = render({
    type: "text",
    markdown: "![pixel](https://tracker.example/p.gif)\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))",
  })
  expect(html).not.toContain("<img")
  expect(html).not.toContain('href="javascript:')
  expect(render({ type: "text", markdown: "[insecure](http://example.com) or http://example.com/" })).not.toContain(
    "<a",
  )
  expect(render({ type: "text", markdown: "[secure](https://example.com)" })).not.toContain("<img")
  expect(html).toContain("&lt;img")
  expect(html).toContain("pixel")
  expect(render({ type: "fields", items: [{ label: "HTML", value: "<script>alert(1)</script>" }] })).toContain(
    "&lt;script&gt;",
  )
})

test("UI markdown can embed the brain's attachments", () => {
  expect(render({ type: "text", markdown: "![A diagram](/api/attachments/att_diagram)" })).toContain(
    'src="/api/attachments/att_diagram"',
  )
})

test("link blocks allow only guarded external HTTPS URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://example.com",
    "//example.com",
    "https:\n//example.com",
    "/api/auth/login",
  ]) {
    expect(render({ type: "link", label: "Open", url })).not.toContain("<a")
  }
  const html = render({ type: "link", label: "Open", url: "https://example.com/" })
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noopener noreferrer nofollow"')
})

test("image blocks use only attachment routes even for an injected URL", () => {
  const html = render({ type: "image", attachmentId: "https://tracker.example/p.gif", alt: "Diagram" } as UiBlock)
  expect(html).toContain('src="/api/attachments/https%3A%2F%2Ftracker.example%2Fp.gif"')
  expect(html).not.toContain('src="https:')
})

test("charts support negative values, zero series and readable descriptions", () => {
  for (const kind of ["bar", "line"] as const) {
    const html = renderToStaticMarkup(
      <UiChart
        block={{
          type: "chart",
          kind,
          unit: "EUR",
          highlight: "Tue",
          series: [
            {
              name: "Net",
              points: [
                { x: "Mon", y: -3 },
                { x: "Tue", y: 0 },
                { x: "Wed", y: 4 },
              ],
            },
            { name: "Zero", points: [{ x: "Mon", y: 0 }] },
          ],
        }}
      />,
    )
    expect(html).not.toContain("NaN")
    expect(html).not.toContain("Infinity")
    expect(html).toContain("Net: Mon: -3, Tue: 0, Wed: 4")
    expect(html).toContain("var(--ob-accent-soft)")
    expect(html).toContain(kind === "line" ? "<polyline" : "<rect")
  }
  expect(
    render({ type: "chart", kind: "bar", series: [{ name: "Zero", points: [{ x: "Mon", y: 0 }] }] }),
  ).not.toContain("NaN")
})

test("stored answers render the chosen values read-only, not the defaults", () => {
  const card = Schema.decodeUnknownSync(UiCard)(choiceFixture)
  const html = renderToStaticMarkup(
    <UiCardContent
      card={card}
      state={{ status: "resolved", answer: { ...answers["ui-choice"], at: 0 } }}
      entryId={"ent_choice" as never}
      pending={false}
      onAct={() => {}}
    />,
  )
  expect(html).toContain("13:30 – 14:00")
  expect(html).toContain("Design sync")
  expect(html).not.toContain("Design review")
  expect(html).not.toContain("<input")
  expect(html).toContain("Answered")
  expect(html).toContain("Sent: Send choice")
  expect(html).toContain('disabled=""')
})

test("the tolerant schema keeps known blocks around the unknown block", () => {
  const card = Schema.decodeUnknownSync(UiCard)(everythingFixture)
  const html = renderToStaticMarkup(
    <UiCardContent
      card={card}
      state={{ status: "pending" }}
      entryId={"ent_gallery" as never}
      pending={false}
      onAct={() => {}}
    />,
  )
  expect(html).toContain("Can&#x27;t show this part")
  expect(html).toContain("Architecture diagram")
  expect(html).toContain("Toppings")
  expect(html).toContain("<textarea")
  expect(html).toContain("<table")
})

test("a future UI version renders fallback instead of interactive controls", () => {
  const card = Schema.decodeUnknownSync(UiCard)({ ...choiceFixture, version: 2 })
  const html = renderToStaticMarkup(
    <UiCardContent
      card={card}
      state={{ status: "pending" }}
      entryId={"ent_future" as never}
      pending={false}
      onAct={() => {}}
    />,
  )
  expect(html).toContain(choiceFixture.fallback)
  expect(html).not.toContain("<button")
  expect(html).not.toContain("<input")
})
