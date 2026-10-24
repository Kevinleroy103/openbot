import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Avatar, AvatarStack } from "../src/avatar/Avatar.tsx"
import { AvatarPicker } from "../src/avatar/AvatarPicker.tsx"
import {
  AvatarColors,
  AvatarShapes,
  botTintStyle,
  defaultBotAvatar,
  fnv1a32,
  normalizeAvatar,
} from "../src/avatar/palette.ts"
import { avatarBodies } from "../src/avatar/shapes.ts"

describe("avatar palette mirrors @openbot/contracts", () => {
  test("arrays keep the contract order", () => {
    expect([...AvatarColors]).toEqual([
      "black",
      "brown",
      "red",
      "orange",
      "yellow",
      "green",
      "cyan",
      "blue",
      "violet",
      "magenta",
      "gray",
    ])
    expect([...AvatarShapes]).toEqual([
      "blob",
      "cloud",
      "square",
      "sparkle",
      "clover",
      "heart",
      "flower",
      "teardrop",
      "tablet",
      "wedge",
      "house",
      "star",
      "hex",
    ])
  })

  // Vectors computed with packages/contracts/src/domain.ts (fnv1a32 + defaultBotAvatar).
  const vectors: ReadonlyArray<readonly [string, number, string, string]> = [
    ["", 2166136261, "sparkle", "black"],
    ["a", 3826002220, "cloud", "orange"],
    ["bot_1", 1034264166, "blob", "cyan"],
    ["bot_01HZX3", 82423379, "hex", "red"],
    ["chief-of-staff", 3497673251, "teardrop", "green"],
    ["Ünïcödé 🤖", 1044828582, "heart", "cyan"],
  ]
  test.each(vectors)("default avatar for %p is deterministic", (id, hash, shape, color) => {
    expect(fnv1a32(id)).toBe(hash)
    expect(defaultBotAvatar(id)).toEqual({ shape: shape as never, color: color as never })
    expect(defaultBotAvatar(id)).toEqual(defaultBotAvatar(id))
  })

  test("unknown stored values fall back", () => {
    expect(normalizeAvatar({ shape: "pebble", color: "teal" })).toEqual({ shape: "blob", color: "gray" })
    expect(normalizeAvatar({ shape: "star", color: "violet" })).toEqual({ shape: "star", color: "violet" })
  })

  test("bot tint maps hues and leaves neutral colors alone", () => {
    expect(botTintStyle("violet")["--ob-accent"]).toBe("var(--ob-purple)")
    expect(botTintStyle("cyan")["--ob-bubble-user"]).toBe("var(--ob-cyan-bubble)")
    expect(botTintStyle("black")).toEqual({})
    expect(botTintStyle("gray")).toEqual({})
    expect(botTintStyle("nope")).toEqual({})
    expect(botTintStyle("red", { branded: true })["--ob-bubble-agent"]).toBe("var(--ob-red-soft)")
  })
})

describe("avatar bodies", () => {
  test("every shape has a closed, finite path inside the box", () => {
    for (const shape of AvatarShapes) {
      const body = avatarBodies[shape]
      expect(body.d.startsWith("M")).toBe(true)
      expect(body.d.endsWith("Z")).toBe(true)
      const nums = body.d.match(/-?\d+(\.\d+)?/g)!.map(Number)
      expect(nums.length).toBeGreaterThan(10)
      for (const n of nums) {
        expect(Number.isFinite(n)).toBe(true)
        expect(n).toBeGreaterThanOrEqual(0)
        expect(n).toBeLessThanOrEqual(100)
      }
      expect(body.face[0]).toBeGreaterThan(20)
      expect(body.face[0]).toBeLessThan(80)
    }
  })

  test("all 13 bodies are distinct", () => {
    expect(new Set(AvatarShapes.map((s) => avatarBodies[s].d)).size).toBe(13)
  })
})

describe("<Avatar>", () => {
  test("renders an svg body with two eyes and data attributes", () => {
    const html = renderToStaticMarkup(
      <Avatar shape="hex" color="blue" size={36} label="Research Scout" working status="unread" />,
    )
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Research Scout"')
    expect(html).toContain('data-working=""')
    expect(html).toContain('data-shape="hex"')
    expect(html).toContain("var(--ob-avatar-blue)")
    expect(html.match(/<rect/g)?.length).toBe(2)
    expect(html).toContain('data-status="unread"')
  })

  test("expressions change the eyes", () => {
    const shapes = ["neutral", "happy", "surprised", "sleepy", "inspecting"].map((e) =>
      renderToStaticMarkup(<Avatar shape="blob" color="cyan" expression={e as never} />).replace(
        /data-expression="[a-z]+"/,
        "",
      ),
    )
    expect(new Set(shapes).size).toBe(5)
    expect(renderToStaticMarkup(<Avatar expression="happy" />)).toContain("stroke-linecap")
  })

  test("decorative by default, unknown values fall back", () => {
    const html = renderToStaticMarkup(<Avatar shape="??" color="??" />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-shape="blob"')
    expect(html).toContain('data-color="gray"')
  })

  test("ghost has no eyes; stack renders up to 3", () => {
    expect(renderToStaticMarkup(<Avatar ghost />)).not.toContain("<rect")
    const stack = renderToStaticMarkup(<AvatarStack avatars={[{}, {}, {}, {}]} />)
    expect(stack.match(/ob-avatar /g)?.length).toBe(3)
  })

  test("picker lists 13 shapes and 11 colors with the selection checked", () => {
    const html = renderToStaticMarkup(<AvatarPicker shape="star" color="green" />)
    expect(html.match(/role="radio"/g)?.length).toBe(24)
    expect(html).toContain('aria-checked="true" aria-label="star"')
    expect(html).toContain('aria-checked="true" aria-label="green"')
  })
})
