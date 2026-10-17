import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import * as p from "../src/params.ts"
import { DefaultToolkits } from "../src/McpGateway.ts"
import { textResult } from "../src/results.ts"
import { type AnyTool, defineTool } from "../src/tool.ts"
import { type Harness, startHarness, textOf } from "./harness.ts"

let h: Harness
afterEach(async () => {
  await h?.close()
})

let runs = 0
let interrupted = 0

const slow = defineTool({
  name: "slow",
  toolset: "bot",
  description: "Sleeps for `ms` without reporting progress itself.",
  params: p.params({ ms: p.number("Milliseconds.", { integer: true, min: 0 }) }),
  handler: (args) =>
    Effect.gen(function*() {
      runs += 1
      yield* Effect.sleep(args.ms)
      return textResult(`slept ${args.ms} (run ${runs})`)
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted += 1)))),
})

const tools: ReadonlyArray<AnyTool<any>> = [...DefaultToolkits, slow]

test("a long tool sends progress heartbeats every interval", async () => {
  h = await startHarness({ tools, progressIntervalMs: 40 })
  const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
  const progress: Array<{ progress: number }> = []
  const result = await client.callTool({ name: "slow", arguments: { ms: 300 } }, undefined, {
    onprogress: (event) => progress.push(event),
  })
  expect(textOf(result)).toStartWith("slept 300")
  expect(progress.length).toBeGreaterThanOrEqual(4)
  // strictly increasing progress values (MCP spec)
  for (let i = 1; i < progress.length; i++) expect(progress[i]!.progress).toBeGreaterThan(progress[i - 1]!.progress)
})

test("without a progress token no notifications are sent", async () => {
  h = await startHarness({ tools, progressIntervalMs: 20 })
  const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
  let notified = 0
  client.setNotificationHandler(
    (await import("@modelcontextprotocol/sdk/types.js")).ProgressNotificationSchema,
    () => void (notified += 1),
  )
  const result = await client.callTool({ name: "slow", arguments: { ms: 100 } })
  expect(textOf(result)).toStartWith("slept 100")
  expect(notified).toBe(0)
})

test("identical in-flight calls without a call id run once", async () => {
  runs = 0
  h = await startHarness({ tools })
  const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
  const [a, b] = await Promise.all([
    client.callTool({ name: "slow", arguments: { ms: 150 } }),
    client.callTool({ name: "slow", arguments: { ms: 150 } }),
  ])
  expect(runs).toBe(1)
  expect(textOf(a)).toBe(textOf(b))
  // once finished, the same call runs again (only call ids are replayed)
  await client.callTool({ name: "slow", arguments: { ms: 10 } })
  await client.callTool({ name: "slow", arguments: { ms: 10 } })
  expect(runs).toBe(3)
})

test("a cancelled call interrupts the handler", async () => {
  interrupted = 0
  h = await startHarness({ tools })
  const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
  const controller = new AbortController()
  const call = client.callTool({ name: "slow", arguments: { ms: 5_000 } }, undefined, { signal: controller.signal })
  await Bun.sleep(100)
  controller.abort("test")
  await expect(call).rejects.toThrow()
  for (let i = 0; i < 50 && interrupted === 0; i++) await Bun.sleep(20)
  expect(interrupted).toBe(1)
})
