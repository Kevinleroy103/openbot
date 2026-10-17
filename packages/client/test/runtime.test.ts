// End to end: the client runtime in Bun against an in-process Effect RPC server on a real Bun
// WebSocket (through a proxy that can cut the link). Acceptance (plan W1.12): subscribe → snapshot →
// change → disconnect → resume from cursor without gaps; mutation atoms call RPCs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Exit } from "effect"
import { type ConversationId, type ConversationState, type EntryId, transcriptOf } from "@openbot/contracts"
import { AsyncResult } from "effect/reactivity"
import {
  commandAtom,
  commands,
  type ConnectionState,
  connectionAtom,
  conversationAtom,
  outboxAtom,
  reconnectAtom,
  rosterAtom,
  sendMessageAtom,
  settingsAtom,
  settingsQueryAtom,
  uploadFilesAtom,
} from "../src/index.ts"
import { botFixture, conversationFixture, FakeBrain, FlakyProxy, messageFixture, type RunningBrain, startBrain } from "./support/fakeBrain.ts"
import { makeRegistry, runFn, valueOf, waitFor } from "./support/registry.ts"

const C1 = "cnv_1"
const C2 = "cnv_2"

let brain: FakeBrain
let running: RunningBrain
let proxy: FlakyProxy

beforeAll(async () => {
  brain = new FakeBrain()
  const c1 = brain.addConversation(conversationFixture(C1, "bot_1"))
  c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_001", 10, "one") })
  c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_002", 20, "two") })
  brain.addConversation(conversationFixture(C2, "bot_1"))
  brain.roster.apply({ type: "bot.upserted", bot: botFixture("bot_1", "Scout", C1) })
  running = await startBrain(brain)
  proxy = new FlakyProxy(running.url)
})

afterAll(async () => {
  proxy.stop()
  await running.stop()
})

const conversationValue = (r: AsyncResult.AsyncResult<ConversationState, unknown>) => valueOf(r)
const texts = (s: ConversationState) => transcriptOf(s).map((e) => (e.kind === "message" ? e.text : e.kind))

