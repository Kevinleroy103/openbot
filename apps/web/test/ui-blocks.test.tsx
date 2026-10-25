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
  expect(html).not.toContain("<img")
  expect(html).toContain("image unavailable")
  expect(render({ type: "image", attachmentId: "..", alt: "Invalid attachment" } as UiBlock)).not.toContain("<img")
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

test("chart ticks round outward while keeping small values legible", () => {
  for (const { values, ticks } of [
    { values: [0, 8.7], ticks: [0, 5, 10] },
    { values: [-3, 4], ticks: [-4, 0, 4] },
    { values: [0, 0.0087], ticks: [0, 0.005, 0.01] },
    { values: [0, 0], ticks: [0, 0.5] },
  ]) {
    const html = render({
      type: "chart",
      kind: "bar",
      series: [{ name: "Values", points: values.map((y, index) => ({ x: String(index), y })) }],
    })
    expect([...html.matchAll(/<text x="36"[^>]*>([^<]+)<\/text>/g)].map((match) => Number(match[1]))).toEqual(ticks)
  }
})

test("stacked bars and filled lines pile up to their totals; an unfilled line ignores stacked", () => {
  const chart = (kind: "bar" | "line", options: { fill?: boolean; stacked?: boolean }) =>
    render({
      type: "chart",
      kind,
      ...options,
      unit: "h",
      highlight: "Tue",
      series: [
        {
          name: "Web",
          points: [
            { x: "Mon", y: 3 },
            { x: "Tue", y: 5 },
          ],
        },
        {
          name: "iPhone",
          points: [
            { x: "Mon", y: 2 },
            { x: "Tue", y: 4 },
          ],
        },
      ],
    })
  const ticksOf = (html: string) =>
    [...html.matchAll(/<text x="36"[^>]*>([^<]+)<\/text>/g)].map((match) => Number(match[1]))
  const rectsOf = (html: string) =>
    [...html.matchAll(/<rect x="[^"]+" y="([\d.]+)" width="[^"]+" height="([\d.]+)"[^>]*><title>/g)].map(
      ([, top, height]) => ({
        top: Number(top),
        bottom: Number(top) + Number(height),
      }),
    )

  const bars = chart("bar", { stacked: true })
  expect(bars).toContain("Stacked bar chart (h)")
  expect(ticksOf(bars)).toEqual([0, 5, 10])
  expect(bars).toContain("iPhone: Tue, 4 h of 9 h total")
  expect(bars).toContain("Totals: Mon: 5, Tue: 9")
  const mark = (html: string) => {
    const match = /<g fill="([^"]+)">(<circle[^>]*><\/circle>)?<text[^>]*font-weight="600">([^<]+)</.exec(html)
    return match && { color: match[1], dot: match[2] !== undefined, value: match[3] }
  }
  expect(mark(bars)).toEqual({ color: "var(--ob-fg)", dot: false, value: "9" })
  const [webMon, , phoneMon] = rectsOf(bars)
  expect(phoneMon!.bottom).toBeCloseTo(webMon!.top)

  const grouped = chart("bar", {})
  expect(ticksOf(grouped)).toEqual([0, 3, 6])
  expect(grouped).not.toContain("total")
  expect(mark(grouped)).toEqual({ color: "var(--ob-accent-fg)", dot: false, value: "5" })

  const line = chart("line", { stacked: true })
  expect(line).toContain("Line chart (h)")
  expect(ticksOf(line)).toEqual([0, 3, 6])
  expect(line).not.toContain("<path")
  expect(line).not.toContain("total")
  expect(mark(line)).toEqual({ color: "var(--ob-accent-fg)", dot: true, value: "5" })

  const area = chart("line", { fill: true })
  expect(area).toContain("Area chart (h)")
  expect(ticksOf(area)).toEqual([0, 3, 6])
  expect(
    [...area.matchAll(/<stop offset="(\d)" stop-color="([^"]+)" stop-opacity="([\d.]+)"/g)].map((m) => m.slice(1)),
  ).toEqual([
    ["0", "var(--ob-accent-fg)", "0.25"],
    ["1", "var(--ob-accent-fg)", "0"],
    ["0", "var(--ob-purple-fg)", "0.25"],
    ["1", "var(--ob-purple-fg)", "0"],
  ])
  const gradients = [...area.matchAll(/<linearGradient id="([^"]+)" x1="0" y1="0" x2="0" y2="1">/g)].map((m) => m[1])
  expect([...area.matchAll(/<path d="[^"]+" fill="url\(#([^)]+)\)"><\/path>/g)].map((m) => m[1])).toEqual(gradients)
  expect(gradients).toHaveLength(2)
  expect(mark(area)).toEqual({ color: "var(--ob-accent-fg)", dot: true, value: "5" })

  const stackedArea = chart("line", { fill: true, stacked: true })
  expect(stackedArea).toContain("Stacked area chart (h)")
  expect(ticksOf(stackedArea)).toEqual([0, 5, 10])
  expect(stackedArea).toContain("iPhone: Mon, 2 h of 5 h total")
  const [webBand, phoneBand] = [...stackedArea.matchAll(/<path d="M([^"]+)Z"/g)].map((match) =>
    match[1]!.split("L").map((point) => point.split(",").map(Number)),
  )
  expect(phoneBand!.slice(2).toReversed()).toEqual(webBand!.slice(0, 2))
  expect([...stackedArea.matchAll(/<path d="[^"]+" fill="([^"]+)" fill-opacity="0.55"/g)].map((m) => m[1])).toEqual([
    "var(--ob-accent-fg)",
    "var(--ob-purple-fg)",
  ])
  expect(stackedArea).not.toContain("<linearGradient")
  expect(mark(stackedArea)).toEqual({ color: "var(--ob-fg)", dot: true, value: "9" })
})

test("dense lines and areas fit the width, and about seven x labels show, none crowding the highlight", () => {
  const dense = (options: { fill?: boolean; stacked?: boolean; highlight?: string }) =>
    render({
      type: "chart",
      kind: "line",
      ...options,
      series: ["Web", "iPhone"].map((name) => ({
        name,
        points: Array.from({ length: 60 }, (_, index) => ({ x: `D${index + 1}`, y: index % 7 })),
      })),
    })
  const xLabels = (html: string) => [...html.matchAll(/<text x="[\d.]+" y="184"[^>]*>([^<]+)</g)].map((m) => m[1])
  for (const options of [{}, { fill: true }, { fill: true, stacked: true }]) {
    const html = dense({ ...options, highlight: "D40" })
    expect(html).toContain('viewBox="0 0 480 200"')
    expect(html).not.toContain("min-width")
    expect([...html.matchAll(/<circle/g)]).toHaveLength(1)
    expect(xLabels(html)).toEqual(["D1", "D10", "D19", "D28", "D40", "D55"])
    expect(xLabels(dense(options))).toEqual(["D1", "D10", "D19", "D28", "D37", "D46", "D55"])
  }
})

test("maximum bar charts scroll and keep all 240 bars inside the SVG with positive geometry", () => {
  for (const stacked of [false, true]) {
    for (const sharedLabels of [true, false]) {
      const html = render({
        type: "chart",
        kind: "bar",
        stacked,
        series: Array.from({ length: 4 }, (_, series) => ({
          name: `Series ${series}`,
          points: Array.from({ length: 60 }, (_point, point) => ({
            x: sharedLabels ? `Day ${point}` : `${series}-${point}`,
            y: (point - 30) * (series + 1),
          })),
        })),
      })
      const width = Number(/viewBox="0 0 ([\d.]+) 200"/.exec(html)?.[1])
      expect(width).toBeGreaterThan(480)
      expect(html).toContain(`min-width:${width}px`)
      const bars = [...html.matchAll(/<rect\b([^>]+)><title>/g)]
      // Stacked bars leave out each series' zero at point 30.
      expect(bars).toHaveLength(stacked ? 236 : 240)
      for (const [, attributes] of bars) {
        const attr = Object.fromEntries(
          [...attributes!.matchAll(/([a-z]+)="(-?[\d.]+)"/g)].map(([, key, value]) => [key, Number(value)]),
        )
        const left = attr.x!
        const top = attr.y!
        const right = left + attr.width!
        const bottom = top + attr.height!
        expect(attr.width!).toBeGreaterThan(0)
        expect(attr.height!).toBeGreaterThanOrEqual(0)
        expect(left).toBeGreaterThanOrEqual(0)
        expect(top).toBeGreaterThanOrEqual(0)
        expect(right).toBeLessThanOrEqual(width)
        expect(bottom).toBeLessThanOrEqual(200)
      }
    }
  }
})

test("subtitle-only UI cards keep their header", () => {
  const card = Schema.decodeUnknownSync(UiCard)({
    type: "ui",
    version: 1,
    fallback: "Meeting",
    subtitle: "Meeting details",
    blocks: [],
  })
  const html = renderToStaticMarkup(
    <UiCardContent card={card} state={{ status: "pending" }} pending={false} onAct={() => {}} />,
  )
  expect(html).toContain("Meeting details")
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
