// Voice calls (experiment): what the Bot is sent for the owner's words on a call.
import { describe, expect, test } from "bun:test"
import { voiceText } from "../src/voice/service.ts"

describe("voice messages to the Bot", () => {
  test("the first one says how a call works; every one asks for a word before tools", () => {
    const first = voiceText("What's on tomorrow?", true)
    expect(first).toContain("We're on a voice call now.")
    expect(first).toContain("Me: What's on tomorrow?")
    const later = voiceText("And my email?", false)
    expect(later).not.toContain("We're on a voice call now.")
    expect(later).toContain("Me (on the call): And my email?")
    for (const text of [first, later]) expect(text).toContain("first write one short sentence saying what you're about to do")
  })

  test("an interruption says how far the Bot got; a stop says its work was stopped", () => {
    const cut = voiceText("Wait, which one?", false, { heard: "At 11:30 it's Devenders, and Break…" })
    expect(cut).toContain(`All I heard was: "At 11:30 it's Devenders, and Break…" The rest wasn't said.`)
    expect(voiceText("Hold on.", false, { heard: "nothing yet" })).toContain("I cut you off before you said anything.")
    expect(voiceText("Stop.", false, { stopped: true })).toContain("(I stopped what you were working on.)")
  })
})
