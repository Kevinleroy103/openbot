// The Slack connector (D3.4) against a fake Slack, and a Bot's draft end to end through the brain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type TranscriptEntry, transcriptOf } from "@openbot/contracts"
import type { SlackEvent } from "@openbot/core"
import { Effect, Exit, Fiber, Ref, Scope, Stream } from "effect"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSlackConnector, parseSlackLink } from "../src/slack/connector.ts"
import { readableText, slackText } from "../src/slack/text.ts"
import { FAKE_APP_TOKEN, FAKE_USER_TOKEN, type FakeSlack, messageEnvelope, startFakeSlack } from "./fixtures/fakeSlack.ts"
import { eventually, login, rpcClient, startServer, type TestServer, watchConversation } from "./helpers.ts"

describe("Slack text", () => {
  const names = { user: (id: string) => ({ U1: "Alice Smith" } as Record<string, string>)[id], channel: (id: string) => ({ C1: "general" } as Record<string, string>)[id] }

  test("reads Slack markup the way people do", () => {
    expect(readableText("hi <@U1>, see <#C1> and <#C2|random>", names)).toBe("hi @Alice Smith, see #general and #random")
    expect(readableText("<https://x.com/a|the doc> <https://x.com/b> <mailto:a@b.c|a@b.c>", names)).toBe("the doc (https://x.com/a) https://x.com/b a@b.c")
    expect(readableText("<!here> <!channel> <!subteam^S1|@design> 1 &lt; 2 &amp;&amp; 3 &gt; 2", names)).toBe("@here @channel @design 1 < 2 && 3 > 2")
    expect(readableText("<@U9>", names)).toBe("@someone")
  })

  test("writes mentions of known people and escapes the rest", () => {
    const people = [{ id: "U1", names: ["Alice Smith", "alice"] }, { id: "U2", names: ["Bob", "bob"] }]
    expect(slackText("@Alice Smith and @bob: 1 < 2 & done", people)).toBe("<@U1> and <@U2>: 1 &lt; 2 &amp; done")
    expect(slackText("thanks @alice! cc @here", people)).toBe("thanks <@U1>! cc <!here>")
    expect(slackText("mail me at a@alice.com, @Carol", people)).toBe("mail me at a@alice.com, @Carol")
  })

  test("message links", () => {
    expect(parseSlackLink("https://acme.slack.com/archives/C123ABC/p1729340000123456")).toEqual({ channelId: "C123ABC", ts: "1729340000.123456" })
    expect(parseSlackLink("https://acme.slack.com/archives/C1/p1729340050000100?thread_ts=1729340000.000100&cid=C1")).toEqual({
      channelId: "C1",
      ts: "1729340050.000100",
      threadTs: "1729340000.000100",
    })
    expect(parseSlackLink("#general")).toBeUndefined()
  })
})

