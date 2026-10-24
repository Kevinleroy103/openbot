import { describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID, type NodeId } from "@openbot/contracts"
import { HarnessError } from "@openbot/core"
import {
  isValidEnvironmentId,
  planThread,
  skillRulesFor,
  threadConfig,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
  type ThreadPlan,
  userInputOf,
} from "../src/config.ts"
import { makePlacement, makeSessionInput, turnId } from "./support.ts"

const NODE = "nod_build" as NodeId
const plan = (placement: Parameters<typeof planThread>[0]): ThreadPlan => {
  const planned = planThread(placement)
  if (planned instanceof HarnessError) throw planned
  return planned
}

describe("placement → thread plan (explicit environments always, G3)", () => {
  test("native-local: the local environment at the workspace", () => {
    const p = plan(makePlacement("/data/bots/b/workspace"))
    expect(p.environments).toEqual([{ environmentId: "local", cwd: "/data/bots/b/workspace" }])
    expect(p.sandbox).toBe("workspace-write")
    expect(p.register).toBeUndefined()
    expect(p.baseInstructions).toBeUndefined()
    expect(p.nodeIdForEnvironment("local")).toBe(LOCAL_NODE_ID)
  })

  test("codex-environment: registers the relay and selects only the node", () => {
    const p = plan(
      makePlacement("/data/scratch", {
        mode: "codex-environment",
        hostNodeId: NODE,
        workspacePath: "/home/u/openbot/workspaces/b",
        codexEnvironment: {
          environmentId: NODE,
          execServerUrl: "ws://127.0.0.1:1/relay",
          authBearerToken: "t",
          cwd: "/home/u/openbot/workspaces/b",
        },
      }),
    )
    expect(p.environments).toEqual([{ environmentId: NODE, cwd: "/home/u/openbot/workspaces/b" }])
    expect(p.register).toEqual({
      environmentId: NODE,
      execServerUrl: "ws://127.0.0.1:1/relay",
      authBearerToken: "t",
      connectTimeoutMs: 10_000,
    })
    expect(p.cwd).toBe("/data/scratch")
    expect(p.nodeIdForEnvironment(NODE)).toBe(NODE)
    expect(p.nodeIdForEnvironment("local")).toBeUndefined()
  })

  test("codex-environment without a relay, or with a reserved id, fails", () => {
    const missing = planThread(makePlacement("/w", { mode: "codex-environment", hostNodeId: NODE }))
    expect(missing).toBeInstanceOf(HarnessError)
    const reserved = planThread(
      makePlacement("/w", {
        mode: "codex-environment",
        hostNodeId: NODE,
        codexEnvironment: { environmentId: "local", execServerUrl: "ws://x", authBearerToken: "t", cwd: "/w" },
      }),
    )
    expect(reserved).toMatchObject({ code: "open-failed" })
    expect(isValidEnvironmentId("nod_01ABC-x")).toBe(true)
    expect(isValidEnvironmentId("none")).toBe(false)
    expect(isValidEnvironmentId("has:colon")).toBe(false)
  })

  test("brain-mcp-hands: no environments, read-only, a base prompt about the node tools", () => {
    const p = plan(
      makePlacement("/data/scratch", { mode: "brain-mcp-hands", hostNodeId: NODE, workspacePath: "/srv/ws" }),
    )
    expect(p.environments).toEqual([])
    expect(p.sandbox).toBe("read-only")
    expect(p.baseInstructions).toContain("NO local shell")
    expect(p.baseInstructions).toContain("/srv/ws")
    for (const tool of ["shell", "read_file", "write_file", "edit_file", "list_dir", "glob", "grep"]) {
      expect(p.baseInstructions).toContain(tool)
    }
  })
})

describe("thread config", () => {
  test("no MCP bindings: no servers and no code-mode namespace", () => {
    expect(threadConfig([])).toEqual({ features: { apps: false, plugins: false, memories: false }, mcp_servers: {} })
  })

  test("timeouts, skill rules and extras", () => {
    const config = threadConfig([{ name: "openbot", url: "http://x/mcp/b", headers: { authorization: "Bearer t" } }], {
      mcpToolTimeoutSec: 120,
      mcpStartupTimeoutSec: 5,
      skillRules: [{ path: "/s/SKILL.md", enabled: false }],
      extra: { model_provider: "mock" },
    })
    expect(config).toMatchObject({
      mcp_servers: { openbot: { tool_timeout_sec: 120, startup_timeout_sec: 5 } },
      "skills.config": [{ path: "/s/SKILL.md", enabled: false }],
      model_provider: "mock",
    })
  })

  test("thread/start and thread/resume params; model omitted when unset", () => {
    const input = makeSessionInput(
      "/w",
      () => {
        throw new Error("unused")
      },
      { model: undefined },
    )
    const p = plan(makePlacement("/w"))
    const start = threadStartParams(input, p, {})
    expect(start).not.toHaveProperty("model")
    expect(start).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      environments: p.environments,
    })
    const resume = threadResumeParams("thr", input, p, {})
    expect(resume).toMatchObject({
      threadId: "thr",
      excludeTurns: true,
      developerInstructions: "You are Scout, an OpenBot.",
    })
    expect(resume).not.toHaveProperty("environments")
  })

  test("turn/start always carries the environments; text-only input", () => {
    const p = plan(makePlacement("/w"))
    expect(turnStartParams("thr", { turnId: turnId(1), text: "hi", attachments: [] }, p, {})).toEqual({
      threadId: "thr",
      input: [{ type: "text", text: "hi", text_elements: [] }],
      environments: [{ environmentId: "local", cwd: "/w" }],
      summary: "auto",
    })
    expect(
      userInputOf({ turnId: turnId(1), text: "see", attachments: [{ path: "/a.jpg", mime: "IMAGE/JPEG", name: "a" }] }),
    ).toEqual([
      { type: "text", text: "see", text_elements: [] },
      { type: "localImage", path: "/a.jpg" },
    ])
  })

  test("skill rules disable everything outside the library, once per path", () => {
    const listed = {
      data: [
        {
          cwd: "/w",
          skills: [{ path: "/lib/skills/a/SKILL.md" }, { path: "/home/u/.agents/skills/x/SKILL.md" }, { path: "" }, {}],
        },
        {
          cwd: "/v",
          skills: [{ path: "/home/u/.agents/skills/x/SKILL.md" }, { path: "/lib/skills-other/y/SKILL.md" }],
        },
      ],
    }
    expect(skillRulesFor(listed, "/lib/skills/")).toEqual([
      { path: "/home/u/.agents/skills/x/SKILL.md", enabled: false },
      { path: "/lib/skills-other/y/SKILL.md", enabled: false },
    ])
    expect(skillRulesFor(undefined, "/lib")).toEqual([])
    expect(skillRulesFor(listed, undefined).length).toBe(3)
  })

  test("library skills the Bot does not have are disabled too (D5.5)", () => {
    const listed = {
      data: [{ cwd: "/w", skills: [{ path: "/lib/skills/a/SKILL.md" }, { path: "/lib/skills/b/SKILL.md" }] }],
    }
    expect(skillRulesFor(listed, "/lib/skills", ["a"])).toEqual([{ path: "/lib/skills/b/SKILL.md", enabled: false }])
    expect(skillRulesFor(listed, "/lib/skills", [])).toEqual([
      { path: "/lib/skills/a/SKILL.md", enabled: false },
      { path: "/lib/skills/b/SKILL.md", enabled: false },
    ])
  })
})
