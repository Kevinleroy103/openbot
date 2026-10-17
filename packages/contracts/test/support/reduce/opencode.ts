// TEST HELPER ONLY (fixture reducers): adapters own the real normalizers (HarnessEvent). Ported from vendor/scratch/contracts/src/reduce.
// OpenCode v2 server SSE events (+ our replies) -> OpenBot conversation changes. Research scratch.
import type { TurnId } from "../../../src/index.ts"
import type { Question, RuntimeRequest, RuntimeRequestKind, RuntimeResponse } from "../../../src/index.ts"
import { defaultCtx, Emitter, type Frame, Ledger, openbotSend, toolKindFor } from "./kit.ts"

const HOST_EVENTS = new Set([
  "mcp.status.changed", "mcp.resources.changed", "integration.updated", "provider.updated", "model.updated", "vcs.branch.updated",
  "agent.updated", "command.updated", "skill.updated", "websearch.updated", "reference.updated", "plugin.updated", "config.updated",
])

export const reduceOpenCode = (frames: ReadonlyArray<Frame>, ctx = defaultCtx("opencode"), mcpServers: ReadonlyArray<string> = ["openbot"]) => {
  const em = new Emitter(ctx)
  const ledger = new Ledger()
  let turnIndex = -1
  let turnKey = ""
  const turn = (): TurnId => em.turnId(turnKey)
  const setTurn = (patch: Record<string, unknown>) => em.upsertTurn(turnKey, (prev, id) => ({ ...prev!, id, ...patch }) as any)
  const declinedTools = new Set<string>()
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0 }
  const partKey = (d: any, kind: string) => `oc:${kind}:${d.assistantMessageID}:${d.ordinal}`
  const toolKey = (id: string) => `tool:${id}`

  for (const f of frames) {
    const p = f.payload
    if (f.source === "openbot.control") {
      if (p.action === "send") {
        turnIndex++
        turnKey = `opencode-turn-${turnIndex}`
        openbotSend(em, f, turnKey, p.text, `nonce-${turnIndex}`)
        usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0 }
        ledger.note("openbot:send", "mapped")
      } else ledger.note(`openbot:${p.action}`, "state")
      continue
    }
    const type: string = p.type
    const d = p.data ?? {}
    if (HOST_EVENTS.has(type)) { ledger.note(type, "no-home", "host/catalog change; proposal: roster/host status, not the conversation"); continue }
    switch (type) {
      case "session.inbox.enqueued":
      case "session.inbox.delivered": {
        const k = `user:nonce-${turnIndex}`
        if (em.hasEntry(k))
          em.upsertEntry<"message">(f, k, (prev) => ({ ...prev!, delivery: type.endsWith("delivered") ? "delivered" : "accepted", harnessRef: { harness: "opencode", nativeId: d.inboxID } }))
        ledger.note(type, "mapped", "delivery ack for the OpenBot-created user message")
        break
      }
      case "session.execution.started":
        setTurn({ status: "running" })
        ledger.note(type, "mapped")
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const status = type.endsWith("succeeded") ? "completed" : type.endsWith("interrupted") ? "interrupted" : "failed"
        em.finalizeStreaming(f, turn(), status === "interrupted")
        if (status !== "completed")
          em.upsertEntry<"notice">(f, `notice:${turnKey}`, () => ({
            kind: "notice",
            level: status === "interrupted" ? "info" : "error",
            code: status === "interrupted" ? `interrupted:${d.reason ?? "user"}` : (d.error?.type ?? "turn-failed"),
            text: status === "interrupted" ? "Stopped." : (d.error?.message ?? "The bot failed to respond."),
            turnId: turn(),
          }), { kind: "system" })
        setTurn({ status, endedAt: em.at(f), usage: { ...usage }, ...(status === "failed" ? { failure: { code: d.error?.type ?? "turn-failed", message: d.error?.message ?? "", retryable: false } } : {}) })
        ledger.note(type, "mapped")
        break
      }
      case "session.step.started":
        ledger.note(type, "state", "assistantMessageID + agent/model of this step")
        break
      case "session.step.ended":
        usage = {
          inputTokens: usage.inputTokens + (d.tokens?.input ?? 0),
          outputTokens: usage.outputTokens + (d.tokens?.output ?? 0),
          cachedInputTokens: usage.cachedInputTokens + (d.tokens?.cache?.read ?? 0),
          reasoningTokens: usage.reasoningTokens + (d.tokens?.reasoning ?? 0),
          costUsd: usage.costUsd + (d.cost ?? 0),
        }
        ledger.note(type, "state", "per-step usage folded into Turn.usage")
        break
      case "session.step.failed": {
        // text.ended arrives BEFORE the abort, so mark this step's bot text as cut short here.
        if (d.error?.type === "aborted")
          for (const e of [...em.entries.values()])
            if (e.kind === "message" && e.role === "bot" && e.harnessRef?.nativeId.startsWith(`${d.assistantMessageID}:`))
              em.upsertEntry<"message">(f, partKey({ assistantMessageID: d.assistantMessageID, ordinal: e.harnessRef.nativeId.split(":")[1] }, "text"), (prev) => ({ ...prev!, aborted: true, streaming: false }))
        ledger.note(type, "mapped", "aborted step -> bot message aborted; execution.* terminal sets Turn.status")
        break
      }
      case "session.text.started":
        em.upsertEntry<"message">(f, partKey(d, "text"), () => ({ kind: "message", role: "bot", text: "", attachments: [], streaming: true, turnId: turn(), harnessRef: { harness: "opencode", nativeId: `${d.assistantMessageID}:${d.ordinal}` } }))
        ledger.note(type, "mapped")
        break
      case "session.text.delta":
        em.upsertEntry<"message">(f, partKey(d, "text"), (prev) => ({ ...prev!, text: prev!.text + d.delta }))
        ledger.note(type, "mapped")
        break
      case "session.text.ended":
        em.upsertEntry<"message">(f, partKey(d, "text"), (prev) => ({ ...prev!, text: d.text, streaming: false }))
        ledger.note(type, "mapped")
        break
      case "session.reasoning.started":
        em.upsertEntry<"reasoning">(f, partKey(d, "reasoning"), () => ({ kind: "reasoning", text: "", streaming: true, source: "thinking", turnId: turn(), harnessRef: { harness: "opencode", nativeId: `${d.assistantMessageID}:r${d.ordinal}` } }))
        ledger.note(type, "mapped")
        break
      case "session.reasoning.delta":
        em.upsertEntry<"reasoning">(f, partKey(d, "reasoning"), (prev) => ({ ...prev!, text: prev!.text + d.delta }))
        ledger.note(type, "mapped")
        break
      case "session.reasoning.ended":
        em.upsertEntry<"reasoning">(f, partKey(d, "reasoning"), (prev) => ({ ...prev!, text: d.text, streaming: false }))
        ledger.note(type, "mapped")
        break
      case "session.tool.input.started": {
        const name: string = d.name
        const kind = toolKindFor(name, mcpServers)
        const server = kind === "mcp" ? mcpServers.find((s) => name.startsWith(`${s}_`)) : undefined
        em.upsertEntry<"tool-call">(f, toolKey(d.id), () => ({
          kind: "tool-call",
          toolCallId: d.id,
          name,
          toolKind: kind,
          status: "pending",
          input: {},
          turnId: turn(),
          startedAt: em.at(f),
          harnessRef: { harness: "opencode", nativeId: d.id },
          ...(server ? { mcp: { server, tool: name.slice(server.length + 1) } } : {}),
        }))
        ledger.note(type, "mapped")
        break
      }
      case "session.tool.input.delta":
      case "session.tool.input.ended":
        ledger.note(type, "state", "raw streamed tool-call JSON; parsed input arrives on tool.called")
        break
      case "session.tool.called":
        em.upsertEntry<"tool-call">(f, toolKey(d.id), (prev) => ({ ...prev!, input: d.input, status: prev!.status === "pending" ? "running" : prev!.status, ...(typeof d.input?.command === "string" ? { command: { command: d.input.command } } : {}) }))
        ledger.note(type, "mapped")
        break
      case "session.tool.progress":
        ledger.note(type, "state", "ephemeral metadata (e.g. shellID for a live PTY view)")
        break
      case "session.tool.success":
      case "session.tool.failed": {
        const ok = type.endsWith("success")
        const parts: any[] = d.content ?? []
        const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        const files = parts.filter((c) => c.type === "file").map((c) => ({ mime: c.mime ?? "application/octet-stream", url: c.uri }))
        em.upsertEntry<"tool-call">(f, toolKey(d.id), (prev) => ({
          ...prev!,
          status: ok ? "completed" : declinedTools.has(d.id) ? "declined" : "failed",
          completedAt: em.at(f),
          ...(text || files.length ? { output: { ...(text ? { text } : {}), ...(files.length ? { images: files } : {}), ...(d.metadata?.truncated ? { truncated: true } : {}) } } : {}),
          ...(!ok ? { error: d.error?.message ?? "failed" } : {}),
          ...(prev!.command && typeof d.metadata?.exit === "number" ? { command: { ...prev!.command, exitCode: d.metadata.exit } } : {}),
        }))
        ledger.note(type, "mapped")
        break
      }
      case "permission.asked": {
        const requestKey = `oc-perm:${d.id}`
        const toolId: string | undefined = d.source?.type === "tool" ? d.source.id : undefined
        const tool = toolId ? em.entry<"tool-call">(toolKey(toolId)) : undefined
        const kind: RuntimeRequestKind = d.action === "shell" ? "command-approval" : d.action === "edit" ? "file-approval" : "tool-approval"
        const diff: string | undefined = (d.metadata?.files ?? []).map((x: any) => x.patch).filter(Boolean).join("\n") || undefined
        const paths: string[] | undefined = d.action === "edit" ? d.resources : undefined
        const command = d.action === "shell" ? (tool?.command?.command ?? (d.resources ?? []).join(" && ")) : undefined
        const requestId = em.requestId(requestKey)
        const title = d.message ?? (kind === "command-approval" ? "Run this command?" : kind === "file-approval" ? "Apply these file changes?" : `Allow ${d.action}?`)
        const card = em.upsertEntry<"card">(f, `card:${requestKey}`, () => ({
          kind: "card",
          turnId: turn(),
          card: { type: "approval", requestId, title, toolName: tool?.name ?? d.action, ...(command ? { command } : {}), ...(diff ? { diff } : {}) },
          state: { status: "pending" },
        }))
        em.upsertRequest(f, requestKey, (_prev, id): RuntimeRequest => ({
          id,
          conversationId: ctx.conversationId,
          botId: ctx.botId,
          turnId: turn(),
          cardEntryId: card.id,
          kind,
          status: "pending",
          title,
          subject: { toolName: tool?.name ?? d.action, ...(tool ? { toolCallEntryId: tool.id } : {}), ...(command ? { command } : {}), ...(diff ? { diff } : {}), ...(paths ? { paths } : {}) },
          responseCapability: {
            type: "decision",
            options: [
              { id: "allow-once", label: "Allow once", native: "once" },
              { id: "allow-always", label: "Always allow", native: { decision: "always", save: d.save ?? [] } },
              { id: "deny", label: "Deny", native: "reject" },
            ],
            allowMessage: true,
          },
          source: { origin: "opencode", method: "permission.asked", nativeRequestId: d.id },
          blocking: true,
          createdAt: em.at(f),
        }))
        if (tool) em.upsertEntry<"tool-call">(f, toolKey(toolId!), (prev) => ({ ...prev!, status: "awaiting-approval", requestId }))
        setTurn({ status: "waiting" })
        ledger.note(type, "mapped")
        break
      }
      case "permission.replied": {
        const requestKey = `oc-perm:${d.requestID}`
        const reply: string = d.reply
        const response: RuntimeResponse = { type: "decision", decision: reply === "once" ? "allow-once" : reply === "always" ? "allow-always" : "deny" }
        const req = em.upsertRequest(f, requestKey, (prev) => ({ ...prev!, status: "resolved", response, resolvedAt: em.at(f), resolvedBy: em.userAuthor }))
        em.upsertEntry<"card">(f, `card:${requestKey}`, (prev) => ({ ...prev!, state: { status: "resolved", response } }))
        const toolEntryId = req.subject.toolCallEntryId
        const tool = toolEntryId ? em.entries.get(toolEntryId) : undefined
        if (tool && tool.kind === "tool-call") {
          if (reply === "reject") declinedTools.add(tool.toolCallId)
          em.upsertEntry<"tool-call">(f, toolKey(tool.toolCallId), (prev) => ({ ...prev!, status: reply === "reject" ? "declined" : "running" }))
        }
        setTurn({ status: "running" })
        ledger.note(type, "mapped")
        break
      }
      case "form.created": {
        const form = d.form ?? d
        const requestKey = `oc-form:${form.id}`
        const requestId = em.requestId(requestKey)
        const isQuestion = form.metadata?.kind === "question"
        const toolId: string | undefined = form.metadata?.tool?.id
        const tool = toolId ? em.entry<"tool-call">(toolKey(toolId)) : undefined
        const questions: Question[] = (form.fields ?? []).map((x: any) => ({
          id: x.key,
          ...(x.title ? { header: x.title } : {}),
          prompt: x.description ?? x.title ?? "",
          options: (x.options ?? []).map((o: any) => ({ label: o.label ?? String(o.value), ...(o.description ? { description: o.description } : {}) })),
          multiSelect: x.type === "multiselect",
          allowFreeText: x.custom === true,
        }))
        const card = em.upsertEntry<"card">(f, `card:${requestKey}`, () => ({
          kind: "card",
          turnId: turn(),
          card: isQuestion
            ? { type: "question", requestId, title: form.title, questions }
            : { type: "form", requestId, title: form.title ?? "Form", fields: (form.fields ?? []).map((x: any) => ({ key: x.key, label: x.title ?? x.key, ...(x.description ? { description: x.description } : {}), type: x.type === "multiselect" ? "multiselect" : x.options ? "select" : "string", required: x.required !== false })) },
          state: { status: "pending" },
        }))
        em.upsertRequest(f, requestKey, (_prev, id): RuntimeRequest => ({
          id,
          conversationId: ctx.conversationId,
          botId: ctx.botId,
          turnId: turn(),
          cardEntryId: card.id,
          kind: isQuestion ? "question" : "form",
          status: "pending",
          title: form.title ?? "Questions",
          subject: { ...(tool ? { toolCallEntryId: tool.id, toolName: tool.name } : {}) },
          responseCapability: isQuestion ? { type: "answers", questions } : { type: "form", fields: (card.card as any).fields },
          source: { origin: "opencode", method: "form.created", nativeRequestId: form.id },
          blocking: true,
          createdAt: em.at(f),
        }))
        if (tool) em.upsertEntry<"tool-call">(f, toolKey(toolId!), (prev) => ({ ...prev!, status: "awaiting-approval", requestId }))
        setTurn({ status: "waiting" })
        ledger.note(type, "mapped")
        break
      }
      case "form.replied":
      case "form.cancelled": {
        const requestKey = `oc-form:${d.id ?? d.formID}`
        const cancelled = type === "form.cancelled"
        const response: RuntimeResponse = cancelled
          ? { type: "dismiss", ...(d.message ? { reason: d.message } : {}) }
          : { type: "answers", answers: Object.fromEntries(Object.entries(d.answer ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : [String(v)]])) }
        const req = em.upsertRequest(f, requestKey, (prev) => ({ ...prev!, status: cancelled ? "cancelled" : "resolved", response, resolvedAt: em.at(f), resolvedBy: em.userAuthor }))
        em.upsertEntry<"card">(f, `card:${requestKey}`, (prev) => ({ ...prev!, state: { status: cancelled ? "dismissed" : "resolved", response } }))
        const toolEntryId = req.subject.toolCallEntryId
        const tool = toolEntryId ? em.entries.get(toolEntryId) : undefined
        if (tool && tool.kind === "tool-call") em.upsertEntry<"tool-call">(f, toolKey(tool.toolCallId), (prev) => ({ ...prev!, status: "running" }))
        setTurn({ status: "running" })
        ledger.note(type, "mapped")
        break
      }
      case "shell.created":
      case "shell.exited":
        ledger.note(type, "state", "process lifecycle of the shell tool (live terminal view); exit code also on tool.success")
        break
      case "session.usage.updated":
        ledger.note(type, "state", "session totals; per-turn usage comes from step.ended")
        break
      case "session.instructions.updated":
        ledger.note(type, "no-home", "hashes of injected prompt fragments (debug only)")
        break
      case "session.step.streamed":
        ledger.note(type, "no-home", "stream-progress marker without payload of interest")
        break
      default:
        ledger.note(type, "no-home")
    }
  }
  return { em, ledger }
}
