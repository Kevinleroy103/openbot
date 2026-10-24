import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { McpTokenRepo } from "@openbot/core"
import {
  conversationId,
  localNodeSummary,
  makeTurn,
  OrchestratorFake,
  remoteNodeSummary,
  turnId,
} from "@openbot/core/testing"
import { DesktopUnavailable, type ExecEvent, LeaseHeld } from "@openbot/node-protocol"
import type { TaskId } from "@openbot/contracts"
import { Effect, Option, Stream } from "effect"
import { hashMcpToken } from "../src/McpBindingIssuer.ts"
import { DefaultToolkits, McpGateway } from "../src/McpGateway.ts"
import { params } from "../src/params.ts"
import { defineTool } from "../src/tool.ts"
import {
  BOT_A,
  botA,
  BOT_B,
  type Harness,
  orchestratorCalls,
  REMOTE,
  setNodeClient,
  startHarness,
  textOf,
  toolRequests,
  upsertNode,
} from "./harness.ts"

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
})

const rawPost = (url: string, headers: Record<string, string>, body = initializeBody) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  })

/** Every result must be content-only (R1). */
const assertConformant = (result: unknown) => {
  const r = result as Record<string, unknown>
  expect(r.structuredContent).toBeUndefined()
  for (const item of (r.content as Array<{ type: string }>) ?? []) expect(["text", "image"]).toContain(item.type)
  if (r.isError === true) expect(textOf(result).startsWith("ERROR:")).toBe(true)
}

const execEvents = (
  output: ReadonlyArray<string>,
  exit?: Partial<Extract<ExecEvent, { _tag: "Exit" }>>,
): ReadonlyArray<ExecEvent> => [
  { _tag: "Started", pid: 42, pgid: 42 },
  ...output.map((data, seq): ExecEvent => ({ _tag: "Output", stream: "stdout", data, seq })),
  { _tag: "Exit", code: 0, signal: null, timedOut: false, durationMs: 1234, ...exit },
]

let h: Harness
afterEach(async () => {
  await h?.close()
})

describe("auth", () => {
  beforeEach(async () => {
    h = await startHarness()
  })

  test("no token → 401 without an OAuth pointer", async () => {
    const res = await rawPost(`${h.baseUrl}/mcp/${BOT_A}`, {})
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
  })

  test("unknown token → 401 invalid_token", async () => {
    const res = await rawPost(`${h.baseUrl}/mcp/${BOT_A}`, { authorization: "Bearer not-a-real-token" })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("invalid_token")
  })

  test("token of bot A on bot B's path → 403", async () => {
    const { binding } = await h.issue({})
    const res = await rawPost(`${h.baseUrl}/mcp/${BOT_B}`, { ...binding.headers })
    expect(res.status).toBe(403)
  })

  test("GET → 405; unknown session → 404; foreign session → 403", async () => {
    const { binding } = await h.issue({})
    const get = await fetch(binding.url, { headers: { ...binding.headers, accept: "text/event-stream" } })
    expect(get.status).toBe(405)

    const unknown = await rawPost(binding.url, { ...binding.headers, "mcp-session-id": "nope" })
    expect(unknown.status).toBe(404)

    const init = await rawPost(binding.url, { ...binding.headers })
    expect(init.status).toBe(200)
    const sessionId = init.headers.get("mcp-session-id")
    expect(sessionId).toBeTruthy()
    await init.text()

    const other = await h.issue({})
    const foreign = await rawPost(binding.url, { ...other.binding.headers, "mcp-session-id": sessionId! })
    expect(foreign.status).toBe(403)
  })

  test("revoked token → 401 on the live session and on reconnect; its session is closed", async () => {
    const { binding, revoke } = await h.issue({})
    const client = await h.connect(binding)
    const ok = await client.callTool({ name: "list_bots", arguments: {} })
    expect(textOf(ok)).toContain("@Alpha")
    expect(await h.run(Effect.flatMap(McpGateway, (g) => g.sessionCount))).toBe(1)

    await revoke()
    await expect(client.callTool({ name: "list_bots", arguments: {} })).rejects.toThrow()
    expect(await h.run(Effect.flatMap(McpGateway, (g) => g.sessionCount))).toBe(0)
    const res = await rawPost(binding.url, { ...binding.headers })
    expect(res.status).toBe(401)
  })
})

