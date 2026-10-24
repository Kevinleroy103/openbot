/**
 * Live brain/hands: a second node daemon on this machine (the real `apps/node` CLI, its own data dir
 * and root) paired as a "remote" node; Claude/Codex/OpenCode bots hosted on it must create files
 * under the NODE root, never in their brain workspace.
 * Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/remote.test.ts [-t <name>]`.
 * Root: `OPENBOT_LIVE_NODE_ROOT` (default /tmp/ob-node-root, recreated).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot, NodeId, NodeSummary } from "@openbot/contracts"
import { DataDir } from "@openbot/core"
import { Context, Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { eventually } from "../helpers.ts"
import {
  botTexts,
  type CheapHarness,
  connect,
  converse,
  createBot,
  LIVE,
  type LiveBrain,
  report,
  startLiveBrain,
  toolCalls,
} from "./support.ts"

const NODE_MAIN = resolve(import.meta.dir, "../../../node/src/main.ts")
const NODE_ROOT = process.env["OPENBOT_LIVE_NODE_ROOT"] ?? "/tmp/ob-node-root"

let brain: LiveBrain
let node: { proc: Bun.Subprocess; dataDir: string; id: NodeId } | undefined

const findFile = (dir: string, name: string): string | undefined => {
  if (!existsSync(dir)) return undefined
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found !== undefined) return found
    }
  }
  return undefined
}

describe.skipIf(!LIVE)("live: remote node (brain/hands)", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
    rmSync(NODE_ROOT, { recursive: true, force: true })
    mkdirSync(NODE_ROOT, { recursive: true })
    const nodeData = mkdtempSync(join(tmpdir(), "openbot-live-node-"))
    const pairing = await brain.run(
      Effect.gen(function* () {
        const client = yield* connect(brain.server, brain.cookie)
        return yield* client["nodes.createPairingCode"]()
      }),
    )
    console.log("[live] pairing command:", pairing.command)
    // async spawn: the brain runs in this process and must keep serving `/node/pair`
    const pair = Bun.spawn(["bun", NODE_MAIN, "pair", brain.server.base, pairing.code, "--data-dir", nodeData], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [pairOut, pairErr, pairCode] = await Promise.all([
      new Response(pair.stdout).text(),
      new Response(pair.stderr).text(),
      pair.exited,
    ])
    console.log("[live] pair:", pairCode, pairOut, pairErr)
    expect(pairCode).toBe(0)
    const proc = Bun.spawn(["bun", NODE_MAIN, "run", "--data-dir", nodeData, "--root", NODE_ROOT, "--no-browser"], {
      stdout: "inherit",
      stderr: "inherit",
    })
    const online: NodeSummary = await brain.run(
      Effect.gen(function* () {
        const client = yield* connect(brain.server, brain.cookie)
        const nodes = yield* eventually(
          client["nodes.list"](),
          (all) => all.some((n) => n.kind === "remote" && n.status === "online"),
          { timeout: 30_000, label: "remote node online" },
        )
        const remote = nodes.find((n) => n.kind === "remote")!
        console.log("[live] node online:", JSON.stringify(remote))
        // approve every declared capability (Settings › Computers)
        return yield* client["nodes.setCapabilities"]({ nodeId: remote.id, approved: [...remote.declaredCapabilities] })
      }),
    )
    console.log("[live] approved:", online.capabilities)
    node = { proc, dataDir: nodeData, id: online.id }
  }, 90_000)

  afterAll(async () => {
    node?.proc.kill("SIGTERM")
    await node?.proc.exited
    if (node !== undefined) rmSync(node.dataDir, { recursive: true, force: true })
    await brain?.close()
  }, 60_000)

  const createOnNode = (harness: CheapHarness, expectedMode: string) =>
    brain.run(
      Effect.gen(function* () {
        const client = yield* connect(brain.server, brain.cookie)
        const bot: Bot = yield* createBot(client, `Remote${harness}`, harness, { hostNodeId: node!.id })
        const context = yield* client["bots.readContext"]({ botId: bot.id })
        console.log(
          `[live] ${harness} placement prompt:`,
          context.instructions
            .split("\n")
            .filter((l) => /node|computer|workspace|built-in/i.test(l))
            .join(" | "),
        )
        const file = `hello-${harness}.txt`
        const result = yield* converse(
          client,
          bot.directConversationId,
          `Create a file named ${file} in your workspace containing the text "hands-${harness}". Then reply "done".`,
          { timeout: 300_000 },
        )
        report(`${harness} on remote node`, result.entries, result.turns)
        const dataDir = Context.get(brain.server.context, DataDir)
        const onNode = findFile(NODE_ROOT, file)
        const onBrain = findFile(dataDir.workspaceDir(bot.id), file) ?? findFile(dataDir.root, file)
        console.log(`[live] ${harness}: node file=${onNode} brain file=${onBrain}`)
        expect(result.turns.every((t) => t.status === "completed")).toBe(true)
        expect(onNode).toBeDefined()
        expect(onBrain).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(onNode!).text())).toContain(`hands-${harness}`)
        // where does a shell run? (B1: the gateway `shell` on the node; codex-environment: exec on the node)
        const pwd = yield* converse(
          client,
          bot.directConversationId,
          "Run the shell command `pwd` and reply with its output only.",
          {
            timeout: 300_000,
          },
        )
        report(`${harness} pwd on remote node`, pwd.entries.slice(result.entries.length), pwd.turns)
        expect(botTexts(pwd.entries).at(-1)).toContain(`${NODE_ROOT}/workspaces/${bot.id}`)
        const calls = [...toolCalls(result.entries), ...toolCalls(pwd.entries.slice(result.entries.length))]
        expect(calls.length).toBeGreaterThan(1)
        expect(calls.every((c) => c.nodeId === node!.id)).toBe(true)
        return { bot, calls, mode: expectedMode }
      }),
    )

  test("claude on the remote node (B1: gateway node tools)", async () => {
    const { calls } = await createOnNode("claude", "brain-mcp-hands")
    expect(calls.every((c) => c.name.startsWith("mcp__openbot__"))).toBe(true)
  }, 400_000)

  test("codex on the remote node (codex-environment)", async () => {
    await createOnNode("codex", "codex-environment")
  }, 400_000)

  test("opencode on the remote node (B1)", async () => {
    const { calls } = await createOnNode("opencode", "brain-mcp-hands")
    expect(calls.every((c) => c.name.includes("openbot"))).toBe(true)
  }, 400_000)

  test("half-open: a frozen node (SIGSTOP) goes offline; after SIGCONT it comes back", async () => {
    const proc = node!.proc
    const statusOf = () =>
      brain.run(
        Effect.gen(function* () {
          const client = yield* connect(brain.server, brain.cookie)
          return (yield* client["nodes.list"]()).find((n) => n.id === node!.id)?.status
        }),
      )
    expect(await statusOf()).toBe("online")
    const stoppedAt = Date.now()
    process.kill(proc.pid, "SIGSTOP")
    try {
      while ((await statusOf()) === "online" && Date.now() - stoppedAt < 60_000) await Bun.sleep(500)
      console.log(`[live] frozen node went ${await statusOf()} after ${Date.now() - stoppedAt} ms`)
      expect(await statusOf()).toBe("offline")
    } finally {
      process.kill(proc.pid, "SIGCONT")
    }
    const resumedAt = Date.now()
    while ((await statusOf()) !== "online" && Date.now() - resumedAt < 60_000) await Bun.sleep(500)
    console.log(`[live] node back ${await statusOf()} after ${Date.now() - resumedAt} ms`)
    expect(await statusOf()).toBe("online")
  }, 150_000)
})
