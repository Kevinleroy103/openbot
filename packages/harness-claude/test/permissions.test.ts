import { describe, expect, test } from "bun:test"
import { HarnessRequest } from "@openbot/contracts"
import { Schema } from "effect"
import { join } from "node:path"
import { type CanUseToolOptions, toHarnessRequest, toPermissionResult, toSessionPermissionUpdates } from "../src/permissions.ts"
import { CONTRACT_FIXTURES, type FixtureFrame, loadJsonl } from "./support.ts"

const decodeRequest = Schema.decodeUnknownSync(HarnessRequest)

const canUseToolFrames = async () => {
  const frames = await loadJsonl<FixtureFrame>(join(CONTRACT_FIXTURES, "claude-basic.jsonl"))
  const calls = frames.filter((f) => f.source === "claude.canUseTool").map((f) => f.payload)
  const responses = frames.filter((f) => f.source === "claude.canUseTool.response").map((f) => f.payload)
  return calls.map((call, i) => ({
    toolName: call.toolName as string,
    input: call.input as Record<string, unknown>,
    options: call.options as CanUseToolOptions,
    response: responses[i]!.result as Record<string, unknown>,
  }))
}

describe("canUseTool → HarnessRequest", () => {
  test("Bash → command-approval with command, cwd, suggestions; schema-valid", async () => {
    const [bash] = await canUseToolFrames()
    const request = toHarnessRequest(bash!.toolName, bash!.input, bash!.options, "/work")
    expect(() => decodeRequest(request)).not.toThrow()
    expect(request).toMatchObject({
      kind: "command-approval",
      toolName: "Bash",
      surface: "shell",
      command: "touch marker.txt && echo openbot-fixture",
      cwd: "/work",
      toolKey: "toolu_fake_002_1",
      nativeRequestId: "661a1ff3-40b9-45b1-a6ec-d571f25d7123",
    })
    expect(request.kind !== "question" && request.suggestions?.map((s) => s.decision)).toEqual(["allow-session", "allow-always"])
  })

  test("Write → file-approval with paths", async () => {
    const [, write] = await canUseToolFrames()
    const request = toHarnessRequest(write!.toolName, write!.input, write!.options)
    expect(request).toMatchObject({ kind: "file-approval", surface: "file-edit", paths: ["<CWD>/denied.txt"], detail: "denied.txt" })
  })

  test("AskUserQuestion → question request with q<i> ids", async () => {
    const [, , ask] = await canUseToolFrames()
    const request = toHarnessRequest(ask!.toolName, ask!.input, ask!.options)
    expect(() => decodeRequest(request)).not.toThrow()
    expect(request).toEqual({
      kind: "question",
      title: "Color",
      toolKey: "toolu_fake_006_0",
      nativeRequestId: "43b5d02b-c328-4ec9-9278-b748b9e7bf78",
      questions: [{
        id: "q0",
        header: "Color",
        prompt: "Which color should the bot avatar use?",
        options: [{ label: "Blue", description: "Calm" }, { label: "Orange", description: "Warm" }],
        multiSelect: false,
        allowFreeText: true,
      }],
    })
  })

  test("mcp tools → mcp-approval with server; openbot node tools carry nodeId", () => {
    const request = toHarnessRequest("mcp__openbot__shell", { command: "ls", node: "nod_1" }, { toolUseID: "t1" })
    expect(request).toMatchObject({ kind: "command-approval", surface: "shell", server: "openbot", command: "ls", nodeId: "nod_1" })
    const other = toHarnessRequest("mcp__github__create_issue", { title: "x" }, { toolUseID: "t2" })
    expect(other).toMatchObject({ kind: "mcp-approval", surface: "mcp", server: "github" })
  })

  test("suppressAlwaysAllowRule hides persistent choices", () => {
    const request = toHarnessRequest("Bash", { command: "rm -rf x" }, { toolUseID: "t", suppressAlwaysAllowRule: true })
    expect(request.kind !== "question" && request.suggestions).toBeUndefined()
  })
})

describe("resolution → PermissionResult (domain-contract §F.8)", () => {
  test("reproduces the recorded responses", async () => {
    const [bash, write, ask] = await canUseToolFrames()
    expect(toPermissionResult(bash!.toolName, bash!.input, bash!.options, { decision: "allow-once" })).toEqual({
      ...bash!.response,
      toolUseID: "toolu_fake_002_1",
    } as never)
    expect(toPermissionResult(write!.toolName, write!.input, write!.options, { decision: "deny" })).toEqual({
      ...write!.response,
      toolUseID: "toolu_fake_004_0",
    } as never)
    const answered = toPermissionResult(ask!.toolName, ask!.input, ask!.options, { answers: { q0: "Blue" } })
    expect(answered).toMatchObject(ask!.response)
  })

  test("multi-select answers are joined; edited input is honoured on allow", () => {
    const input = { questions: [{ question: "Pick", header: "P", options: [{ label: "A" }, { label: "B" }], multiSelect: true }] }
    const result = toPermissionResult("AskUserQuestion", input, { toolUseID: "t" }, { answers: { q0: ["A", "B"] } })
    expect(result).toMatchObject({ behavior: "allow", updatedInput: { questions: input.questions, answers: { Pick: "A, B" } } })
    const edited = toPermissionResult("Bash", { command: "ls" }, { toolUseID: "t" }, {
      decision: "allow-once",
      updatedInput: { command: "ls -la" },
    })
    expect(edited).toMatchObject({ behavior: "allow", updatedInput: { command: "ls -la" } })
  })

  test("allow-session / allow-always rewrite suggestions to the session destination", async () => {
    const [bash] = await canUseToolFrames()
    const result = toPermissionResult(bash!.toolName, bash!.input, bash!.options, { decision: "allow-session" })
    expect(result.behavior).toBe("allow")
    const updates = result.behavior === "allow" ? result.updatedPermissions ?? [] : []
    expect(updates.length).toBe(2) // setMode acceptEdits is dropped
    for (const u of updates) expect(u.destination).toBe("session")
    expect(updates.some((u) => u.type === "setMode")).toBe(false)
    const always = toPermissionResult("Read", { file_path: "/a" }, { toolUseID: "t" }, { decision: "allow-always" })
    expect(always).toMatchObject({
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" }],
    })
  })

  test("cancel denies with interrupt; dismissing a question denies", () => {
    expect(toPermissionResult("Bash", {}, { toolUseID: "t" }, { decision: "cancel" })).toMatchObject({ behavior: "deny", interrupt: true })
    expect(toPermissionResult("AskUserQuestion", { questions: [] }, { toolUseID: "t" }, { decision: "deny" })).toMatchObject({
      behavior: "deny",
      message: "The user dismissed the question.",
    })
  })

  test("toSessionPermissionUpdates never writes to settings files", () => {
    const updates = toSessionPermissionUpdates("Bash", [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" },
      { type: "addDirectories", directories: ["/x"], destination: "projectSettings" },
    ])
    expect(updates.map((u) => u.destination)).toEqual(["session", "session"])
  })
})
