import { describe, expect, test } from "bun:test"
import type { HarnessApprovalRequest, HarnessQuestionRequest } from "@openbot/contracts"
import { HarnessRequest as HarnessRequestSchema, LOCAL_NODE_ID } from "@openbot/contracts"
import { Schema } from "effect"
import { CodexNormalizer } from "../src/normalize.ts"
import { type MappedRequest, mapServerRequest } from "../src/requests.ts"
import { loadFixture, replayFixture, turnId } from "./support.ts"

const ask = (mapped: MappedRequest) => {
  if (mapped._tag !== "Ask") throw new Error(`expected Ask, got ${mapped._tag}`)
  return mapped
}
const ctx = (normalizer = new CodexNormalizer()) => ({ normalizer, nodeIdForEnvironment: () => LOCAL_NODE_ID })

describe("server requests from the recorded fixture", () => {
  const replay = replayFixture(loadFixture("codex-basic.jsonl"))
  const byMethod = (method: string) => replay.requests.filter((r) => r.method === method)

  test("every asked request encodes with the contracts schema", () => {
    const encode = Schema.encodeUnknownSync(HarnessRequestSchema)
    for (const r of replay.requests) {
      const mapped = r.mapped
      if (mapped._tag === "Ask") expect(() => encode(mapped.request)).not.toThrow()
    }
    expect(replay.requests.map((r) => r.method)).toEqual([
      "item/commandExecution/requestApproval",
      "item/commandExecution/requestApproval",
      "mcpServer/elicitation/request",
      "item/tool/requestUserInput",
    ])
  })

  test("command approval: clean command, reason, tool key, node; Deny offered although Codex did not list it", () => {
    const [approved, declined] = byMethod("item/commandExecution/requestApproval")
    const mapped = ask(approved!.mapped)
    const request = mapped.request as HarnessApprovalRequest
    expect(request).toMatchObject({
      kind: "command-approval",
      toolName: "exec_command",
      surface: "shell",
      title: "Run this command?",
      detail: "Create a marker file",
      command: "touch approved.txt && echo openbot-fixture",
      cwd: "<CWD>",
      nativeRequestId: "0",
      toolKey: `${approved!.params.turnId}:${approved!.params.itemId}`,
      nodeId: LOCAL_NODE_ID,
    })
    // availableDecisions = [accept, acceptWithExecpolicyAmendment, cancel]: no session option.
    expect(request.suggestions).toEqual([{ decision: "cancel", label: "Deny and stop" }])
    // Same answers as the recorder gave.
    expect(mapped.reply({ decision: "allow-once" })).toEqual(approved!.recorded)
    expect(ask(declined!.mapped).reply({ decision: "deny" })).toEqual(declined!.recorded)
    // OpenBot rules never become Codex execpolicy amendments.
    expect(mapped.reply({ decision: "allow-always" })).toEqual({ decision: "accept" })
    expect(mapped.reply({ decision: "cancel" })).toEqual({ decision: "cancel" })
    // A question-style answer to an approval is a deny.
    expect(mapped.reply({ answers: { x: "y" } })).toEqual({ decision: "decline" })
  })

  test("MCP tool approval (elicitation): linked to the running call, session option from persist", () => {
    const [elicitation] = byMethod("mcpServer/elicitation/request")
    const mapped = ask(elicitation!.mapped)
    const request = mapped.request as HarnessApprovalRequest
    expect(request).toMatchObject({
      kind: "mcp-approval",
      toolName: "mcp__openbot__remember",
      surface: "mcp",
      server: "openbot",
      detail: "Store a short note in the bot's memory.",
      input: { note: "likes blue" },
      toolKey: expect.stringMatching(/:exec-b5df793d-fa5d-41f3-b837-19e9738966c5$/),
      suggestions: [{ decision: "allow-session", label: "Allow for this chat" }],
    })
    expect(mapped.reply({ decision: "allow-once" })).toMatchObject(elicitation!.recorded as object)
    expect(mapped.reply({ decision: "allow-session" })).toEqual({ action: "accept", content: {}, _meta: { persist: "session" } })
    expect(mapped.reply({ decision: "allow-always" })).toEqual({ action: "accept", content: {}, _meta: { persist: "session" } })
    expect(mapped.reply({ decision: "deny" })).toEqual({ action: "decline", content: null, _meta: null })
  })

  test("requestUserInput: a question card whose answers come back in Codex's shape", () => {
    const [input] = byMethod("item/tool/requestUserInput")
    const mapped = ask(input!.mapped)
    expect(mapped.request as HarnessQuestionRequest).toEqual({
      kind: "question",
      title: "Color",
      nativeRequestId: "3",
      toolKey: `${input!.params.turnId}:call_8`,
      questions: [{
        id: "color",
        header: "Color",
        prompt: "Which avatar color?",
        options: [{ label: "Blue (Recommended)", description: "Calm" }, { label: "Orange", description: "Warm" }],
        multiSelect: false,
        allowFreeText: true,
      }],
    })
    expect(mapped.reply({ answers: { color: "Blue (Recommended)" } })).toEqual(input!.recorded)
    // Declined question: empty answers.
    expect(mapped.reply({ decision: "deny" })).toEqual({ answers: {} })
  })
})