describe("conversation replica", () => {
  test("snapshot → change → link cut → changes while offline → resume from cursor, no gaps", async () => {
    const registry = makeRegistry(proxy.url)
    const atom = conversationAtom(C1 as ConversationId)
    const unmountConn = registry.mount(connectionAtom)
    const unmount = registry.mount(atom)
    try {
      // 1. snapshot then synchronized
      const first = await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true)
      expect(texts(conversationValue(first)!)).toEqual(["one", "two"])
      expect(conversationValue(first)!.cursor).toEqual({ epoch: "e1", sequence: 2 })
      expect(brain.subscribes.filter((s) => s.rpc === "conversations.subscribe").at(-1)).toMatchObject({ after: undefined, plan: "snapshot" })
      expect(registry.get(connectionAtom).status).toBe("online")
      const generation = registry.get(connectionAtom).generation

      // 2. a live change
      const c1 = brain.conversation(C1)
      c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_003", 30, "three") })
      await waitFor(registry, atom, (r) => conversationValue(r)?.cursor?.sequence === 3)

      // 3. cut the link: the state goes stale, the supervisor reports offline
      proxy.cut()
      await waitFor(registry, connectionAtom, (s: ConnectionState) => s.status === "offline")
      await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === false)

      // 4. the brain keeps working while we are away
      c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_003", 30, "three (edited)", { revision: 1 }) })
      c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_004", 40, "four") })
      c1.apply({ type: "entry.removed", entryId: "ent_001" as EntryId, reason: "retracted" })
      c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_005", 50, "five") })
      await Bun.sleep(150) // a few failed reconnect attempts
      expect(registry.get(connectionAtom).status).toBe("offline")
      expect(registry.get(connectionAtom).attempt).toBeGreaterThan(0)

      // 5. link back: reconnect, resubscribe with the last cursor, replay only the missed changes
      const subscribesBefore = brain.subscribes.length
      proxy.restore()
      const resumed = await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true && conversationValue(r)?.cursor?.sequence === 7)
      const resumes = brain.subscribes.slice(subscribesBefore).filter((s) => s.rpc === "conversations.subscribe")
      expect(resumes[0]).toMatchObject({ after: { epoch: "e1", sequence: 3 }, plan: "replay" })
      expect(resumes.every((s) => s.plan === "replay")).toBe(true)
      expect(texts(conversationValue(resumed)!)).toEqual(["two", "three (edited)", "four", "five"])
      // identical to the server's replica: nothing lost, nothing duplicated
      expect(texts(conversationValue(resumed)!)).toEqual(transcriptOf(c1.state).map((e) => (e.kind === "message" ? e.text : e.kind)))
      expect(registry.get(connectionAtom)).toMatchObject({ status: "online", attempt: 0 })
      expect(registry.get(connectionAtom).generation).toBeGreaterThan(generation)

      // 6. live again after the resume
      c1.apply({ type: "entry.upserted", entry: messageFixture(C1, "ent_006", 60, "six") })
      const live = await waitFor(registry, atom, (r) => conversationValue(r)?.cursor?.sequence === 8)
      expect(texts(conversationValue(live)!).at(-1)).toBe("six")
    } finally {
      unmount()
      unmountConn()
      registry.dispose()
    }
  }, 15_000)

  test("a gap larger than the replay buffer gets a fresh snapshot", async () => {
    const registry = makeRegistry(proxy.url)
    const atom = conversationAtom(C2 as ConversationId)
    const unmount = registry.mount(atom)
    try {
      await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true)
      proxy.cut()
      await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === false)
      const c2 = brain.conversation(C2)
      for (let i = 1; i <= 300; i++) c2.apply({ type: "entry.upserted", entry: messageFixture(C2, `ent_${String(i).padStart(4, "0")}`, i, `m${i}`) })
      const before = brain.subscribes.length
      proxy.restore()
      const resumed = await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true && conversationValue(r)?.cursor?.sequence === 300)
      expect(brain.subscribes.slice(before).find((s) => s.rpc === "conversations.subscribe")).toMatchObject({ after: { epoch: "e1", sequence: 0 }, plan: "snapshot" })
      expect(conversationValue(resumed)!.entries.size).toBe(300)
    } finally {
      unmount()
      registry.dispose()
    }
  }, 15_000)

  test("remounting within the cache window resumes from the cached cursor", async () => {
    const registry = makeRegistry(running.url)
    const atom = conversationAtom(C1 as ConversationId)
    let unmount = registry.mount(atom)
    try {
      const first = await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true)
      const cursor = conversationValue(first)!.cursor!
      unmount()
      await Bun.sleep(50)
      const before = brain.subscribes.length
      unmount = registry.mount(atom)
      await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true)
      expect(brain.subscribes.slice(before).find((s) => s.rpc === "conversations.subscribe")).toMatchObject({ after: cursor, plan: "replay" })
    } finally {
      unmount()
      registry.dispose()
    }
  })

  test("an unknown conversation fails with NotFound instead of retrying", async () => {
    const registry = makeRegistry(running.url)
    const atom = conversationAtom("cnv_missing" as ConversationId)
    const unmount = registry.mount(atom)
    try {
      const failed = await waitFor(registry, atom, (r) => r._tag === "Failure")
      expect(AsyncResult.isFailure(failed) && (failed.cause as any).reasons?.[0]?.error?._tag).toBe("NotFound")
    } finally {
      unmount()
      registry.dispose()
    }
  })
})

describe("connection supervisor", () => {
  test("reconnectAtom retries at once (despite a long backoff) and replicas resume from their cursor", async () => {
    const slow = { initialMs: 4_000, maxMs: 4_000, factor: 1, jitter: false }
    const registry = makeRegistry(proxy.url, { reconnect: slow, resubscribe: slow })
    const atom = conversationAtom(C1 as ConversationId)
    const unmountConn = registry.mount(connectionAtom)
    const unmount = registry.mount(atom)
    try {
      const first = await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true)
      const cursor = conversationValue(first)!.cursor!
      proxy.cut()
      await waitFor(registry, connectionAtom, (s: ConnectionState) => s.status === "offline" && s.nextRetryAt !== undefined)
      proxy.restore()
      const before = brain.subscribes.length
      const started = Date.now()
      registry.set(reconnectAtom, undefined)
      await waitFor(registry, connectionAtom, (s: ConnectionState) => s.status === "online", 2_000)
      await waitFor(registry, atom, (r) => conversationValue(r)?.synchronized === true, 2_000)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(brain.subscribes.slice(before).find((s) => s.rpc === "conversations.subscribe")).toMatchObject({ after: cursor, plan: "replay" })
    } finally {
      unmount()
      unmountConn()
      registry.dispose()
    }
  }, 15_000)
})

