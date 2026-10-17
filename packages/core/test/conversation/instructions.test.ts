// The screen lines of the OpenBot instructions (D1.7): `computer` with a desktop, `request_takeover`
// with any screen (desktop or browser window).
import { describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import type { PlacementSummary, Toolset } from "../../src/ports/Placement.ts"
import { renderBase } from "../../src/services/conversation/InstructionRenderer.ts"
import { makeBot } from "../../src/testing/index.ts"

const placement = (toolsets: ReadonlyArray<Toolset>): PlacementSummary => ({
  mode: "native-local",
  hostNodeId: LOCAL_NODE_ID,
  workspacePath: "/work",
  toolsets,
  promptAppend: "",
})

describe("InstructionRenderer: screen tools", () => {
  const bot = makeBot({ name: "Scout" })

  test("no screen: neither computer nor request_takeover", () => {
    const text = renderBase(bot, placement(["bot"]))
    expect(text).not.toContain("`computer`")
    expect(text).not.toContain("request_takeover")
  })

  test("browser only: request_takeover, no computer", () => {
    const text = renderBase(bot, placement(["bot", "browser"]))
    expect(text).toContain("`browser` drives your own browser window")
    expect(text).toContain("call `request_takeover`")
    expect(text).not.toContain("`computer`")
  })

  test("desktop: your own screen, screenshot first, browser for web pages, request_takeover for logins", () => {
    const text = renderBase(bot, placement(["bot", "browser", "computer"]))
    expect(text).toContain("You have your own screen, with a browser, a terminal, files and an editor")
    expect(text).toContain("take a screenshot first")
    expect(text).toContain("Prefer `browser` for web pages")
    expect(text).toContain("For a login, a password, a 2FA code, a CAPTCHA")
    expect(text).toContain("finish your turn and wait for it")
  })
})
