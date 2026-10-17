import { describe, expect, test } from "bun:test"
import { Search } from "lucide-react"
import { renderToStaticMarkup } from "react-dom/server"
import { Icon } from "../src/Icon.tsx"
import { HeaderPill, IconButton, PillButton } from "../src/primitives/buttons.tsx"
import { Card, CardHeader, KeyBadge, OptionRow, Sheet, StatusPill } from "../src/primitives/card.tsx"
import { Bubble, EventChip, EventLine, bubbleCornerClass, bubbleCorners, groupPosition } from "../src/primitives/chat.tsx"
import { SegmentedTabs, Switch, TextField } from "../src/primitives/forms.tsx"
import { DialogPanel, MenuItem, MenuPanel, filterPaletteItems, placePanel } from "../src/primitives/overlay.tsx"

describe("bubble grouping", () => {
  test("groupPosition", () => {
    expect(groupPosition(0, 1)).toBe("single")
    expect([0, 1, 2].map((i) => groupPosition(i, 3))).toEqual(["first", "middle", "last"])
    expect([0, 1].map((i) => groupPosition(i, 2))).toEqual(["first", "last"])
  })

  test("corner table (grok-bot-ui.md §4.4)", () => {
    expect(bubbleCorners("user", "single")).toEqual([18, 18, 18, 18])
    expect(bubbleCorners("user", "first")).toEqual([18, 18, 6, 18])
    expect(bubbleCorners("user", "middle")).toEqual([18, 6, 6, 18])
    expect(bubbleCorners("user", "last")).toEqual([18, 6, 18, 18])
    expect(bubbleCorners("bot", "first")).toEqual([18, 18, 18, 6])
    expect(bubbleCorners("bot", "middle")).toEqual([6, 18, 18, 6])
    expect(bubbleCorners("bot", "last")).toEqual([6, 18, 18, 18])
    expect(bubbleCornerClass("bot", "middle")).toBe("rounded-bubble rounded-tl-md rounded-bl-md")
    expect(bubbleCornerClass("user", "single")).toBe("rounded-bubble")
  })

  test("Bubble renders side colors", () => {
    expect(renderToStaticMarkup(<Bubble side="user">hi</Bubble>)).toContain("bg-bubble-user")
    expect(renderToStaticMarkup(<Bubble side="bot" position="last">hi</Bubble>)).toContain("rounded-tl-md")
    expect(renderToStaticMarkup(<Bubble side="bot" emojiOnly>👍</Bubble>)).not.toContain("bg-bubble-agent")
  })
})

describe("placePanel", () => {
  const vp = { width: 1000, height: 800 }
  test("places below, aligned start", () => {
    expect(placePanel({ top: 100, left: 100, width: 40, height: 20 }, { width: 200, height: 100 }, vp, "bottom", "start")).toEqual({ top: 126, left: 100, side: "bottom" })
  })
  test("flips to top when there is no room below", () => {
    expect(placePanel({ top: 750, left: 100, width: 40, height: 20 }, { width: 200, height: 100 }, vp, "bottom", "start")).toEqual({ top: 644, left: 100, side: "top" })
  })
  test("clamps into the viewport and aligns end/center", () => {
    expect(placePanel({ top: 100, left: 980, width: 20, height: 20 }, { width: 200, height: 100 }, vp, "bottom", "end").left).toBe(792)
    expect(placePanel({ top: 100, left: 400, width: 100, height: 20 }, { width: 200, height: 100 }, vp, "bottom", "center").left).toBe(350)
    expect(placePanel({ top: 100, left: 0, width: 20, height: 20 }, { width: 200, height: 100 }, vp, "bottom", "center").left).toBe(8)
  })
})

describe("filterPaletteItems", () => {
  const items = [
    { id: "1", label: "Chief of Staff", keywords: ["ops"] },
    { id: "2", label: "Research Scout" },
    { id: "3", label: "Settings › Computers", keywords: ["nodes", "pairing"] },
  ]
  test("matches label and keywords, every term, case-insensitive, order kept", () => {
    expect(filterPaletteItems(items, "").map((i) => i.id)).toEqual(["1", "2", "3"])
    expect(filterPaletteItems(items, "OPS").map((i) => i.id)).toEqual(["1"])
    expect(filterPaletteItems(items, "s").map((i) => i.id)).toEqual(["1", "2", "3"])
    expect(filterPaletteItems(items, "settings pair").map((i) => i.id)).toEqual(["3"])
    expect(filterPaletteItems(items, "zzz")).toEqual([])
  })
})

describe("server rendering of primitives", () => {
  test("buttons", () => {
    const icon = renderToStaticMarkup(<IconButton icon={Search} label="Search" variant="elevated" />)
    expect(icon).toContain('aria-label="Search"')
    expect(icon).toContain("size-9 rounded-full")
    const pill = renderToStaticMarkup(
      <PillButton variant="primary" loading>
        Save
      </PillButton>,
    )
    expect(pill).toContain("bg-primary")
    expect(pill).toContain('aria-busy="true"')
    expect(pill).toContain("disabled")
    expect(renderToStaticMarkup(<HeaderPill avatar={<i />}>Chief</HeaderPill>)).toContain("shadow-inline")
    expect(renderToStaticMarkup(<Icon icon={Search} size="xl" />)).toContain('width="18"')
  })

  test("cards", () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader title="Allow?" status={<StatusPill tone="warn">Needs approval</StatusPill>} onClose={() => {}} />
        <Sheet>
          <OptionRow optionKey="A">Marina House</OptionRow>
        </Sheet>
      </Card>,
    )
    expect(html).toContain("rounded-4xl bg-bubble-agent")
    expect(html).toContain("bg-warn-soft text-warn-fg")
    expect(html).toContain('aria-label="Dismiss"')
    expect(html).toContain(">A</span>")
    expect(renderToStaticMarkup(<KeyBadge>⌘K</KeyBadge>)).toContain("<kbd")
  })

  test("event line, forms, menus, dialog panel", () => {
    expect(
      renderToStaticMarkup(
        <EventLine>
          Created <EventChip>Morning</EventChip>
        </EventLine>,
      ),
    ).toContain("justify-center")
    expect(renderToStaticMarkup(<Switch checked label="x" />)).toContain('aria-checked="true"')
    const tf = renderToStaticMarkup(<TextField label="Name" error="Required" />)
    expect(tf).toContain('aria-invalid="true"')
    expect(tf).toContain("Required")
    const tabs = renderToStaticMarkup(
      <SegmentedTabs
        value="b"
        tabs={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    )
    expect(tabs).toContain('role="tablist"')
    expect(tabs.match(/aria-selected="true"/g)?.length).toBe(1)
    const menu = renderToStaticMarkup(
      <MenuPanel>
        <MenuItem danger>Delete</MenuItem>
        <MenuItem checked>Light</MenuItem>
      </MenuPanel>,
    )
    expect(menu).toContain('role="menuitem"')
    expect(menu).toContain('role="menuitemradio"')
    expect(menu).toContain("text-danger-fg")
    expect(renderToStaticMarkup(<DialogPanel label="D">x</DialogPanel>)).toContain('aria-modal="true"')
  })
})