describe("server request mapping", () => {
  test("file change approval uses the diff of the matching fileChange item", () => {
    const normalizer = new CodexNormalizer()
    normalizer.expectTurn(turnId(1))
    normalizer.handle("item/started", {
      turnId: "nat",
      item: { type: "fileChange", id: "fc", status: "inProgress", changes: [{ path: "/w/a.ts", kind: { type: "update" }, diff: "-a\n+b" }] },
    })
    const mapped = ask(mapServerRequest(5, "item/fileChange/requestApproval", { threadId: "t", turnId: "nat", itemId: "fc" }, ctx(normalizer)))
    expect(mapped.request).toMatchObject({
      kind: "file-approval",
      toolName: "apply_patch",
      surface: "file-edit",
      paths: ["/w/a.ts"],
      diff: "-a\n+b",
      toolKey: "nat:fc",
      suggestions: [{ decision: "allow-session" }, { decision: "cancel" }],
    })
    expect(mapped.reply({ decision: "allow-session" })).toEqual({ decision: "acceptForSession" })
    expect(mapped.reply({ decision: "deny" })).toEqual({ decision: "decline" })
  })

  test("network approvals are classified as network", () => {
    const mapped = ask(mapServerRequest(1, "item/commandExecution/requestApproval", {
      threadId: "t",
      turnId: "nat",
      itemId: "e",
      command: "curl example.com",
      networkApprovalContext: { host: "example.com" },
      availableDecisions: ["accept", "acceptForSession", "decline"],
    }, ctx()))
    expect(mapped.request).toMatchObject({ surface: "network", title: "Allow network access?" })
    expect(mapped.reply({ decision: "allow-always" })).toEqual({ decision: "acceptForSession" })
  })

  test("permissions: grants the requested profile for the turn or the session; deny grants nothing", () => {
    const permissions = { network: { enabled: true }, fileSystem: { read: null, write: ["/data"] } }
    const mapped = ask(mapServerRequest(2, "item/permissions/requestApproval", {
      threadId: "t",
      turnId: "nat",
      itemId: "p",
      cwd: "/w",
      reason: "Needs to download",
      permissions,
    }, ctx()))
    expect(mapped.request).toMatchObject({
      kind: "tool-approval",
      toolName: "request_permissions",
      surface: "file-edit",
      paths: ["/data"],
      detail: "Needs to download\nCodex asks for network access and write access to /data.",
    })
    expect(mapped.reply({ decision: "allow-once" })).toEqual({ permissions, scope: "turn" })
    expect(mapped.reply({ decision: "allow-session" })).toEqual({ permissions, scope: "session" })
    expect(mapped.reply({ decision: "deny" })).toEqual({ permissions: {}, scope: "turn" })
  })

  test("MCP form elicitation becomes questions; answers are coerced to the schema types", () => {
    const mapped = ask(mapServerRequest(3, "mcpServer/elicitation/request", {
      threadId: "t",
      serverName: "github",
      mode: "form",
      message: "Pick a repo",
      requestedSchema: {
        type: "object",
        properties: {
          repo: { type: "string", enum: ["a/b", "c/d"], enumNames: ["A B", "C D"], title: "Repository" },
          count: { type: "integer", description: "How many" },
          sure: { type: "boolean", title: "Sure?" },
        },
      },
      _meta: null,
    }, ctx()))
    expect(mapped.request).toMatchObject({
      kind: "question",
      title: "Pick a repo",
      questions: [
        { id: "repo", header: "Repository", options: [{ label: "A B" }, { label: "C D" }], allowFreeText: false },
        { id: "count", prompt: "How many", options: [], allowFreeText: true },
        { id: "sure", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    })
    expect(mapped.reply({ answers: { repo: "C D", count: "3", sure: "Yes" } })).toEqual({
      action: "accept",
      content: { repo: "c/d", count: 3, sure: true },
      _meta: null,
    })
    expect(mapped.reply({ decision: "deny" })).toEqual({ action: "decline", content: null, _meta: null })
  })

  test("unsupported requests are answered without asking", () => {
    expect(mapServerRequest(4, "item/tool/call", { threadId: "t" }, ctx())).toMatchObject({
      _tag: "Answer",
      reply: { result: { success: false } },
    })
    expect(mapServerRequest(5, "account/chatgptAuthTokens/refresh", {}, ctx())).toMatchObject({
      _tag: "Answer",
      reply: { error: { code: -32601 } },
    })
    expect(mapServerRequest(6, "mcpServer/elicitation/request", { serverName: "x", mode: "openai/form" }, ctx())).toEqual({
      _tag: "Answer",
      reply: { result: { action: "decline", content: null, _meta: null } },
    })
  })
})