describe("roster replica", () => {
  test("snapshot, live change, resume after a cut", async () => {
    const registry = makeRegistry(proxy.url)
    const unmount = registry.mount(rosterAtom)
    try {
      const first = await waitFor(registry, rosterAtom, (r) => valueOf(r)?.synchronized === true)
      expect([...valueOf(first)!.bots.values()].map((b) => b.name)).toEqual(["Scout"])
      proxy.cut()
      await waitFor(registry, rosterAtom, (r) => valueOf(r)?.synchronized === false)
      brain.roster.apply({ type: "bot.upserted", bot: botFixture("bot_2", "Coder", "cnv_9") })
      const before = brain.subscribes.length
      proxy.restore()
      const resumed = await waitFor(registry, rosterAtom, (r) => valueOf(r)?.synchronized === true && valueOf(r)!.bots.size === 2)
      expect(brain.subscribes.slice(before).find((s) => s.rpc === "roster.subscribe")).toMatchObject({ plan: "replay" })
      expect(valueOf(resumed)!.cursor).toEqual(brain.roster.head)
    } finally {
      unmount()
      registry.dispose()
    }
  }, 15_000)
})

describe("command atoms", () => {
  test("settings.update calls the RPC, the roster carries the change, and the query refetches", async () => {
    const registry = makeRegistry(running.url)
    const unmountRoster = registry.mount(rosterAtom)
    const unmountQuery = registry.mount(settingsQueryAtom)
    try {
      await waitFor(registry, settingsQueryAtom, (r) => r._tag === "Success" && !r.waiting)
      const fetchesBefore = brain.calls.filter((c) => c.tag === "settings.get").length
      const exit = await runFn(registry, commands["settings.update"], { patch: { theme: "dark" } })
      expect(Exit.isSuccess(exit) && exit.value.theme).toBe("dark")
      expect(brain.calls.find((c) => c.tag === "settings.update")?.payload).toEqual({ patch: { theme: "dark" } })
      // live: settings ride on the roster
      await waitFor(registry, settingsAtom, (s) => s.theme === "dark")
      // invalidation: the settings query refetched
      await waitFor(registry, settingsQueryAtom, (r) => r._tag === "Success" && r.value.theme === "dark" && !r.waiting)
      expect(brain.calls.filter((c) => c.tag === "settings.get").length).toBeGreaterThan(fetchesBefore)
    } finally {
      unmountQuery()
      unmountRoster()
      registry.dispose()
    }
  })

  test("typed errors come back through the command atom", async () => {
    const registry = makeRegistry(running.url)
    try {
      const exit = await runFn(registry, commandAtom("bots.delete", "x"), { botId: "bot_1" as any })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("Internal")
      expect(brain.calls.some((c) => c.tag === "bots.delete")).toBe(true)
    } finally {
      registry.dispose()
    }
  })

  test("sendMessage: outbox item while in flight, settled by the stream entry, idempotent by nonce", async () => {
    const registry = makeRegistry(running.url)
    const conversationId = C1 as ConversationId
    const atom = conversationAtom(conversationId)
    const unmount = registry.mount(atom)
    const unmountOutbox = registry.mount(outboxAtom(conversationId))
    try {
      await waitFor(registry, atom, (r) => valueOf(r)?.synchronized === true)
      const exit = await runFn(registry, sendMessageAtom, { conversationId, text: "hello from the client", clientNonce: "nonce-1" })
      expect(Exit.isSuccess(exit) && exit.value.disposition).toBe("started")
      const state = await waitFor(registry, atom, (r) => texts(valueOf(r)!).includes("hello from the client"))
      const entry = transcriptOf(valueOf(state)!).find((e) => e.kind === "message" && e.text === "hello from the client")
      expect(entry && entry.kind === "message" && entry.clientNonce).toBe("nonce-1")
      await waitFor(registry, outboxAtom(conversationId), (items) => items.length === 0)

      // same nonce again → the brain reports a duplicate, nothing new in the transcript
      const again = await runFn(registry, sendMessageAtom, { conversationId, text: "hello from the client", clientNonce: "nonce-1" })
      expect(Exit.isSuccess(again) && again.value.disposition).toBe("duplicate")

      // a failed send stays in the outbox as failed (error tray), with a readable message
      brain.failNextSend = true
      const failed = await runFn(registry, sendMessageAtom, { conversationId, text: "will fail", clientNonce: "nonce-2" })
      expect(Exit.isFailure(failed)).toBe(true)
      const outbox = registry.get(outboxAtom(conversationId))
      expect(outbox).toHaveLength(1)
      expect(outbox[0]).toMatchObject({ clientNonce: "nonce-2", status: "failed", error: "boom" })
    } finally {
      unmountOutbox()
      unmount()
      registry.dispose()
    }
  })

  test("a reconnect never re-runs the last send or command (no duplicate message after coming back)", async () => {
    const registry = makeRegistry(running.url)
    const conversationId = C1 as ConversationId
    const atom = conversationAtom(conversationId)
    const unmount = registry.mount(atom)
    // Mounted like a component's useAtomSet keeps them mounted.
    const unmountSend = registry.mount(sendMessageAtom)
    const react = commandAtom("settings.update", "reconnect-test")
    const unmountReact = registry.mount(react)
    try {
      await waitFor(registry, atom, (r) => valueOf(r)?.synchronized === true)
      const sendsBefore = brain.calls.filter((c) => c.tag === "messages.send").length
      // The composer sends WITHOUT a nonce: it is minted per draft.
      const exit = await runFn(registry, sendMessageAtom, { conversationId, text: "only once please" })
      expect(Exit.isSuccess(exit)).toBe(true)
      const reactExit = await runFn(registry, react, { patch: { showSteps: false } })
      expect(Exit.isSuccess(reactExit)).toBe(true)
      const reactsBefore = brain.calls.filter((c) => c.tag === "settings.update").length

      // Coming back to the app: the protocol is rebuilt (runtime atom changes) → fn atoms recompute.
      registry.set(reconnectAtom, undefined)
      await waitFor(registry, connectionAtom, (c: ConnectionState) => c.status === "online")
      await Bun.sleep(300)
      registry.set(reconnectAtom, undefined)
      await waitFor(registry, connectionAtom, (c: ConnectionState) => c.status === "online")
      await Bun.sleep(300)

      expect(brain.calls.filter((c) => c.tag === "messages.send").length).toBe(sendsBefore + 1)
      expect(brain.calls.filter((c) => c.tag === "settings.update").length).toBe(reactsBefore)
      const state = await waitFor(registry, atom, (r) => texts(valueOf(r)!).includes("only once please"))
      expect(texts(valueOf(state)!).filter((t) => t === "only once please")).toHaveLength(1)
    } finally {
      unmountReact()
      unmountSend()
      unmount()
      registry.dispose()
    }
  })

  test("attachment upload sends base64 bytes and rejects oversized files locally", async () => {
    const registry = makeRegistry(running.url)
    try {
      const atom = uploadFilesAtom("composer-1")
      const file = new File([new Uint8Array([0, 1, 2, 250, 255])], "bytes.bin", { type: "application/octet-stream" })
      const text = new File(["hi there"], "note.txt", { type: "text/plain" })
      const exit = await runFn(registry, atom, [file, text])
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value.map((a) => a.name)).toEqual(["bytes.bin", "note.txt"])
      expect([...brain.uploads.at(-2)!.bytes]).toEqual([0, 1, 2, 250, 255])
      expect(new TextDecoder().decode(brain.uploads.at(-1)!.bytes)).toBe("hi there")

      const uploadsBefore = brain.uploads.length
      const huge = { name: "huge.bin", type: "", size: 11 * 1024 * 1024, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }
      const tooBig = await runFn(registry, atom, [huge])
      expect(Exit.isFailure(tooBig) && JSON.stringify(tooBig)).toContain("InvalidInput")
      expect(brain.uploads.length).toBe(uploadsBefore)
    } finally {
      registry.dispose()
    }
  })
})

