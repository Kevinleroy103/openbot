import { describe, expect, test } from "bun:test"
import { chunksOf, parseScript, scriptSourceOf } from "../src/script.ts"

describe("parseScript", () => {
  test("text without directives gets the default reply", () => {
    expect(parseScript("hello there")).toEqual([{ _tag: "Default", text: "hello there" }])
  })

  test("parses every directive", () => {
    expect(parseScript("echo: hi there")).toEqual([{ _tag: "Echo", text: "hi there" }])
    expect(parseScript("slow: one two")).toEqual([{ _tag: "Slow", text: "one two" }])
    expect(parseScript("approve: rm -rf /tmp/x")).toEqual([{ _tag: "Approve", command: "rm -rf /tmp/x" }])
    expect(parseScript("approve: bun test @ /home/me/projects/snip")).toEqual([
      { _tag: "Approve", command: "bun test", cwd: "/home/me/projects/snip" },
    ])
    expect(parseScript("approve: echo a@b")).toEqual([{ _tag: "Approve", command: "echo a@b" }])
    expect(parseScript("ask: Color? | red | blue")).toEqual([
      { _tag: "Ask", prompt: "Color?", options: ["red", "blue"] },
    ])
    expect(parseScript("fail: boom")).toEqual([{ _tag: "Fail", message: "boom" }])
    expect(parseScript("think: hmm")).toEqual([{ _tag: "Think", text: "hmm" }])
    expect(parseScript("crash: gone")).toEqual([{ _tag: "Crash", reason: "gone" }])
  })

  test("background work directives (D5.7)", () => {
    expect(parseScript("bg: 5 HN digest")).toEqual([{ _tag: "Background", seconds: 5, title: "HN digest" }])
    expect(parseScript("bg: 0.5 quick one")).toEqual([{ _tag: "Background", seconds: 0.5, title: "quick one" }])
    expect(parseScript("work: 2 HN digest")).toEqual([{ _tag: "Work", seconds: 2, title: "HN digest" }])
    expect(parseScript("work:")).toEqual([{ _tag: "Work", seconds: 3, title: "the work" }])
    expect(parseScript('[Result of "HN digest"]\nTop story: Bun 2.0')).toEqual([
      { _tag: "Report", title: "HN digest", body: "Top story: Bun 2.0" },
    ])
    expect(parseScript('[DM with the owner]\n[Result of "HN digest"]\nAll good')).toEqual([
      { _tag: "Report", title: "HN digest", body: "All good" },
    ])
    // a result in a group turn is its own message, never folded into an older directive line
    expect(parseScript('[Group chat "G" · members: @A (you)]\n[@owner]: bg: 2 X\n[Result of "X"]\ndone')).toEqual([
      { _tag: "Report", title: "X", body: "done" },
    ])
  })

  test("a task's first turn scripts only its brief; updates to running work", () => {
    const first =
      "[Recent messages of your direct chat with the owner, where this work was started (oldest first, for context)]\n[Owner]: echo: earlier\n[Owner]: bg: 2 X\n\n[The brief]\nwork: 2 X"
    expect(parseScript(first)).toEqual([{ _tag: "Work", seconds: 2, title: "X" }])
    expect(parseScript(`${first}\n\n[Update to this work]\ncenter the globe`)).toEqual([
      { _tag: "Work", seconds: 2, title: "X" },
      { _tag: "Updated", message: "center the globe" },
    ])
    expect(
      parseScript("[Update to this work]\necho: not a directive here\n\n(Your previous answer has not been used yet.)"),
    ).toEqual([{ _tag: "Updated", message: "echo: not a directive here" }])
    expect(parseScript("upd: X | center the globe")).toEqual([
      { _tag: "UpdateWork", title: "X", message: "center the globe" },
    ])
  })

  test("tool directive parses name and JSON arguments", () => {
    expect(parseScript(`tool:message_bot {"to":"Echo","text":"hi"}`)).toEqual([
      { _tag: "Tool", name: "message_bot", args: { to: "Echo", text: "hi" } },
    ])
    expect(parseScript("tool: list_bots")).toEqual([{ _tag: "Tool", name: "list_bots", args: {} }])
    expect(parseScript("tool: mcp__openbot__list_bots {}")).toEqual([{ _tag: "Tool", name: "list_bots", args: {} }])
    const invalid = parseScript("tool: shell {not json")
    expect(invalid[0]?._tag).toBe("ToolInvalid")
    expect(parseScript("tool: shell [1]")[0]?._tag).toBe("ToolInvalid")
  })

  test("several directives run in order; prose lines and mentions are skipped", () => {
    expect(parseScript("[From Echo]\n@Scout echo: one\nsome prose\nECHO: two")).toEqual([
      { _tag: "Echo", text: "one" },
      { _tag: "Echo", text: "two" },
    ])
  })

  test("directive words inside prose are not directives", () => {
    expect(parseScript("please echo: this")).toEqual([{ _tag: "Default", text: "please echo: this" }])
  })
})

