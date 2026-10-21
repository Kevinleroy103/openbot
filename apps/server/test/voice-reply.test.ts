// Voice calls (experiment): reading the voice model's JSON reply as it streams, and cutting it into sentences.
import { describe, expect, test } from "bun:test"
import { parseReply, SentenceChunker, sayFieldSoFar, speakable } from "../src/voice/reply.ts"

describe("voice replies", () => {
  test("the spoken text is read out of the JSON while it is written", () => {
    const full = '{"action":"delegate","say":"On it, I\'ll check \\"Slack\\".\\nOne sec \\u00e9"}'
    const seen = [...Array(full.length + 1).keys()].map((n) => sayFieldSoFar(full.slice(0, n)))
    expect(seen[10]).toBeUndefined()
    // never a half escape, and the text only grows
    const texts = seen.filter((s) => s !== undefined).map((s) => s.text)
    for (let i = 1; i < texts.length; i++) expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true)
    expect(sayFieldSoFar(full)).toEqual({ text: 'On it, I\'ll check "Slack".\nOne sec é', closed: true })
    expect(parseReply(full)).toEqual({ action: "delegate", say: 'On it, I\'ll check "Slack".\nOne sec é' })
    expect(parseReply('{"action":"maybe","say":"x"}')).toBeUndefined()
  })

  test("the Bot's written answer becomes something to say", () => {
    expect(speakable("**Tomorrow** is light:\n- 9:00 reminder\n- 11:30 Devenders ([invite](https://cal.example/x))\n\nNothing after `that`")).toBe(
      "Tomorrow is light: 9:00 reminder. 11:30 Devenders (invite). Nothing after that.",
    )
  })

  test("sentences come out as soon as they end; a long first one starts at a comma", () => {
    const chunker = new SentenceChunker()
    expect(chunker.push("On it. I'll ch")).toEqual(["On it."])
    expect(chunker.push("eck Slack now! And")).toEqual(["I'll check Slack now!"])
    expect(chunker.push(" then")).toEqual([])
    expect(chunker.flush()).toBe("And then")
    expect(chunker.flush()).toBeUndefined()

    const long = new SentenceChunker()
    expect(long.push("Anthony replied in the eng channel this afternoon, saying the plan looks good")).toEqual(["Anthony replied in the eng channel this afternoon,"])
    expect(long.push(" but wants Karl's access kept. ")).toEqual(["saying the plan looks good but wants Karl's access kept."])
  })
})
