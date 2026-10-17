/**
 * Live scenarios on the local node (real Claude/Codex/OpenCode, cheapest models, tiny prompts).
 * Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/local.test.ts [-t <name>]`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import { Effect } from "effect"
import { botTexts, CHEAP, type CheapHarness, connect, converse, createBot, LIVE, type LiveBrain, report, startLiveBrain, toolCalls } from "./support.ts"

let brain: LiveBrain

describe.skipIf(!LIVE)("live: local node", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
  }, 60_000)
  afterAll(async () => {
    await brain?.close()
  }, 60_000)

  /** A side-effecting command each harness gates natively (Codex sandbox: network needs escalation). */
  const COMMAND: Record<CheapHarness, string> = {
    claude: "touch approval-probe.txt && echo openbot-$((6*7))",
    opencode: "touch approval-probe.txt && echo openbot-$((6*7))",
    codex: "curl -s -o /dev/null -w 'openbot-%{http_code}' https://example.com",
  }
  const EXPECT: Record<CheapHarness, string> = { claude: "openbot-42", opencode: "openbot-42", codex: "openbot-200" }

  const shellTurn = (harness: CheapHarness) =>
    brain.run(Effect.gen(function*() {
      const client = yield* connect(brain.server, brain.cookie)
      const bot: Bot = yield* createBot(client, `Shell${harness}`, harness)
      const before = brain.approvals.length
      const result = yield* converse(
        client,
        bot.directConversationId,
        `Run the shell command \`${COMMAND[harness]}\` and reply with its output only.${
          harness === "codex" ? " It needs network access: if the sandbox blocks it, rerun it with escalated permissions." : ""
        }`,
        { timeout: 240_000 },
      )
      report(`${harness} shell (${CHEAP[harness].model})`, result.entries, result.turns)
      expect(result.turns.every((t) => t.status === "completed")).toBe(true)
      expect(toolCalls(result.entries).length).toBeGreaterThan(0)
      expect(brain.approvals.length).toBeGreaterThan(before)
      expect(botTexts(result.entries).join("\n")).toContain(EXPECT[harness])
    }))

  test("codex: a shell command with an approval card", () => shellTurn("codex"), 300_000)
  test("opencode: a shell command with an approval card", () => shellTurn("opencode"), 300_000)
  test("claude: a shell command with an approval card", () => shellTurn("claude"), 300_000)
})
