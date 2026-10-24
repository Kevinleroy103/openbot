// TEST HELPER ONLY (fixture reducers): adapters own the real normalizers (HarnessEvent). Ported from vendor/scratch/contracts/src/reduce.
// Codex app-server v2 JSON-RPC frames -> OpenBot conversation changes. Research scratch.
import type { TurnId } from "../../../src/index.ts"
import type {
  DecisionOption,
  Question,
  RuntimeRequest,
  RuntimeRequestKind,
  RuntimeResponse,
} from "../../../src/index.ts"
import type { ToolCallStatus } from "../../../src/index.ts"
import { defaultCtx, Emitter, type Frame, Ledger, openbotSend } from "./kit.ts"

const decisionFromCodex = (d: unknown): DecisionOption => {
  if (d === "accept") return { id: "allow-once", label: "Allow once", native: d }
  if (d === "acceptForSession") return { id: "allow-session", label: "Allow for this chat", native: d }
  if (d === "decline") return { id: "deny", label: "Deny", native: d }
  if (d === "cancel") return { id: "cancel", label: "Deny and stop", native: d }
  // {acceptWithExecpolicyAmendment} / {applyNetworkPolicyAmendment}: "always allow this command"
  return { id: "allow-always", label: "Always allow", native: d }
}
const codexToDecision = (d: unknown): RuntimeResponse =>
  ({ type: "decision", decision: decisionFromCodex(d).id }) as RuntimeResponse