describe("issuer", () => {
  beforeEach(async () => {
    h = await startHarness()
  })

  test("stores only the sha256 of the token, builds the internal URL, revokes on scope close", async () => {
    const { binding, revoke } = await h.issue({ toolsets: ["bot", "node"] })
    expect(binding.name).toBe("openbot")
    expect(binding.url).toBe(`${h.baseUrl}/mcp/${BOT_A}`)
    const token = binding.headers.Authorization!.replace(/^Bearer /, "")
    expect(token.length).toBeGreaterThanOrEqual(40)
    const repo = await h.run(McpTokenRepo)
    expect(Option.isNone(await h.run(repo.lookup(token)))).toBe(true)
    const record = await h.run(repo.lookup(await h.run(hashMcpToken(token))))
    expect(Option.isSome(record)).toBe(true)
    const value = Option.getOrThrow(record)
    expect(value.revoked).toBe(false)
    expect(value.claims.botId).toBe(BOT_A)
    expect(value.claims.toolsets).toEqual(["bot", "node"])

    await revoke()
    const after = Option.getOrThrow(await h.run(repo.lookup(await h.run(hashMcpToken(token)))))
    expect(after.revoked).toBe(true)
  })
})

describe("tools", () => {
  beforeEach(async () => {
    h = await startHarness()
  })

  test("tool list is gated by the token's toolsets and schemas are tuple-free", async () => {
    const botOnly = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const names1 = (await botOnly.listTools()).tools.map((t) => t.name)
    expect(names1).toContain("message_bot")
    expect(names1).toContain("list_nodes")
    expect(names1).not.toContain("shell")
    expect(names1).not.toContain("browser")

    const withNode = await h.connect((await h.issue({ toolsets: ["bot", "node"] })).binding)
    const names2 = (await withNode.listTools()).tools.map((t) => t.name)
    expect(names2).toEqual(
      expect.arrayContaining(["shell", "read_file", "write_file", "edit_file", "list_dir", "glob", "grep"]),
    )
    expect(names2).not.toContain("browser")

    const all = await h.connect((await h.issue({ toolsets: ["bot", "node", "browser"] })).binding)
    const tools = (await all.listTools()).tools
    expect(tools.map((t) => t.name)).toContain("browser")
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object")
      expect(JSON.stringify(tool.inputSchema)).not.toContain("prefixItems")
      expect(tool.description!.length).toBeLessThanOrEqual(4000)
    }

    // a tool outside the session's toolsets is refused at call time too
    const refused = await botOnly.callTool({ name: "shell", arguments: { command: "ls" } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toStartWith("ERROR: Unknown tool")
    assertConformant(refused)
  })

  test("message_bot calls Messaging with the token's claims; results carry no structuredContent", async () => {
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const result = await client.callTool({
      name: "message_bot",
      arguments: { to: "@Beta", text: "hello", urgency: "urgent" },
      _meta: { "claudecode/toolUseId": "toolu_1" },
    })
    assertConformant(result)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("@Beta")
    expect(h.messagingCalls).toHaveLength(1)
    const call = h.messagingCalls[0]!
    expect(call.method).toBe("messageBot")
    expect(call.claims.botId).toBe(BOT_A)
    expect(call.callId).toBe("toolu_1")
    expect(call.input).toEqual({ to: "@Beta", text: "hello", urgency: "urgent" })

    // same harness call id → replayed from the idempotency cache, not delivered twice
    const again = await client.callTool({
      name: "message_bot",
      arguments: { to: "@Beta", text: "hello", urgency: "urgent" },
      _meta: { "claudecode/toolUseId": "toolu_1" },
    })
    expect(textOf(again)).toBe(textOf(result))
    expect(h.messagingCalls).toHaveLength(1)

    // default urgency
    await client.callTool({ name: "message_bot", arguments: { to: "Beta", text: "later" } })
    expect(h.messagingCalls[1]!.input).toEqual({ to: "Beta", text: "later", urgency: "background" })
  })

  test("one session per bot: each call resolves the conversation of the bot's CURRENT turn, else the token's home (DM)", async () => {
    const issued = await h.issue({ toolsets: ["bot"] })
    const home = (
      await h.run(
        Effect.flatMap(McpTokenRepo, (repo) =>
          Effect.flatMap(hashMcpToken(issued.binding.headers.Authorization!.replace(/^Bearer /, "")), repo.lookup),
        ),
      )
    ).pipe(Option.getOrThrow).claims
    const client = await h.connect(issued.binding)
    const group = conversationId("cnv_group")
    await h.run(
      Effect.flatMap(OrchestratorFake, (fake) =>
        fake.setActiveTurn(
          BOT_A,
          makeTurn({ id: turnId("trn_g"), botId: BOT_A, conversationId: group, status: "running" }),
        ),
      ),
    )
    await client.callTool({ name: "message_bot", arguments: { to: "Beta", text: "from the group" } })
    await h.run(Effect.flatMap(OrchestratorFake, (fake) => fake.setActiveTurn(BOT_A, undefined)))
    await client.callTool({ name: "message_bot", arguments: { to: "Beta", text: "between turns" } })
    const [inGroup, idle] = h.messagingCalls
    expect(inGroup!.claims.conversationId).toBe(group)
    expect(inGroup!.claims.sessionKey).toBe(`${BOT_A}:${group}`)
    expect(idle!.claims.conversationId).toBe(home.conversationId)
    expect(idle!.claims.sessionKey).toBe(home.sessionKey)
  })

  test("react: one emoji on the message being answered (or a given one)", async () => {
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const result = await client.callTool({ name: "react", arguments: { emoji: "👍" } })
    assertConformant(result)
    expect(textOf(result)).toBe("Reacted 👍 to message ent_trigger.")
    await client.callTool({ name: "react", arguments: { emoji: "✅", message_id: "ent_42" } })
    const calls = h.messagingCalls.filter((c) => c.method === "react")
    expect(calls.map((c) => c.input)).toEqual([
      { emoji: "👍", messageId: undefined },
      { emoji: "✅", messageId: "ent_42" },
    ])
  })

  test("create_bot creates a teammate with the caller's harness and host node by default; update_bot patches", async () => {
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const created = await client.callTool({
      name: "create_bot",
      arguments: { name: "Research Scout", label: "Research", instructions: "Find competitor launches." },
      _meta: { "claudecode/toolUseId": "toolu_cb" },
    })
    assertConformant(created)
    expect(created.isError).toBeFalsy()
    expect(textOf(created)).toContain("@Research Scout")
    const call = h.messagingCalls.find((c) => c.method === "createBot")!
    const input = call.input as {
      name: string
      label: string
      instructions: string
      harness: { kind: string }
      hostNodeId: string
      clientNonce: string
    }
    expect(input.name).toBe("Research Scout")
    expect(input.label).toBe("Research")
    expect(input.instructions).toBe("Find competitor launches.")
    expect(input.harness.kind).toBe(botA.harness.kind)
    expect(input.hostNodeId).toBe(botA.hostNodeId)
    expect(input.clientNonce).toContain("toolu_cb")
    // the owner's default for new bots (BotService), never more than the creator (an "ask" bot here)
    expect((input as { autonomy?: string }).autonomy).toBeUndefined()
    expect((input as { autonomyCeiling?: string }).autonomyCeiling).toBe(botA.autonomy)

    const updated = await client.callTool({ name: "update_bot", arguments: { bot: "@Beta", instructions: "New job." } })
    expect(updated.isError).toBeFalsy()
    const upd = h.messagingCalls.find((c) => c.method === "updateBot")!.input as {
      id: string
      patch: { instructions: string }
    }
    expect(upd).toEqual({ id: BOT_B, patch: { instructions: "New job." } })

    // bots cannot change autonomy: the tool has no such parameter and never patches it
    await client.callTool({ name: "update_bot", arguments: { bot: "@Beta", name: "Beta", autonomy: "full" } })
    const escalation = h.messagingCalls.filter((c) => c.method === "updateBot").at(-1)!.input as {
      patch: Record<string, unknown>
    }
    expect(escalation.patch.autonomy).toBeUndefined()
    const tools = await client.listTools()
    for (const name of ["create_bot", "update_bot"]) {
      expect(Object.keys(tools.tools.find((t) => t.name === name)!.inputSchema.properties ?? {})).not.toContain(
        "autonomy",
      )
      // nor project folders (owner-only)
      expect(Object.keys(tools.tools.find((t) => t.name === name)!.inputSchema.properties ?? {})).not.toContain(
        "projectFolders",
      )
      expect(Object.keys(tools.tools.find((t) => t.name === name)!.inputSchema.properties ?? {})).not.toContain(
        "project_folders",
      )
    }
    await client.callTool({
      name: "update_bot",
      arguments: { bot: "@Beta", name: "Beta", projectFolders: ["/"], project_folders: ["/"] },
    })
    const folders = h.messagingCalls.filter((c) => c.method === "updateBot").at(-1)!.input as {
      patch: Record<string, unknown>
    }
    expect(folders.patch.projectFolders).toBeUndefined()

    const nothing = await client.callTool({ name: "update_bot", arguments: { bot: "@Beta" } })
    expect(nothing.isError).toBe(true)
    expect(textOf(nothing)).toStartWith("ERROR:")
  })

  test("section tools: move_bot_to_section creates the section, rename/list/delete work", async () => {
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const moved = await client.callTool({
      name: "move_bot_to_section",
      arguments: { bot: "@Beta", section: "Engineering" },
    })
    expect(moved.isError).toBeFalsy()
    expect(h.messagingCalls.find((c) => c.method === "createSection")!.input).toEqual({ name: "Engineering" })
    const upd = h.messagingCalls.find((c) => c.method === "updateBot")!.input as {
      id: string
      patch: { sectionId: string; pinned: boolean }
    }
    expect(upd).toEqual({ id: BOT_B, patch: { sectionId: "sec_1", pinned: false } })

    const again = await client.callTool({ name: "create_section", arguments: { name: "engineering" } })
    expect(textOf(again)).toContain("already exists")

    expect(
      (await client.callTool({ name: "rename_section", arguments: { section: "Engineering", name: "Eng" } })).isError,
    ).toBeFalsy()
    expect(textOf(await client.callTool({ name: "list_sections", arguments: {} }))).toContain("Eng (sec_1)")

    const missing = await client.callTool({ name: "rename_section", arguments: { section: "Nope", name: "X" } })
    expect(missing.isError).toBe(true)
    expect((await client.callTool({ name: "delete_section", arguments: { section: "Eng" } })).isError).toBeFalsy()

    const none = await client.callTool({ name: "move_bot_to_section", arguments: { bot: "@Beta", section: "none" } })
    expect(textOf(none)).toContain("unassigned")
  })

  test("invalid arguments → ERROR text listing what is wrong", async () => {
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const missing = await client.callTool({ name: "message_bot", arguments: { to: "Beta" } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain("`text` is required")
    const badEnum = await client.callTool({ name: "message_bot", arguments: { to: "Beta", text: "x", urgency: "now" } })
    expect(textOf(badEnum)).toContain("background, urgent")
    assertConformant(missing)
    assertConformant(badEnum)
    expect(h.messagingCalls).toHaveLength(0)
  })

  test("ask_user returns pending immediately (D3.3)", async () => {
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const result = await client.callTool({
      name: "ask_user",
      arguments: { questions: [{ prompt: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] }] },
    })
    assertConformant(result)
    expect(textOf(result)).toContain("status: pending")
    const requests = await toolRequests(h)
    expect(requests).toHaveLength(1)
    expect(textOf(result)).toContain(requests[0]!.requestId)
    expect(requests[0]!.ctx.claims.botId).toBe(BOT_A)
  })

  test("list_nodes shows only the host and bound nodes", async () => {
    await upsertNode(h, remoteNodeSummary("nod_other", { label: "Other" }))
    const client = await h.connect((await h.issue({ toolsets: ["bot"], boundNodeIds: [REMOTE] })).binding)
    const text = textOf(await client.callTool({ name: "list_nodes", arguments: {} }))
    expect(text).toContain(LOCAL_NODE_ID)
    expect(text).toContain(REMOTE)
    expect(text).not.toContain("nod_other")
  })
})

describe("node tools", () => {
  test("shell streams through NodeDirectory with progress, invocation and approval", async () => {
    h = await startHarness()
    const calls: Array<{ readonly method: string; readonly payload: any }> = []
    await setNodeClient(h, LOCAL_NODE_ID, {
      "shell.exec": (payload: unknown) => {
        calls.push({ method: "shell.exec", payload })
        return Stream.fromIterable(execEvents(["hello\n", "world\n"])).pipe(
          Stream.mapEffect((event) => Effect.as(Effect.sleep("80 millis"), event)),
        )
      },
    })
    const client = await h.connect((await h.issue({ toolsets: ["bot", "node"] })).binding)
    const progress: Array<unknown> = []
    const result = await client.callTool(
      {
        name: "shell",
        arguments: { command: "echo hello; echo world", cwd: "sub" },
        _meta: { "claudecode/toolUseId": "toolu_sh" },
      },
      undefined,
      { onprogress: (p) => progress.push(p) },
    )
    assertConformant(result)
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain("hello\nworld")
    expect(text).toContain("exit code 0")
    expect(progress.length).toBeGreaterThanOrEqual(2)

    expect(calls).toHaveLength(1)
    const payload = calls[0]!.payload
    expect(payload.command).toBe("echo hello; echo world")
    expect(payload.cwd).toBe(`/openbot-test/bots/${BOT_A}/workspace/sub`)
    expect(payload.inv.botId).toBe(BOT_A)
    expect(payload.inv.runId).toBe(`${BOT_A}:cnv_${BOT_A}`)
    expect(payload.inv.toolCallId).toBe("toolu_sh")
    expect(payload.inv.invocationId).toStartWith("inv_")
    expect(await orchestratorCalls(h)).toContain(`approveToolCall:${BOT_A}:shell`)
  })

  test("a denied approval never reaches the node", async () => {
    h = await startHarness({ toolApproval: { decision: "deny", message: "not now" } })
    let executed = false
    await setNodeClient(h, LOCAL_NODE_ID, {
      "shell.exec": () => {
        executed = true
        return Stream.fromIterable(execEvents([]))
      },
    })
    const client = await h.connect((await h.issue({ toolsets: ["node"] })).binding)
    const result = await client.callTool({ name: "shell", arguments: { command: "rm -rf /" } })
    assertConformant(result)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("not now")
    expect(executed).toBe(false)
  })

  test("offline node, unbound node and missing capability are ERROR results", async () => {
    h = await startHarness()
    const client = await h.connect((await h.issue({ toolsets: ["node"], boundNodeIds: [REMOTE] })).binding)

    const unbound = await client.callTool({ name: "list_dir", arguments: { node: "nod_elsewhere" } })
    expect(textOf(unbound)).toStartWith("ERROR: You cannot use node")

    await upsertNode(h, remoteNodeSummary(REMOTE, { label: "Laptop", status: "offline" }))
    const offline = await client.callTool({ name: "list_dir", arguments: { node: "Laptop" } })
    expect(offline.isError).toBe(true)
    expect(textOf(offline)).toBe("ERROR: Node Laptop is offline")

    await upsertNode(h, localNodeSummary({ capabilities: ["fs@1"] }))
    const noShell = await client.callTool({ name: "shell", arguments: { command: "ls" } })
    expect(textOf(noShell)).toContain("does not offer shell")
    for (const r of [unbound, offline, noShell]) assertConformant(r)
  })

  test("long output is spilled to the node and the result stays under 10 KB", async () => {
    h = await startHarness()
    const writes: Array<{ path: string; content: string }> = []
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")
    await setNodeClient(h, LOCAL_NODE_ID, {
      "shell.exec": () => Stream.fromIterable(execEvents([big])),
      "fs.write": (payload: { path: string; content: string }) =>
        Effect.sync(() => {
          writes.push(payload)
          return { sha256: "abc", size: payload.content.length }
        }),
    })
    const client = await h.connect((await h.issue({ toolsets: ["node"] })).binding)
    const result = await client.callTool({ name: "shell", arguments: { command: "seq" } })
    assertConformant(result)
    const text = textOf(result)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(10_000)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toMatch(new RegExp(`/openbot-test/bots/${BOT_A}/workspace/\\.openbot/out/inv_.*\\.log$`))
    expect(writes[0]!.content).toBe(big)
    expect(text).toContain(writes[0]!.path)
    expect(text).toContain("line 0 ")
    expect(text).toContain("line 1999 ")
  })

  test("node-protocol errors are rendered with describeNodeError", async () => {
    h = await startHarness()
    const { PathDenied } = await import("@openbot/node-protocol")
    await setNodeClient(h, LOCAL_NODE_ID, {
      "fs.read": () => Effect.fail(new PathDenied({ path: "/etc/shadow", reason: "outside the node's roots" })),
    })
    const client = await h.connect((await h.issue({ toolsets: ["node"] })).binding)
    const result = await client.callTool({ name: "read_file", arguments: { path: "/etc/shadow" } })
    assertConformant(result)
    expect(textOf(result)).toBe("ERROR: Access to /etc/shadow is denied: outside the node's roots")
  })

  test("browser screenshot returns caption + image content", async () => {
    h = await startHarness()
    await setNodeClient(h, LOCAL_NODE_ID, {
      "browser.action": (payload: { action: { _tag: string } }) =>
        Effect.succeed({
          text: `did ${payload.action._tag}`,
          url: "https://example.com/",
          title: "Example",
          image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 1, height: 1 },
        }),
    })
    const client = await h.connect((await h.issue({ toolsets: ["browser"] })).binding)
    const result = await client.callTool({ name: "browser", arguments: { action: "screenshot" } })
    assertConformant(result)
    const content = result.content as Array<{ type: string; data?: string }>
    expect(content.map((c) => c.type)).toEqual(["text", "image"])
    expect(content[1]!.data).toBe("iVBORw0KGgo=")
    expect(textOf(result)).toContain("did screenshot")

    const bad = await client.callTool({ name: "browser", arguments: { action: "navigate" } })
    expect(textOf(bad)).toBe("ERROR: `url` is required for action navigate")
  })
})

describe("screen tools (D1.7)", () => {
  const desktopNode = localNodeSummary({
    capabilities: ["fs@1", "shell@1", "pty@1", "browser@1", "desktop@1"],
    declaredCapabilities: ["fs@1", "shell@1", "pty@1", "browser@1", "desktop@1"],
  })

  test("computer is offered with the computer toolset; request_takeover with a screen, never to a task", async () => {
    h = await startHarness({ nodes: [desktopNode] })
    const names = async (claims: Parameters<Harness["issue"]>[0]) =>
      (await (await h.connect((await h.issue(claims)).binding)).listTools()).tools.map((t) => t.name)
    const botOnly = await names({ toolsets: ["bot"] })
    expect(botOnly).not.toContain("computer")
    expect(botOnly).not.toContain("request_takeover")
    const browserOnly = await names({ toolsets: ["bot", "browser"] })
    expect(browserOnly).toContain("request_takeover")
    expect(browserOnly).not.toContain("computer")
    expect(await names({ toolsets: ["bot", "browser", "computer"] })).toEqual(
      expect.arrayContaining(["browser", "computer", "request_takeover"]),
    )
    const task = await names({ toolsets: ["bot", "computer"], taskId: "tsk_1" as TaskId })
    expect(task).toContain("computer")
    expect(task).not.toContain("request_takeover")

    const client = await h.connect((await h.issue({ toolsets: ["computer"] })).binding)
    const tool = (await client.listTools()).tools.find((t) => t.name === "computer")!
    const props = tool.inputSchema.properties as Record<
      string,
      { type: string; items?: unknown; enum?: ReadonlyArray<string> }
    >
    expect(props.coordinate).toMatchObject({ type: "array", items: { type: "number" }, minItems: 2 })
    expect(props.region).toMatchObject({ type: "array", items: { type: "number" }, minItems: 4 })
    expect(props.action!.enum).toContain("left_click_drag")
    expect(tool.description).toContain("1280")
  })

  test("computer maps the arguments to computer.act and returns text + image", async () => {
    h = await startHarness({ nodes: [desktopNode] })
    const acts: Array<{ readonly inv: { readonly botId: string }; readonly action: Record<string, unknown> }> = []
    await setNodeClient(h, LOCAL_NODE_ID, {
      "computer.act": (payload: (typeof acts)[number]) => {
        acts.push(payload)
        return Effect.succeed(
          payload.action.action === "screenshot"
            ? {
                text: "Screenshot 1280x800 (display 1920x1200).",
                image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 1280, height: 800 },
              }
            : payload.action.action === "zoom"
              ? { text: "ERROR: region [x0, y0, x1, y1] is outside the screen" }
              : { text: "" },
        )
      },
    })
    const client = await h.connect((await h.issue({ toolsets: ["computer"] })).binding)
    const shot = await client.callTool({ name: "computer", arguments: { action: "screenshot" } })
    assertConformant(shot)
    const content = shot.content as Array<{ type: string; data?: string; mimeType?: string }>
    expect(content.map((c) => c.type)).toEqual(["text", "image"])
    expect(content[1]).toMatchObject({ data: "iVBORw0KGgo=", mimeType: "image/png" })
    expect(textOf(shot)).toContain("1280x800")

    const click = await client.callTool({
      name: "computer",
      arguments: { action: "double_click", coordinate: [640, 400] },
    })
    assertConformant(click)
    expect(textOf(click)).toBe("Done: double_click.")
    expect(acts.map((a) => a.action)).toEqual([
      { action: "screenshot" },
      { action: "double_click", coordinate: [640, 400] },
    ])
    expect(acts[0]!.inv.botId).toBe(BOT_A)

    // no tuples on the wire, but the gateway checks the length
    const bad = await client.callTool({ name: "computer", arguments: { action: "left_click", coordinate: [1, 2, 3] } })
    expect(textOf(bad)).toContain("`coordinate` must have at most 2 items")
    const missing = await client.callTool({ name: "computer", arguments: { action: "type" } })
    expect(textOf(missing)).toBe("ERROR: `text` is required for action type")
    expect(acts).toHaveLength(2)

    // the node answers bad arguments as text: an error for the bot
    const zoom = await client.callTool({ name: "computer", arguments: { action: "zoom", region: [0, 0, 5000, 5000] } })
    expect(zoom.isError).toBe(true)
    expect(textOf(zoom)).toBe("ERROR: region [x0, y0, x1, y1] is outside the screen")
  })

  test("computer explains the owner's control and a missing desktop; no desktop@1 → refused", async () => {
    h = await startHarness({ nodes: [desktopNode] })
    let failure: unknown = new LeaseHeld({ botId: BOT_A, holder: "user", reason: "the user took control" })
    await setNodeClient(h, LOCAL_NODE_ID, { "computer.act": () => Effect.fail(failure) })
    const client = await h.connect((await h.issue({ toolsets: ["computer"] })).binding)
    const held = await client.callTool({ name: "computer", arguments: { action: "screenshot" } })
    assertConformant(held)
    expect(held.isError).toBe(true)
    expect(textOf(held)).toBe("ERROR: The owner is using your screen right now. Wait until they hand it back.")

    failure = new DesktopUnavailable({ message: "This computer cannot show desktops", missing: ["Xvfb", "xdotool"] })
    const none = await client.callTool({ name: "computer", arguments: { action: "screenshot" } })
    expect(textOf(none)).toBe("ERROR: This computer cannot show desktops. This computer lacks: Xvfb, xdotool.")

    await upsertNode(h, localNodeSummary())
    const refused = await client.callTool({ name: "computer", arguments: { action: "screenshot" } })
    expect(textOf(refused)).toContain("does not offer desktop or screen")
  })

  test("a Mac's own screen (screen@1): the computer works there and its refusals keep the node's words", async () => {
    const mac = {
      ...desktopNode,
      capabilities: ["fs@1", "browser@1", "screen@1"],
      declaredCapabilities: ["fs@1", "browser@1", "screen@1"],
    }
    h = await startHarness({ nodes: [mac] })
    let failure: unknown = undefined
    await setNodeClient(h, LOCAL_NODE_ID, {
      "computer.act": () =>
        failure === undefined ? Effect.succeed({ text: "Screenshot of the screen (1280x800)." }) : Effect.fail(failure),
    })
    const client = await h.connect((await h.issue({ toolsets: ["computer"] })).binding)
    expect(textOf(await client.callTool({ name: "computer", arguments: { action: "screenshot" } }))).toBe(
      "Screenshot of the screen (1280x800).",
    )
    failure = new LeaseHeld({
      botId: BOT_A,
      holder: "user",
      reason: "The owner is using this computer right now. Try again in a few minutes, or ask them in the chat.",
    })
    expect(textOf(await client.callTool({ name: "computer", arguments: { action: "screenshot" } }))).toBe(
      "ERROR: The owner is using this computer right now. Try again in a few minutes, or ask them in the chat.",
    )
    failure = new DesktopUnavailable({
      message:
        "Allow Screen Recording and Accessibility for openbot-node on the Mac (System Settings › Privacy & Security), then try again.",
      missing: ["Screen Recording", "Accessibility"],
    })
    expect(textOf(await client.callTool({ name: "computer", arguments: { action: "screenshot" } }))).toBe(
      "ERROR: Allow Screen Recording and Accessibility for openbot-node on the Mac (System Settings › Privacy & Security), then try again.",
    )
  })

  test("request_takeover posts a hand-off and returns pending at once", async () => {
    h = await startHarness({ nodes: [desktopNode] })
    const client = await h.connect((await h.issue({ toolsets: ["bot", "computer"] })).binding)
    const result = await client.callTool({
      name: "request_takeover",
      arguments: { instruction: "Sign in to GitHub and approve the 2FA prompt" },
    })
    assertConformant(result)
    expect(result.isError).toBeFalsy()
    const requests = await toolRequests(h)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      tool: "request_takeover",
      input: { instruction: "Sign in to GitHub and approve the 2FA prompt" },
    })
    expect(textOf(result)).toContain("status: pending")
    expect(textOf(result)).toContain(requests[0]!.requestId)
    const empty = await client.callTool({ name: "request_takeover", arguments: { instruction: "" } })
    expect(textOf(empty)).toContain("`instruction` must not be empty")
  })
})

test("a tool error the gateway does not know is logged, and the model reads Internal error", async () => {
  const odd = defineTool({
    name: "odd",
    toolset: "bot",
    description: "Fails with an error no one maps.",
    params: params({}),
    handler: () => Effect.fail({ _tag: "Mystery" }),
  })
  const logged = spyOn(console, "log")
  try {
    h = await startHarness({ tools: [...DefaultToolkits, odd] })
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    expect(textOf(await client.callTool({ name: "odd", arguments: {} }))).toBe("ERROR: Internal error")
    expect(logged.mock.calls.flat().join(" ")).toContain("McpGateway: tool odd failed with an unrecognised error")
  } finally {
    logged.mockRestore()
  }
})
