/**
 * End to end against the REAL bundled `codex app-server` (0.162.1) with a scripted mock of the
 * OpenAI Responses API (`model_providers.mock`, no auth, zero model cost) and a minimal
 * Streamable-HTTP MCP server standing in for the OpenBot gateway. Runs when the bundled binary is
 * installed; skip with `OPENBOT_CODEX_E2E=0`.
 *
 * Verifies what fakes cannot: the real server accepts OpenBot's thread config (explicit local
 * environment, hermetic features, MCP headers, direct `mcp__openbot` tools), approvals round-trip
 * through `onRequest`, interrupt and compaction work, and the normalizer understands real traffic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { HarnessEvent, HarnessRequest, HarnessRequestResolution } from "@openbot/contracts"
import { DataDir, type HarnessDriver, makeDataDir } from "@openbot/core"
import { Effect, Scope } from "effect"
import { findBundledCodex } from "../src/binary.ts"
import { codexDriver } from "../src/Driver.ts"
import { collect, has, makeSessionInput, ofTag, tempDir, turnId, waitUntil } from "./support.ts"

const enabled = process.env.OPENBOT_CODEX_E2E !== "0" && findBundledCodex() !== undefined

// ---------------------------------------------------------------------------- scripted model

type Body = { readonly input?: ReadonlyArray<Record<string, unknown>>; readonly tools?: ReadonlyArray<Record<string, unknown>> }
const modelBodies: Array<Body> = []
const sse = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const encoder = new TextEncoder()

/** The key word of the latest user message and how many tool outputs followed it. */
const promptOf = (body: Body) => {
  let key: string | undefined
  let outputs = 0
  for (const item of body.input ?? []) {
    if (item.type === "message" && item.role === "user") {
      const content = Array.isArray(item.content) ? item.content : []
      const text = content.map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : "")).join("")
      const match = /^\s*(hello|tool|run|deny|slow)\b/.exec(text)
      if (match) {
        key = match[1]
        outputs = 0
      }
    }
    if (typeof item.type === "string" && item.type.endsWith("_output")) outputs++
  }
  const compaction = (body.input ?? []).some((item) =>
    item.type === "message" && JSON.stringify(item.content ?? "").includes("CONTEXT CHECKPOINT COMPACTION")
  )
  return { key, outputs, compaction }
}

/** Where the OpenBot tools are offered to the model: `{namespace, name}` of `whoami`. */
const whoamiForm = (body: Body) => {
  const offered = [
    ...(body.tools ?? []),
    ...(body.input ?? []).filter((item) => item.type === "additional_tools").flatMap((item) =>
      Array.isArray(item.tools) ? (item.tools as ReadonlyArray<Record<string, unknown>>) : []
    ),
  ]
  for (const tool of offered) {
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools as ReadonlyArray<Record<string, unknown>>) {
        if (String(inner.name).endsWith("whoami")) return { namespace: String(tool.name), name: String(inner.name) }
      }
    }
    if (String(tool.name).endsWith("whoami")) return { namespace: undefined, name: String(tool.name) }
  }
  return undefined
}

const execCall = (n: number, cmd: string) => ({
  type: "custom_tool_call",
  call_id: `call_${n}`,
  name: "exec",
  input: `text(await tools.exec_command({ cmd: ${
    JSON.stringify(cmd)
  }, sandbox_permissions: "require_escalated", justification: "Write the e2e marker" }));`,
})

let modelServer: ReturnType<typeof Bun.serve> | undefined
let mcpServer: ReturnType<typeof Bun.serve> | undefined
const mcpLog: Array<{ method: string; authorization: string | null }> = []

