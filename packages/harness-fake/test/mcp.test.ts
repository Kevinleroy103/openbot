// `tool:` directives call a REAL MCP server (SDK Streamable HTTP on Bun.serve, ephemeral port)
// with the binding's headers, exactly like the gateway would be called.
import { afterAll, beforeAll, describe as group, expect, test } from "bun:test"
import type { McpBinding } from "@openbot/core"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Duration, Effect } from "effect"
import { makeFakeDriver } from "../src/index.ts"
import { collect, finalMessages, openInput, run, toolCalls, turn } from "./helpers.ts"

const TOKEN = "test-token-1"
const seen: Array<{ method: string; authorization: string | null; extra: string | null; path: string }> = []
const calls: Array<{ name: string; args: unknown; authorization: string | null }> = []

const buildServer = (authorization: string | null) => {
  const server = new Server({ name: "openbot-test", version: "0.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      { name: "list_bots", description: "List bots", inputSchema: { type: "object" as const, properties: {} } },
      {
        name: "message_bot",
        description: "Message a bot",
        inputSchema: { type: "object" as const, properties: { to: { type: "string" }, text: { type: "string" } } },
      },
      { name: "boom", description: "Always fails", inputSchema: { type: "object" as const, properties: {} } },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push({ name: request.params.name, args: request.params.arguments, authorization })
    switch (request.params.name) {
      case "list_bots":
        return { content: [{ type: "text" as const, text: "Scout (fake), Echo (claude)" }] }
      case "message_bot": {
        const args = request.params.arguments as { to: string; text: string }
        return { content: [{ type: "text" as const, text: `Delivered to ${args.to}: ${args.text}` }] }
      }
      case "boom":
        return { content: [{ type: "text" as const, text: "ERROR: the boom tool always fails" }], isError: true }
      default:
        return { content: [{ type: "text" as const, text: `ERROR: unknown tool ${request.params.name}` }], isError: true }
    }
  })
  return server
}

let httpServer: ReturnType<typeof Bun.serve>
let binding: McpBinding

beforeAll(() => {
  httpServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url)
      const authorization = req.headers.get("authorization")
      seen.push({ method: req.method, authorization, extra: req.headers.get("x-openbot-session"), path: url.pathname })
      if (authorization !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 })
      if (url.pathname !== "/mcp/bot_scout") return new Response("forbidden", { status: 403 })
      if (req.method === "GET") return new Response(null, { status: 405 })
      // Stateless JSON mode: a fresh server + transport per request.
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await buildServer(authorization).connect(transport)
      return transport.handleRequest(req)
    },
  })
  binding = {
    name: "openbot",
    url: `http://127.0.0.1:${httpServer.port}/mcp/bot_scout`,
    headers: { Authorization: `Bearer ${TOKEN}`, "X-OpenBot-Session": "bot_scout:cnv_scout" },
  }
})

afterAll(() => {
  httpServer.stop(true)
})

const driver = () => makeFakeDriver({ chunkDelay: 0, toolTimeout: Duration.seconds(10) })

group("tool: directive", () => {
  test("calls the tool through MCP with the binding headers", () =>
    run(Effect.gen(function*() {
      const session = yield* driver().openSession(openInput({ mcp: [binding] }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", `tool: list_bots\ntool:message_bot {"to":"Echo","text":"hi there"}`))
      const events = yield* c.turnEvents("trn_1")
      expect(events.at(-1)?._tag).toBe("TurnCompleted")

      expect(calls.map((call) => call.name)).toEqual(["list_bots", "message_bot"])
      expect(calls[1]?.args).toEqual({ to: "Echo", text: "hi there" })
      expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((r) => r.authorization === `Bearer ${TOKEN}` && r.extra === "bot_scout:cnv_scout")).toBe(true)

      const tools = toolCalls(events)
      expect(tools.map((t) => `${t.item.toolName}:${t.item.status}`)).toEqual([
        "mcp__openbot__list_bots:running",
        "mcp__openbot__list_bots:completed",
        "mcp__openbot__message_bot:running",
        "mcp__openbot__message_bot:completed",
      ])
      expect(tools[1]?.item).toMatchObject({
        kind: "mcp",
        mcp: { server: "openbot", tool: "list_bots" },
        outputPreview: "Scout (fake), Echo (claude)",
      })
      expect(tools[3]?.item.outputPreview).toBe("Delivered to Echo: hi there")
      const messages = finalMessages(events)
      expect(messages[0]).toContain("Scout (fake), Echo (claude)")
      expect(messages[1]).toContain("Delivered to Echo")
      const activities = events.flatMap((e) => (e._tag === "Activity" ? [e] : []))
      expect(activities.some((a) => a.label === "Thinking…" && a.toolKind === "mcp")).toBe(true)
      expect(activities.some((a) => a.label === "Sending a message")).toBe(true)
      expect(activities.some((a) => /_|list bots|message bot/i.test(a.label))).toBe(false)
    })))

  test("tool errors (isError) mark the tool call failed", () =>
    run(Effect.gen(function*() {
      const session = yield* driver().openSession(openInput({ mcp: [binding] }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "tool: boom {}"))
      const events = yield* c.turnEvents("trn_1")
      const tools = toolCalls(events)
      expect(tools.at(-1)?.item).toMatchObject({ status: "failed", error: "ERROR: the boom tool always fails" })
      expect(events.at(-1)?._tag).toBe("TurnCompleted")
    })))

  test("transport errors, a missing binding and invalid JSON fail the tool call, not the turn", () =>
    run(Effect.gen(function*() {
      const badToken: McpBinding = { ...binding, headers: { Authorization: "Bearer wrong" } }
      const bad = yield* driver().openSession(openInput({ mcp: [badToken] }))
      const c1 = yield* collect(bad)
      yield* bad.startTurn(turn("trn_1", "tool: list_bots"))
      const e1 = yield* c1.turnEvents("trn_1")
      expect(toolCalls(e1).at(-1)?.item.status).toBe("failed")
      expect(toolCalls(e1).at(-1)?.item.error).toStartWith("ERROR:")
      expect(e1.at(-1)?._tag).toBe("TurnCompleted")

      const none = yield* driver().openSession(openInput({ mcp: [] }))
      const c2 = yield* collect(none)
      yield* none.startTurn(turn("trn_2", "tool: list_bots\ntool: shell {oops"))
      const e2 = yield* c2.turnEvents("trn_2")
      const statuses = toolCalls(e2).map((t) => `${t.item.title}:${t.item.status}`)
      expect(statuses).toEqual(["list_bots:running", "list_bots:failed", "shell:failed"])
      expect(finalMessages(e2).every((m) => m.startsWith("ERROR:"))).toBe(true)
    })))
})
