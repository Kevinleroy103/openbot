import { describe, expect, test } from "bun:test"
import { generateTokensCss, tokensPath } from "../scripts/gen-theme.ts"
import { AvatarColors } from "../src/avatar/palette.ts"

describe("gen-theme", () => {
  test("is deterministic and matches the committed tokens.css", async () => {
    const a = generateTokensCss()
    const b = generateTokensCss()
    expect(a).toBe(b)
    expect(await Bun.file(tokensPath).text()).toBe(a)
  })

  test("emits light-dark() theme values and Tailwind theme mappings", () => {
    const css = generateTokensCss()
    expect(css).toContain("--ob-pane:                    light-dark(#ffffff,   #161616);")
    expect(css).toContain("--ob-sidebar:                 light-dark(#f5f5f5,   #0e0e0e);")
    expect(css).toContain("--ob-bubble-user:             light-dark(#1c1c1cff, #f5f5f52e);")
    expect(css).toContain("--color-*: initial;")
    expect(css).toContain("--color-bubble-agent: var(--ob-bubble-agent);")
    expect(css).toContain("--radius-bubble: 18px;")
    expect(css).toContain('[data-theme="light"] { color-scheme: light; }')
    expect(css).not.toContain("undefined")
    for (const c of AvatarColors) expect(css).toContain(`--ob-avatar-${c}:`)
    // Dark mode has no drop shadows.
    expect(css).toContain("--ob-sh-popover-ambient:      light-dark(#1c1c1c1a, #f5f5f500);")
  })
})