const startModel = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as Body
      const n = modelBodies.push(body) - 1
      const { key, outputs, compaction } = promptOf(body)
      const id = `resp_${n}`
      const message = (texts: ReadonlyArray<string>, slowMs = 0) => ({ texts, slowMs })
      let step: { readonly item?: Record<string, unknown>; readonly texts?: ReadonlyArray<string>; readonly slowMs?: number }
      if (compaction) step = message(["Summary: the user said hello."])
      else if (key === "tool" && outputs === 0) {
        const form = whoamiForm(body)
        step = {
          item: {
            type: "function_call",
            call_id: `call_${n}`,
            name: form?.name ?? "whoami",
            arguments: "{}",
            ...(form?.namespace ? { namespace: form.namespace } : {}),
          },
        }
      } else if ((key === "run" || key === "deny") && outputs === 0) step = { item: execCall(n, "echo e2e > marker.txt") }
      else if (key === "slow") step = message(Array.from({ length: 40 }, (_, i) => `wave ${i + 1}, `), 100)
      else if (key === "tool") step = message(["Tool said: done."])
      else if (key === "run" || key === "deny") step = message(["Command step finished."])
      else step = message(["Hello from the mock."])
      const stream = new ReadableStream({
        async start(controller) {
          const push = (event: Record<string, unknown>) => {
            try {
              controller.enqueue(encoder.encode(sse(event)))
            } catch {
              // client went away (interrupt)
            }
          }
          push({ type: "response.created", response: { id } })
          if (step.item) push({ type: "response.output_item.done", item: step.item })
          if (step.texts) {
            const msgId = `msg_${n}`
            push({ type: "response.output_item.added", item: { type: "message", role: "assistant", id: msgId, content: [] } })
            for (const delta of step.texts) {
              push({ type: "response.output_text.delta", item_id: msgId, delta })
              if (step.slowMs) await Bun.sleep(step.slowMs)
            }
            push({
              type: "response.output_item.done",
              item: { type: "message", role: "assistant", id: msgId, content: [{ type: "output_text", text: step.texts.join("") }] },
            })
          }
          push({
            type: "response.completed",
            response: { id, usage: { input_tokens: 100, input_tokens_details: null, output_tokens: 10, output_tokens_details: null, total_tokens: 110 } },
          })
          try {
            controller.close()
          } catch {
            // already closed
          }
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })

// ---------------------------------------------------------------------------- minimal MCP server (JSON mode)

const startMcp = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      if (req.method === "GET") return new Response("Method Not Allowed", { status: 405 })
      if (req.method === "DELETE") return new Response(null, { status: 200 })
      const message = (await req.json()) as { id?: number | string; method?: string; params?: Record<string, unknown> }
      mcpLog.push({ method: String(message.method), authorization: req.headers.get("authorization") })
      if (message.id === undefined) return new Response(null, { status: 202 })
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers })
      switch (message.method) {
        case "initialize":
          return reply({
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "openbot-e2e", version: "0.0.0" },
          }, { "mcp-session-id": "e2e-session" })
        case "tools/list":
          return reply({
            tools: [{
              name: "whoami",
              description: "Says which node the bot is on.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            }],
          })
        case "tools/call":
          return reply({ content: [{ type: "text", text: "node=e2e-node" }] })
        default:
          return reply({})
      }
    },
  })

// ---------------------------------------------------------------------------- the session under test

let root = ""
let workspace = ""
let scope: Scope.Closeable | undefined
let driver: HarnessDriver | undefined

beforeAll(async () => {
  if (!enabled) return
  modelServer = startModel()
  mcpServer = startMcp()
  root = tempDir("openbot-codex-e2e-")
  workspace = join(root, "bots", "bot_e2e", "workspace")
  scope = Effect.runSync(Scope.make())
  driver = await Effect.runPromise(
    codexDriver({
      linkUserAuth: false,
      threadConfigExtra: {
        model_provider: "mock",
        model_providers: {
          mock: {
            name: "mock",
            base_url: `http://127.0.0.1:${modelServer.port}/v1`,
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
      },
    }).pipe(Effect.provideService(DataDir, makeDataDir(root)), Scope.provide(scope)),
  )
})

afterAll(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Effect.void as never))
  modelServer?.stop(true)
  mcpServer?.stop(true)
})