describe("SlackConnector", () => {
  let slack: FakeSlack
  let dir: string
  beforeAll(() => {
    slack = startFakeSlack()
    dir = mkdtempSync(join(tmpdir(), "openbot-slack-test-"))
  })
  afterAll(() => {
    slack.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test("connects, reads, searches, finds, resolves, sends, hears live messages and forgets", async () => {
    const file = join(dir, "slack.json")
    const scope = Effect.runSync(Scope.make())
    const connector = await Effect.runPromise(Scope.provide(makeSlackConnector({ file, apiUrl: slack.url, reconnectMs: 50 }), scope))
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
    try {
      expect(await run(connector.status)).toEqual({ connected: false, events: "off" })
      const bot = await Effect.runPromiseExit(connector.connect({ userToken: "xoxb-nope" }))
      expect(Exit.isFailure(bot)).toBe(true)
      const wrong = await Effect.runPromiseExit(connector.connect({ userToken: "xoxp-wrong" }))
      expect(JSON.stringify(wrong)).toContain("didn't accept")

      const connected = await run(connector.connect({ userToken: FAKE_USER_TOKEN, appToken: FAKE_APP_TOKEN }))
      expect(connected).toMatchObject({ connected: true, team: "Acme", userId: "U_OWNER", userName: "Owner" })
      expect(statSync(file).mode & 0o777).toBe(0o600)
      for (let i = 0; i < 100 && (await run(connector.status)).events !== "live"; i++) await Bun.sleep(20)
      expect((await run(connector.status)).events).toBe("live")

      const general = await run(connector.read({ conversation: "#general", limit: 30 }))
      expect(general.conversation).toEqual({ id: "C_GENERAL", kind: "channel", label: "#general", topic: "Company news" })
      expect(general.more).toBe(true)
      expect(general.messages.map((m) => `${m.author}: ${m.text}`)).toEqual([
        "Bob: see the doc (https://x.com/doc) & #general",
        "Alice Smith: Ping @Owner, the deploy failed",
      ])
      expect(general.messages[0]).toMatchObject({ replyCount: 2, permalink: "https://acme.slack.com/archives/C_GENERAL/p1729340000000100" })

      const thread = await run(connector.read({ conversation: "https://acme.slack.com/archives/C_GENERAL/p1729340000000100", limit: 30 }))
      expect(thread.messages.map((m) => m.text)).toEqual(["Can someone look at the deploy?", "On it"])

      const alice = await run(connector.read({ conversation: "@alice", limit: 10 }))
      expect(alice.conversation).toEqual({ id: "D_ALICE", kind: "dm", label: "Alice Smith" })

      const found = await run(connector.search({ query: "deploy", limit: 20 }))
      expect(found.total).toBe(3)
      expect(found.messages[0]).toMatchObject({ where: "#general", author: "Alice Smith", text: "deploy is broken", threadTs: "1729340000.000100" })

      const people = await run(connector.find("ali"))
      expect(people.people).toEqual([{ id: "U_ALICE", name: "Alice Smith", handle: "alice", title: "Designer" }])
      const places = await run(connector.find("gen"))
      expect(places.conversations.map((c) => c.label)).toEqual(["#general"])

      const ambiguous = await Effect.runPromiseExit(connector.resolve({ to: "o" }))
      expect(JSON.stringify(ambiguous)).toContain("matches several people")
      const target = await run(connector.resolve({ to: "#general", thread: "1729340000.000100" }))
      expect(target.thread).toMatchObject({ author: "Alice Smith", text: "Can someone look at the deploy?" })

      const sent = await run(connector.send({ channelId: "C_GENERAL", text: "Fixed, thanks @Alice Smith & @Bob", threadTs: "1729340000.000100" }))
      expect(slack.posted.at(-1)).toEqual({ channel: "C_GENERAL", text: "Fixed, thanks <@U_ALICE> &amp; <@U_BOB>", thread_ts: "1729340000.000100" })
      expect(sent.permalink).toBe("https://acme.slack.com/archives/C_GENERAL/p1729340400000100?thread_ts=1729340000.000100&cid=C_GENERAL")

      // live messages: others' messages arrive (acknowledged), the owner's own and edits do not
      const heard = await Effect.runPromise(Effect.forkDetach(connector.events.pipe(Stream.take(2), Stream.runCollect)))
      await Bun.sleep(20)
      const mine = messageEnvelope({ channel: "C_GENERAL", user: "U_OWNER", text: "my own" })
      const edit = messageEnvelope({ channel: "C_GENERAL", subtype: "message_changed" })
      const dm = messageEnvelope({ channel: "D_ALICE", channel_type: "im", user: "U_ALICE", text: "got a minute?" })
      const ping = messageEnvelope({ channel: "C_GENERAL", user: "U_BOB", text: "<@U_OWNER> review please" })
      for (const envelope of [mine, edit, dm, dm, ping]) slack.push(envelope)
      const events = [...(await Effect.runPromise(Fiber.join(heard)))] as Array<SlackEvent>
      expect(events.map((e) => [e.conversation.label, e.message.author, e.message.text, e.mentionsOwner])).toEqual([
        ["Alice Smith", "Alice Smith", "got a minute?", false],
        ["#general", "Bob", "@Owner review please", true],
      ])
      for (let i = 0; i < 100 && slack.acks.length < 5; i++) await Bun.sleep(10)
      expect(slack.acks).toEqual(expect.arrayContaining([mine.envelope_id, edit.envelope_id, dm.envelope_id, ping.envelope_id]))

      // Slack asks to reconnect: a new socket, still live
      slack.push({ type: "disconnect", reason: "refresh_requested" })
      await Bun.sleep(300)
      expect((await run(connector.status)).events).toBe("live")

      await run(connector.disconnect)
      expect(existsSync(file)).toBe(false)
      expect(await run(connector.status)).toEqual({ connected: false, events: "off" })
      const after = await Effect.runPromiseExit(connector.read({ conversation: "#general", limit: 5 }))
      expect(JSON.stringify(after)).toContain("isn't connected")
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }, 30_000)

  test("a token without every scope is refused with what is missing", async () => {
    const partial = startFakeSlack({ scopes: "channels:history,users:read" })
    const scope = Effect.runSync(Scope.make())
    try {
      const connector = await Effect.runPromise(Scope.provide(makeSlackConnector({ file: join(dir, "partial.json"), apiUrl: partial.url }), scope))
      const exit = await Effect.runPromiseExit(connector.connect({ userToken: FAKE_USER_TOKEN }))
      expect(JSON.stringify(exit)).toContain("missing these permissions")
      expect(JSON.stringify(exit)).toContain("search:read")
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      partial.stop()
    }
  })
})

describe("Slack in the brain", () => {
  let slack: FakeSlack
  let server: TestServer
  let cookie: string
  beforeAll(async () => {
    slack = startFakeSlack()
    server = await startServer({ config: { slackApiUrl: slack.url } })
    cookie = await login(server.base, server.ownerToken)
  }, 30_000)
  afterAll(async () => {
    await server?.close()
    slack?.stop()
  }, 30_000)

  test("connect in Settings; a Bot drafts; the owner edits and sends it as themselves", () =>
    server.run(Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      expect(yield* client["slack.status"]()).toEqual({ connected: false, events: "off" })
      const status = yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN })
      expect(status).toMatchObject({ connected: true, team: "Acme", userName: "Owner", events: "off" })

      const bot = yield* client["bots.create"]({ name: "Courier", harness: { kind: "fake" }, clientNonce: "slack-courier" })
      const context = yield* client["bots.readContext"]({ botId: bot.id })
      expect(context.instructions).toContain("## Slack")

      const convo = yield* watchConversation(client, bot.directConversationId)
      yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "synchronized" })
      yield* client["messages.send"]({
        conversationId: bot.directConversationId,
        text: `tool: slack_draft {"to":"#general","text":"The deploy is fixed.","thread":"1729340000.000100"}`,
        clientNonce: "slack-draft-1",
      })
      const drafted = yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.kind === "card" && e.card.type === "slack-draft"),
        { label: "draft card", timeout: 20_000 },
      )
      const card = transcriptOf(drafted).find((e): e is Extract<TranscriptEntry, { kind: "card" }> => e.kind === "card" && e.card.type === "slack-draft")!
      expect(card.card).toMatchObject({ type: "slack-draft", team: "Acme", to: "#general", channelId: "C_GENERAL", threadLabel: "Alice Smith: Can someone look at the deploy?" })
      expect(card.state.status).toBe("pending")
      expect(slack.posted).toHaveLength(0)

      yield* client["slack.sendDraft"]({ entryId: card.id, text: "The deploy is fixed, @Alice Smith." })
      expect(slack.posted).toEqual([{ channel: "C_GENERAL", text: "The deploy is fixed, <@U_ALICE>.", thread_ts: "1729340000.000100" }])
      const sent = yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.id === card.id && e.kind === "card" && e.state.status === "resolved"),
        { label: "sent card" },
      )
      expect(transcriptOf(sent).find((e) => e.id === card.id)).toMatchObject({
        card: { text: "The deploy is fixed, @Alice Smith." },
        state: { status: "resolved", detail: "Sent", link: expect.stringContaining("/archives/C_GENERAL/p1729340400000100") },
      })
      const again = yield* Effect.flip(client["slack.sendDraft"]({ entryId: card.id, text: "again" }))
      expect(again._tag).toBe("Conflict")

      yield* client["slack.disconnect"]()
      expect(yield* client["slack.status"]()).toEqual({ connected: false, events: "off" })
    })), 60_000)
})