export const reduceCodex = (frames: ReadonlyArray<Frame>, ctx = defaultCtx("codex")) => {
  const em = new Emitter(ctx)
  const ledger = new Ledger()
  let turnIndex = -1
  let turnKey = ""
  const turn = (): TurnId => em.turnId(turnKey)
  /** server->client JSON-RPC request id -> what it was about */
  const serverReqs = new Map<
    string,
    { requestKey: string; kind: "command" | "elicitation" | "userInput"; toolKey?: string; questions?: Question[] }
  >()
  const mcpRunning: Array<{ key: string; server: string; tool: string; args: unknown }> = []
  let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined
  const setTurn = (patch: Record<string, unknown>) =>
    em.upsertTurn(turnKey, (prev, id) => ({ ...prev!, id, ...patch }) as any)

  for (const f of frames) {
    const p = f.payload
    if (f.source === "openbot.control") {
      if (p.action === "send") {
        turnIndex++
        turnKey = `codex-turn-${turnIndex}`
        openbotSend(em, f, turnKey, p.text, `nonce-${turnIndex}`)
        ledger.note("openbot:send", "mapped")
      } else ledger.note(`openbot:${p.action}`, "state")
      continue
    }
    const inbound = f.source === "codex.rpc.in"
    // ------------------------------------------------ our responses to server requests
    if (!inbound) {
      if (p.method) {
        ledger.note(`>> ${p.method}`, "state")
        continue
      }
      const sr = serverReqs.get(String(p.id))
      if (!sr) {
        ledger.note(">> response(unknown)", "no-home")
        continue
      }
      let response: RuntimeResponse
      let allowed = true
      if (sr.kind === "command") {
        response = codexToDecision(p.result?.decision)
        allowed = response.type === "decision" && response.decision.startsWith("allow")
      } else if (sr.kind === "elicitation") {
        allowed = p.result?.action === "accept"
        response = {
          type: "decision",
          decision: allowed ? "allow-once" : p.result?.action === "cancel" ? "cancel" : "deny",
        }
      } else
        response = {
          type: "answers",
          answers: Object.fromEntries(
            Object.entries(p.result?.answers ?? {}).map(([k, v]: [string, any]) => [k, v?.answers ?? []]),
          ),
        }
      em.upsertRequest(f, sr.requestKey, (prev) => ({
        ...prev!,
        status: "resolved",
        response,
        resolvedAt: em.at(f),
        resolvedBy: em.userAuthor,
      }))
      em.upsertEntry<"card">(f, `card:${sr.requestKey}`, (prev) => ({
        ...prev!,
        state: { status: "resolved", response },
      }))
      if (sr.toolKey && em.hasEntry(sr.toolKey))
        em.upsertEntry<"tool-call">(f, sr.toolKey, (prev) => ({ ...prev!, status: allowed ? "running" : "declined" }))
      setTurn({ status: "running" })
      ledger.note(`>> response(${sr.kind})`, "mapped")
      continue
    }
    // ------------------------------------------------ responses to our requests
    if (p.method === undefined) {
      ledger.note("<< response", "state", "initialize/thread/start/turn/start results (native ids)")
      continue
    }
    const m: string = p.method
    const q = p.params ?? {}
    // ------------------------------------------------ server -> client requests (have an id)
    if (p.id !== undefined) {
      const requestKey = `codex-req:${p.id}`
      const cardKey = `card:${requestKey}`
      let kind: RuntimeRequestKind
      let title: string
      let card: any
      let capability: RuntimeRequest["responseCapability"]
      let toolKey: string | undefined
      let questions: Question[] | undefined
      const requestId = em.requestId(requestKey)
      if (m === "item/commandExecution/requestApproval" || m === "item/fileChange/requestApproval") {
        kind = m.includes("fileChange") ? "file-approval" : "command-approval"
        toolKey = `item:${q.itemId}`
        title = kind === "command-approval" ? "Run this command?" : "Apply these file changes?"
        // availableDecisions is NOT exhaustive: 0.162.1 offered [accept, acceptWithExecpolicyAmendment, cancel]
        // yet accepted "decline" (fixture turn C -> item status "declined", turn continued). Always offer deny.
        const offered: DecisionOption[] = (
          q.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"]
        ).map(decisionFromCodex)
        const options = offered.some((o) => o.id === "deny") ? offered : [...offered, decisionFromCodex("decline")]
        capability = { type: "decision", options, allowMessage: false }
        card = {
          type: "approval",
          requestId,
          title,
          ...(q.command ? { command: q.command } : {}),
          ...(q.cwd ? { cwd: q.cwd } : {}),
          ...(q.reason ? { reason: q.reason } : {}),
          toolName: "exec_command",
        }
        serverReqs.set(String(p.id), { requestKey, kind: "command", toolKey })
      } else if (m === "mcpServer/elicitation/request" && q._meta?.codex_approval_kind === "mcp_tool_call") {
        kind = "mcp-approval"
        // GAP: the elicitation carries no itemId; correlate with the in-flight mcpToolCall by server + params.
        const match = [...mcpRunning]
          .reverse()
          .find(
            (r) => r.server === q.serverName && JSON.stringify(r.args) === JSON.stringify(q._meta?.tool_params ?? {}),
          )
        toolKey = match?.key
        title = q.message ?? `Allow ${q.serverName}?`
        const persist: string[] = q._meta?.persist ?? []
        capability = {
          type: "decision",
          options: [
            { id: "allow-once", label: "Allow once", native: { action: "accept" } },
            ...(persist.includes("session")
              ? [
                  {
                    id: "allow-session" as const,
                    label: "Allow for this chat",
                    native: { action: "accept", _meta: { persist: "session" } },
                  },
                ]
              : []),
            ...(persist.includes("always")
              ? [
                  {
                    id: "allow-always" as const,
                    label: "Always allow",
                    native: { action: "accept", _meta: { persist: "always" } },
                  },
                ]
              : []),
            { id: "deny", label: "Deny", native: { action: "decline" } },
          ],
          allowMessage: false,
        }
        card = {
          type: "approval",
          requestId,
          title,
          toolName: match?.tool ?? "mcp",
          summary: q._meta?.tool_description ?? "",
        }
        serverReqs.set(String(p.id), { requestKey, kind: "elicitation", ...(toolKey ? { toolKey } : {}) })
      } else if (m === "item/tool/requestUserInput") {
        kind = "question"
        title = "Question"
        questions = (q.questions ?? []).map((x: any) => ({
          id: x.id,
          header: x.header,
          prompt: x.question,
          options: (x.options ?? []).map((o: any) => ({
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          multiSelect: false,
          allowFreeText: !!x.isOther,
          ...(x.isSecret ? { isSecret: true } : {}),
        }))
        capability = { type: "answers", questions: questions! }
        card = { type: "question", requestId, questions }
        serverReqs.set(String(p.id), { requestKey, kind: "userInput", questions: questions! })
      } else {
        ledger.note(`<< request ${m}`, "no-home")
        continue
      }
      const cardEntry = em.upsertEntry<"card">(f, cardKey, () => ({
        kind: "card",
        turnId: turn(),
        card,
        state: { status: "pending" },
      }))
      const toolEntryId = toolKey && em.hasEntry(toolKey) ? em.entryId(toolKey) : undefined
      em.upsertRequest(f, requestKey, (_prev, id): RuntimeRequest => ({
        id,
        conversationId: ctx.conversationId,
        botId: ctx.botId,
        turnId: turn(),
        cardEntryId: cardEntry.id,
        kind,
        status: "pending",
        title,
        subject: {
          ...(toolEntryId ? { toolCallEntryId: toolEntryId } : {}),
          ...(q.command ? { command: q.command } : {}),
          ...(q.cwd ? { cwd: q.cwd } : {}),
          ...(q.reason ? { reason: q.reason } : {}),
          ...(q.serverName ? { server: q.serverName } : {}),
          ...(q._meta?.tool_params ? { input: q._meta.tool_params } : {}),
        },
        responseCapability: capability,
        source: { origin: "codex", method: m, nativeRequestId: String(p.id) },
        blocking: true,
        createdAt: em.at(f),
      }))
      if (toolEntryId)
        em.upsertEntry<"tool-call">(f, toolKey!, (prev) => ({ ...prev!, status: "awaiting-approval", requestId }))
      setTurn({ status: "waiting" })
      ledger.note(`<< request ${m}`, "mapped")
      continue
    }
    // ------------------------------------------------ notifications
    const item = q.item
    const itemKey = item ? `item:${item.id}` : `item:${q.itemId}`
    switch (m) {
      case "turn/started":
        setTurn({ status: "running", harnessRef: { harness: "codex", nativeId: q.turn.id } })
        ledger.note(m, "mapped")
        break
      case "turn/completed": {
        const st: string = q.turn.status
        const status = st === "completed" ? "completed" : st === "interrupted" ? "interrupted" : "failed"
        em.finalizeStreaming(f, turn(), status === "interrupted")
        if (status !== "completed")
          em.upsertEntry<"notice">(
            f,
            `notice:${turnKey}`,
            () => ({
              kind: "notice",
              level: status === "interrupted" ? "info" : "error",
              code:
                status === "interrupted"
                  ? "interrupted"
                  : q.turn.error?.codexErrorInfo
                    ? JSON.stringify(q.turn.error.codexErrorInfo)
                    : "turn-failed",
              text: status === "interrupted" ? "Stopped." : (q.turn.error?.message ?? "The bot failed to respond."),
              turnId: turn(),
            }),
            { kind: "system" },
          )
        setTurn({
          status,
          endedAt: em.at(f),
          ...(usage ? { usage } : {}),
          ...(status === "failed"
            ? { failure: { code: "turn-failed", message: q.turn.error?.message ?? "", retryable: false } }
            : {}),
        })
        usage = undefined
        ledger.note(m, "mapped")
        break
      }
      case "thread/status/changed": {
        const flags: string[] = q.status?.activeFlags ?? []
        if (q.status?.type === "active" && turnKey && em.turns.get(turn())?.status !== "completed") {
          const waiting = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")
          const cur = em.turns.get(turn())?.status
          if ((waiting && cur !== "waiting") || (!waiting && cur === "waiting"))
            setTurn({ status: waiting ? "waiting" : "running" })
        }
        ledger.note(m, "state", "authoritative 'needs approval' flag; mirrored into Turn.status + BotActivity")
        break
      }
      case "thread/tokenUsage/updated": {
        const t = q.tokenUsage?.total ?? {}
        usage = {
          inputTokens: t.inputTokens ?? 0,
          outputTokens: t.outputTokens ?? 0,
          cachedInputTokens: t.cachedInputTokens ?? 0,
        }
        ledger.note(m, "state", "folded into Turn.usage at turn end")
        break
      }
      case "item/started":
      case "item/completed": {
        const done = m === "item/completed"
        const t: string = item.type
        const ref = { harness: "codex" as const, nativeId: item.id }
        if (t === "userMessage") {
          const user = em.entry<"message">(`user:nonce-${turnIndex}`)
          if (user && !done)
            em.upsertEntry<"message">(f, `user:nonce-${turnIndex}`, (prev) => ({
              ...prev!,
              delivery: "delivered",
              harnessRef: ref,
            }))
          ledger.note(`${m}:${t}`, done ? "state" : "mapped", "delivery ack for the OpenBot-created user message")
          break
        }
        if (t === "agentMessage") {
          em.upsertEntry<"message">(
            f,
            itemKey,
            (prev) =>
              ({
                ...(prev ?? { kind: "message", role: "bot", attachments: [], turnId: turn(), harnessRef: ref }),
                text: done ? item.text : (prev?.text ?? item.text ?? ""),
                streaming: !done,
                ...(item.phase === "commentary"
                  ? { phase: "commentary" }
                  : item.phase === "final_answer"
                    ? { phase: "final" }
                    : {}),
              }) as any,
          )
        } else if (t === "reasoning") {
          const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n\n")
          em.upsertEntry<"reasoning">(
            f,
            itemKey,
            (prev) =>
              ({
                ...(prev ?? { kind: "reasoning", source: "summary", turnId: turn(), harnessRef: ref }),
                text: done ? text : (prev?.text ?? ""),
                streaming: !done,
              }) as any,
          )
        } else if (t === "commandExecution") {
          const status: ToolCallStatus = !done
            ? (em.entry<"tool-call">(itemKey)?.status ?? "running")
            : item.status === "completed"
              ? "completed"
              : item.status === "declined"
                ? "declined"
                : "failed"
          em.upsertEntry<"tool-call">(
            f,
            itemKey,
            (prev) =>
              ({
                ...(prev ?? {
                  kind: "tool-call",
                  toolCallId: item.id,
                  name: "exec_command",
                  toolKind: "shell",
                  input: { command: item.command, cwd: item.cwd },
                  turnId: turn(),
                  startedAt: em.at(f),
                  harnessRef: ref,
                }),
                status,
                command: {
                  command: item.command,
                  ...(item.cwd ? { cwd: item.cwd } : {}),
                  ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
                },
                ...(done ? { completedAt: em.at(f) } : {}),
                ...(done && item.aggregatedOutput != null ? { output: { text: item.aggregatedOutput } } : {}),
              }) as any,
          )
        } else if (t === "mcpToolCall") {
          if (!done) mcpRunning.push({ key: itemKey, server: item.server, tool: item.tool, args: item.arguments })
          const r = item.result
          em.upsertEntry<"tool-call">(
            f,
            itemKey,
            (prev) =>
              ({
                ...(prev ?? {
                  kind: "tool-call",
                  toolCallId: item.id,
                  name: `mcp__${item.server}__${item.tool}`,
                  toolKind: "mcp",
                  mcp: { server: item.server, tool: item.tool },
                  input: item.arguments ?? {},
                  turnId: turn(),
                  startedAt: em.at(f),
                  harnessRef: ref,
                }),
                status: !done ? (prev?.status ?? "running") : item.status === "completed" ? "completed" : "failed",
                ...(done ? { completedAt: em.at(f) } : {}),
                ...(done && r
                  ? {
                      output: {
                        text: (r.content ?? []).map((c: any) => c.text ?? `[${c.type}]`).join(""),
                        ...(r.structuredContent != null ? { structured: r.structuredContent } : {}),
                      },
                    }
                  : {}),
                ...(done && item.error
                  ? { error: typeof item.error === "string" ? item.error : JSON.stringify(item.error) }
                  : {}),
              }) as any,
          )
        } else {
          ledger.note(`${m}:${t}`, "no-home")
          break
        }
        ledger.note(`${m}:${t}`, "mapped")
        break
      }
      case "item/agentMessage/delta":
        em.upsertEntry<"message">(f, itemKey, (prev) => ({ ...prev!, text: prev!.text + q.delta }))
        ledger.note(m, "mapped")
        break
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        em.upsertEntry<"reasoning">(f, itemKey, (prev) => ({ ...prev!, text: prev!.text + q.delta }))
        ledger.note(m, "mapped")
        break
      case "item/reasoning/summaryPartAdded":
        if ((q.summaryIndex ?? 0) > 0)
          em.upsertEntry<"reasoning">(f, itemKey, (prev) => ({ ...prev!, text: prev!.text + "\n\n" }))
        ledger.note(m, "state")
        break
      case "serverRequest/resolved": {
        const sr = serverReqs.get(String(q.requestId))
        if (sr && em.requests.get(em.requestId(sr.requestKey))?.status === "pending") {
          em.upsertRequest(f, sr.requestKey, (prev) => ({ ...prev!, status: "cancelled", resolvedAt: em.at(f) }))
          em.upsertEntry<"card">(f, `card:${sr.requestKey}`, (prev) => ({ ...prev!, state: { status: "cancelled" } }))
          ledger.note(m, "mapped")
        } else ledger.note(m, "state", "confirms our answer; cancels a still-pending card on interrupt/turn end")
        break
      }
      case "thread/started":
        ledger.note(m, "state", "native thread id -> bot session binding")
        break
      case "mcpServer/startupStatus/updated":
        ledger.note(m, "no-home", "per-bot tool health; proposal: Bot runtime status / connectors.list status")
        break
      case "account/rateLimits/updated":
        ledger.note(m, "no-home", "account plan limits; proposal: host.status harness limits")
        break
      case "thread/settings/updated":
        ledger.note(m, "no-home", "thread settings echo (model/collaboration mode); proposal: bot runtime status")
        break
      case "remoteControl/status/changed":
        ledger.note(m, "no-home", "Codex remote-control feature; leaks host name")
        break
      default:
        ledger.note(m, "no-home")
    }
  }
  return { em, ledger }
}