describe.skipIf(!enabled)("e2e: real codex app-server + scripted model", () => {
  test("probe and models without a login and without a model call", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const status = yield* driver!.probe
      const models = yield* driver!.listModels
      return { status, models }
    }))
    expect(result.status).toMatchObject({ kind: "codex", installed: true, version: "0.162.1", auth: { state: "signed-out" } })
    expect(result.models.length).toBeGreaterThan(0)
    expect(result.models.every((m) => m.id.length > 0 && m.label.length > 0)).toBe(true)
  }, 60_000)

  test("one session: text, MCP tool, approvals, interrupt, compaction", async () => {
    const asked: Array<HarnessRequest> = []
    let decision: HarnessRequestResolution = { decision: "allow-once" }
    const onRequest = (request: HarnessRequest) =>
      Effect.sync(() => {
        asked.push(request)
        return decision
      })
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const session = yield* driver!.openSession(makeSessionInput(workspace, onRequest, {
        model: "gpt-5.6-luna",
        effort: "low",
        mcp: [{ name: "openbot", url: `http://127.0.0.1:${mcpServer!.port}/mcp`, headers: { Authorization: "Bearer e2e-secret" } }],
      }))
      const events = yield* collect(session.events)
      const ended = (n: number) => (e: ReadonlyArray<HarnessEvent>) =>
        e.filter((x) => x._tag === "TurnCompleted" || x._tag === "TurnFailed" || x._tag === "TurnInterrupted").length >= n
      const waitTurn = (n: number) => waitUntil(() => ended(n)(events.events), `turn ${n}`, () => events.events.map((e) => e._tag).join(","), 60_000)

      yield* session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
      yield* waitTurn(1)
      yield* session.startTurn({ turnId: turnId(2), text: "tool please", attachments: [] })
      yield* waitTurn(2)
      yield* session.startTurn({ turnId: turnId(3), text: "run the command", attachments: [] })
      yield* waitTurn(3)
      const markerAfterAllow = existsSync(join(workspace, "marker.txt")) ? readFileSync(join(workspace, "marker.txt"), "utf8") : undefined
      decision = { decision: "deny" }
      yield* Effect.promise(() => Bun.file(join(workspace, "marker.txt")).delete().catch(() => undefined))
      yield* session.startTurn({ turnId: turnId(4), text: "deny this one", attachments: [] })
      yield* waitTurn(4)
      const markerAfterDeny = existsSync(join(workspace, "marker.txt"))
      yield* session.startTurn({ turnId: turnId(5), text: "slow counting", attachments: [] })
      yield* events.waitFor(has("ItemUpserted", (e) => e._tag === "ItemUpserted" && e.turnId === turnId(5)), "slow text")
      yield* session.interrupt
      yield* waitTurn(5)
      yield* session.compact
      const context = yield* session.contextUsage
      return { events: events.events, markerAfterAllow, markerAfterDeny, context, threadId: yield* session.nativeSessionId }
    })))

    const terminal = (n: number) =>
      result.events.find((e) =>
        (e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted") && e.turnId === turnId(n)
      )?._tag
    expect([1, 2, 3, 4].map(terminal)).toEqual(["TurnCompleted", "TurnCompleted", "TurnCompleted", "TurnCompleted"])
    expect(terminal(5)).toBe("TurnInterrupted")

    const items = (n: number) => {
      const byKey = new Map<string, unknown>()
      for (const e of ofTag(result.events, "ItemUpserted")) if (e.turnId === turnId(n)) byKey.set(e.key, e.item)
      return [...byKey.values()] as ReadonlyArray<Record<string, unknown>>
    }
    // 1: plain text.
    expect(items(1).find((i) => i._tag === "Message")).toMatchObject({ text: "Hello from the mock.", streaming: false })
    // 2: the OpenBot MCP tool is a direct function in its own namespace, the bearer header arrives,
    //    and no approval is asked (default_tools_approval_mode = approve).
    const toolBody = modelBodies.find((b) => promptOf(b).key === "tool")
    expect(whoamiForm(toolBody!)).toEqual({ namespace: "mcp__openbot", name: "whoami" })
    expect(mcpLog.some((m) => m.method === "tools/call" && m.authorization === "Bearer e2e-secret")).toBe(true)
    expect(mcpLog.every((m) => m.authorization === "Bearer e2e-secret")).toBe(true)
    expect(items(2).find((i) => i._tag === "ToolCall")).toMatchObject({
      toolName: "mcp__openbot__whoami",
      status: "completed",
      outputPreview: "node=e2e-node",
    })
    // 3/4: command approvals round-trip; Deny is honored.
    const approvals = asked.filter((r) => r.kind === "command-approval")
    expect(approvals.length).toBe(2)
    expect(approvals[0]).toMatchObject({ toolName: "exec_command", command: "echo e2e > marker.txt", nodeId: "node_local" })
    expect(result.markerAfterAllow).toBe("e2e\n")
    expect(result.markerAfterDeny).toBe(false)
    expect(asked.some((r) => r.kind === "mcp-approval")).toBe(false)
    // 5: the interrupted text is final and aborted.
    expect(items(5).find((i) => i._tag === "Message")).toMatchObject({ streaming: false, aborted: true })
    // Usage per turn and a context meter.
    expect(ofTag(result.events, "Usage").find((u) => u.turnId === turnId(1))?.usage.inputTokens).toBe(100)
    expect(result.context?.windowTokens).toBeGreaterThan(0)
    // The thread lives in OpenBot's CODEX_HOME, never the user's.
    expect(existsSync(join(root, "codex-home", "config.toml"))).toBe(true)
    expect(result.threadId).toMatch(/^[0-9a-f-]{36}$/)
  }, 120_000)
})