describe("attributed deliveries (group catch-up, bot-to-bot)", () => {
  const group = (...lines: Array<string>) =>
    [
      '[Group chat "Alpha, Bravo & Charlie" · members: @Alpha, @Bravo (you), @Charlie · reply here; @mention a member here to involve them (not message_bot) · new messages since your last turn]',
      ...lines,
    ].join("\n")

  test("a group turn scripts the owner's line without its sender prefix", () => {
    expect(parseScript(group("[@owner]: echo: hello team"))).toEqual([{ _tag: "Echo", text: "hello team" }])
    // the pre-members header shape still parses
    expect(parseScript('[Group chat "G": new messages since your last turn]\n[@owner]: echo: old')).toEqual([
      { _tag: "Echo", text: "old" },
    ])
  })

  test("only the newest message with a directive runs (older catch-up lines were for other bots)", () => {
    const text = group("[@owner]: echo: hello team", "[@Alpha]: hello team", "[@owner]: @Bravo echo: bravo here")
    expect(parseScript(text)).toEqual([{ _tag: "Echo", text: "bravo here" }])
  })

  test("another bot's newer plain reply does not hide the owner's directive", () => {
    const text = group("[@owner]: @everyone echo: roll call", "[@Alpha]: roll call")
    expect(parseScript(text)).toEqual([{ _tag: "Echo", text: "roll call" }])
  })

  test("multi-line messages keep their continuation lines", () => {
    const text = group("[@owner]: think: hmm", "echo: two lines")
    expect(parseScript(text).map((d) => d._tag)).toEqual(["Think", "Echo"])
  })

  test("a bot-to-bot message is scripted without the sender prefix", () => {
    expect(parseScript("[@Alpha]: echo: Got your note")).toEqual([{ _tag: "Echo", text: "Got your note" }])
  })

  test("one-mind origin tags: DM / routine tags and bot DMs are skipped; recall: parses", () => {
    expect(parseScript("[DM with the owner]\necho: back here")).toEqual([{ _tag: "Echo", text: "back here" }])
    expect(parseScript('[Routine run "Daily" · your reply is posted there]\necho: ran')).toEqual([
      { _tag: "Echo", text: "ran" },
    ])
    expect(parseScript("[Direct message from @Alpha]: echo: Got it")).toEqual([{ _tag: "Echo", text: "Got it" }])
    expect(
      parseScript('[Group chat "G" · members: @A (you), @B · your reply is posted here]\n[@owner]: recall:'),
    ).toEqual([{ _tag: "Recall" }])
  })

  test("without directives the default reply quotes the newest message only", () => {
    expect(parseScript(group("[@owner]: hi all"))).toEqual([{ _tag: "Default", text: "hi all" }])
  })

  test("plain text and several queued messages are unchanged", () => {
    expect(scriptSourceOf("echo: a\n\necho: b")).toBe("echo: a\n\necho: b")
    expect(parseScript("echo: a\n\necho: b")).toHaveLength(2)
  })
})

describe("chunksOf", () => {
  test("splits into words keeping whitespace", () => {
    expect(chunksOf("hello big world")).toEqual(["hello ", "big ", "world"])
    expect(chunksOf("hello big world").join("")).toBe("hello big world")
    expect(chunksOf("  lead").join("")).toBe("  lead")
    expect(chunksOf("")).toEqual([""])
  })
})
