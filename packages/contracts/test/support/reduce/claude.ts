// TEST HELPER ONLY (fixture reducers): adapters own the real normalizers (HarnessEvent). Ported from vendor/scratch/contracts/src/reduce.
// Claude Agent SDK frames (SDKMessage + canUseTool calls) -> OpenBot conversation changes.
// Identity rules from sdk-claude.md §14: text/thinking = api message id + block index; tools = tool_use id.
// Research scratch.
import type { RequestId, TurnId } from "../../../src/index.ts"
import type {
  DecisionOption,
  Question,
  RuntimeRequest,
  RuntimeRequestKind,
  RuntimeResponse,
} from "../../../src/index.ts"
import { defaultCtx, Emitter, type Frame, Ledger, openbotSend, toolKindFor } from "./kit.ts"

export const reduceClaude = (frames: ReadonlyArray<Frame>, ctx = defaultCtx("claude")) => {
  const em = new Emitter(ctx)
  const ledger = new Ledger()
  let turnIndex = -1
  let turnKey = ""
  let apiMsgId = ""
  const blockAt = new Map<number, { kind: "thinking" | "text" | "tool_use"; key: string; toolUseId?: string }>()
  const framesPerMsg = new Map<string, number>()
  const toolKeyById = new Map<string, string>()
  const pendingByToolUse = new Map<string, { requestKey: string; askUser: boolean }>()
  const denied = new Set<string>()
  const turn = (): TurnId => em.turnId(turnKey)

  const setTurn = (status: "running" | "waiting") => em.upsertTurn(turnKey, (prev, id) => ({ ...prev!, id, status }))

  for (const f of frames) {
    const p = f.payload
    if (f.source === "openbot.control") {
      if (p.action === "send") {
        turnIndex++
        turnKey = `claude-turn-${turnIndex}`
        openbotSend(em, f, turnKey, p.text, `nonce-${turnIndex}`)
        ledger.note("openbot:send", "mapped")
      } else ledger.note(`openbot:${p.action}`, "state")
      continue
    }

    if (f.source === "claude.canUseTool") {
      const toolUseId: string = p.options.toolUseID
      const askUser = p.toolName === "AskUserQuestion"
      const requestKey = `cc-req:${p.options.requestId}`
      pendingByToolUse.set(toolUseId, { requestKey, askUser })
      const toolEntry = em.entry<"tool-call">(toolKeyById.get(toolUseId) ?? `tool:${toolUseId}`)
      const requestId = em.requestId(requestKey)
      const cardKey = `card:${requestKey}`
      const kind: RuntimeRequestKind = askUser
        ? "question"
        : p.toolName === "Bash"
          ? "command-approval"
          : ["Write", "Edit", "NotebookEdit"].includes(p.toolName)
            ? "file-approval"
            : "tool-approval"
      const questions: Question[] = askUser
        ? (p.input.questions ?? []).map((q: any) => ({
            id: q.question,
            header: q.header,
            prompt: q.question,
            options: (q.options ?? []).map((o: any) => ({
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            multiSelect: !!q.multiSelect,
            allowFreeText: true,
          }))
        : []
      const decisions: DecisionOption[] = [
        { id: "allow-once", label: "Allow once" },
        ...((p.options.suggestions ?? []).length > 0 && !p.options.suppressAlwaysAllowRule
          ? [{ id: "allow-session" as const, label: "Allow for this chat", native: p.options.suggestions }]
          : []),
        { id: "deny", label: "Deny" },
      ]
      const title = askUser ? "Question" : (p.options.title ?? `Allow ${p.options.displayName ?? p.toolName}?`)
      const card = em.upsertEntry<"card">(f, cardKey, () => ({
        kind: "card",
        turnId: turn(),
        card: askUser
          ? { type: "question", requestId, questions }
          : {
              type: "approval",
              requestId,
              title,
              ...(p.options.description ? { summary: p.options.description } : {}),
              toolName: p.toolName,
              ...(typeof p.input.command === "string" ? { command: p.input.command } : {}),
              ...(p.options.decisionReason ? { reason: p.options.decisionReason } : {}),
            },
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
        subject: {
          toolName: p.toolName,
          input: p.input,
          ...(toolEntry ? { toolCallEntryId: toolEntry.id } : {}),
          ...(typeof p.input.command === "string" ? { command: p.input.command } : {}),
          ...(typeof p.input.file_path === "string" ? { paths: [p.input.file_path] } : {}),
        },
        responseCapability: askUser
          ? { type: "answers", questions }
          : { type: "decision", options: decisions, allowMessage: true },
        source: { origin: "claude", method: "canUseTool", nativeRequestId: p.options.requestId },
        blocking: true,
        createdAt: em.at(f),
      }))
      if (toolEntry)
        em.upsertEntry<"tool-call">(f, toolKeyById.get(toolUseId)!, (prev) => ({
          ...prev!,
          status: "awaiting-approval",
          requestId,
        }))
      setTurn("waiting")
      ledger.note(`canUseTool:${askUser ? "AskUserQuestion" : "tool"}`, "mapped")
      continue
    }

    if (f.source === "claude.canUseTool.response") {
      const pending = pendingByToolUse.get(p.toolUseID)
      if (!pending) {
        ledger.note("canUseTool.response:orphan", "no-home")
        continue
      }
      const allow = p.result.behavior === "allow"
      const response: RuntimeResponse = pending.askUser
        ? {
            type: "answers",
            answers: Object.fromEntries(
              Object.entries(p.result.updatedInput?.answers ?? {}).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.map(String) : String(v).split(", "),
              ]),
            ),
          }
        : allow
          ? { type: "decision", decision: "allow-once" }
          : { type: "decision", decision: "deny", ...(p.result.message ? { message: p.result.message } : {}) }
      const req = em.upsertRequest(f, pending.requestKey, (prev) => ({
        ...prev!,
        status: "resolved",
        response,
        resolvedAt: em.at(f),
        resolvedBy: em.userAuthor,
      }))
      em.upsertEntry<"card">(f, `card:${pending.requestKey}`, (prev) => ({
        ...prev!,
        state: { status: "resolved", response },
      }))
      const toolKey = toolKeyById.get(p.toolUseID)
      if (toolKey)
        em.upsertEntry<"tool-call">(f, toolKey, (prev) => ({
          ...prev!,
          status: allow ? "running" : "declined",
          requestId: req.id as RequestId,
        }))
      if (!allow) denied.add(p.toolUseID)
      setTurn("running")
      ledger.note("canUseTool.response", "mapped")
      continue
    }

    // ---------------------------------------------------------------- SDKMessage
    const key = `${p.type}${p.subtype ? "/" + p.subtype : ""}`
    switch (p.type) {
      case "system": {
        if (p.subtype === "init") {
          em.upsertTurn(turnKey, (prev, id) => ({
            ...prev!,
            id,
            harnessRef: { harness: "claude", nativeId: p.session_id },
          }))
          ledger.note(
            key,
            "mapped",
            "session id -> Turn.harnessRef; tools/mcp_servers -> bot runtime status (not in conversation)",
          )
        } else if (p.subtype === "status")
          ledger.note(key, "elsewhere", "BotActivity (requesting=thinking, compacting)")
        else ledger.note(key, "no-home")
        break
      }
      case "stream_event": {
        const ev = p.event
        const evKey = `stream_event:${ev.type}${ev.delta?.type ? ":" + ev.delta.type : ""}${ev.content_block?.type ? ":" + ev.content_block.type : ""}`
        if (p.parent_tool_use_id) {
          ledger.note(`${evKey}(subagent)`, "no-home")
          break
        }
        if (ev.type === "message_start") {
          apiMsgId = ev.message.id
          blockAt.clear()
          ledger.note(evKey, "state")
          break
        }
        if (ev.type === "content_block_start") {
          const cb = ev.content_block
          const i: number = ev.index
          if (cb.type === "thinking") {
            const k = `cc:${apiMsgId}:${i}`
            blockAt.set(i, { kind: "thinking", key: k })
            em.upsertEntry<"reasoning">(f, k, () => ({
              kind: "reasoning",
              text: "",
              streaming: true,
              source: "thinking",
              turnId: turn(),
              harnessRef: { harness: "claude", nativeId: `${apiMsgId}:${i}` },
            }))
          } else if (cb.type === "text") {
            const k = `cc:${apiMsgId}:${i}`
            blockAt.set(i, { kind: "text", key: k })
            em.upsertEntry<"message">(f, k, () => ({
              kind: "message",
              role: "bot",
              text: "",
              attachments: [],
              streaming: true,
              turnId: turn(),
              harnessRef: { harness: "claude", nativeId: `${apiMsgId}:${i}` },
            }))
          } else if (cb.type === "tool_use") {
            const k = `tool:${cb.id}`
            blockAt.set(i, { kind: "tool_use", key: k, toolUseId: cb.id })
            toolKeyById.set(cb.id, k)
            em.upsertEntry<"tool-call">(f, k, () => ({
              kind: "tool-call",
              toolCallId: cb.id,
              name: cb.name,
              toolKind: toolKindFor(cb.name),
              status: "pending",
              input: {},
              turnId: turn(),
              startedAt: em.at(f),
              harnessRef: { harness: "claude", nativeId: cb.id },
              ...(cb.name.startsWith("mcp__")
                ? { mcp: { server: cb.name.split("__")[1] ?? "", tool: cb.name.split("__").slice(2).join("__") } }
                : {}),
            }))
          } else {
            ledger.note(evKey, "no-home")
            break
          }
          ledger.note(evKey, "mapped")
          break
        }
        if (ev.type === "content_block_delta") {
          const b = blockAt.get(ev.index)
          const d = ev.delta
          if (b && d.type === "thinking_delta")
            em.upsertEntry<"reasoning">(f, b.key, (prev) => ({ ...prev!, text: prev!.text + d.thinking }))
          else if (b && d.type === "text_delta")
            em.upsertEntry<"message">(f, b.key, (prev) => ({ ...prev!, text: prev!.text + d.text }))
          else if (d.type === "input_json_delta") {
            ledger.note(evKey, "state", "partial tool input; final input taken from the assistant frame")
            break
          } else {
            ledger.note(
              evKey,
              "no-home",
              d.type === "signature_delta" ? "opaque thinking signature (harness-internal)" : "",
            )
            break
          }
          ledger.note(evKey, "mapped")
          break
        }
        ledger.note(evKey, "state", "block/message boundaries + per-call usage")
        break
      }
      case "assistant": {
        if (p.parent_tool_use_id) {
          ledger.note("assistant(subagent)", "no-home", "subagent transcript; would nest under the Agent tool-call")
          break
        }
        const id: string = p.message.id
        const k = framesPerMsg.get(id) ?? 0
        framesPerMsg.set(id, k + 1)
        const block = p.message.content[0]
        // k-th frame for a message id = content block k (sdk-claude.md §14, observed)
        const entryKey = block?.type === "tool_use" ? `tool:${block.id}` : `cc:${id}:${k}`
        if (block?.type === "thinking")
          em.upsertEntry<"reasoning">(
            f,
            entryKey,
            (prev) =>
              ({
                ...(prev ?? { kind: "reasoning", source: "thinking", turnId: turn() }),
                text: block.thinking,
                streaming: false,
              }) as any,
          )
        else if (block?.type === "text")
          em.upsertEntry<"message">(
            f,
            entryKey,
            (prev) =>
              ({
                ...(prev ?? { kind: "message", role: "bot", attachments: [], turnId: turn() }),
                text: block.text,
                streaming: false,
                ...(p.aborted ? { aborted: true } : {}),
              }) as any,
          )
        else if (block?.type === "tool_use") {
          toolKeyById.set(block.id, entryKey)
          em.upsertEntry<"tool-call">(f, entryKey, (prev) => ({
            ...prev!,
            input: block.input,
            status: prev!.status === "pending" ? "running" : prev!.status,
          }))
        } else {
          ledger.note(`assistant:${block?.type}`, "no-home")
          break
        }
        ledger.note(`assistant:${block.type}`, "mapped")
        break
      }
      case "user": {
        const content = Array.isArray(p.message?.content) ? p.message.content : []
        let handled = false
        for (const b of content) {
          if (b.type === "tool_result") {
            handled = true
            const tk = toolKeyById.get(b.tool_use_id)
            if (!tk) continue
            const text =
              typeof b.content === "string"
                ? b.content
                : (b.content ?? []).map((c: any) => c.text ?? `[${c.type}]`).join("")
            const status = denied.has(b.tool_use_id) ? "declined" : b.is_error ? "failed" : "completed"
            em.upsertEntry<"tool-call">(f, tk, (prev) => ({
              ...prev!,
              status,
              output: { text, ...(p.tool_use_result !== undefined ? { structured: p.tool_use_result } : {}) },
              ...(b.is_error ? { error: text } : {}),
              completedAt: em.at(f),
            }))
            ledger.note("user:tool_result", "mapped")
          } else if (b.type === "text" && /^\[Request interrupted/.test(b.text)) {
            handled = true
            ledger.note(
              "user:text[Request interrupted by user]",
              "no-home",
              "synthetic echo of the interrupt; represented by Turn.status=interrupted + notice",
            )
          }
        }
        if (!handled) ledger.note("user:other", "no-home")
        break
      }
      case "result": {
        const interrupted = typeof p.terminal_reason === "string" && p.terminal_reason.startsWith("aborted")
        const status = p.subtype === "success" && !p.is_error ? "completed" : interrupted ? "interrupted" : "failed"
        em.finalizeStreaming(f, turn(), interrupted)
        if (status !== "completed") {
          em.upsertEntry<"notice">(
            f,
            `notice:${turnKey}`,
            () => ({
              kind: "notice",
              level: status === "interrupted" ? "info" : "error",
              code: status === "interrupted" ? "interrupted" : p.subtype,
              text: status === "interrupted" ? "Stopped." : (p.errors ?? []).join("; ") || "The bot failed to respond.",
              turnId: turn(),
            }),
            { kind: "system" },
          )
        }
        em.upsertTurn(turnKey, (prev, id) => ({
          ...prev!,
          id,
          status,
          endedAt: em.at(f),
          usage: {
            inputTokens: p.usage?.input_tokens ?? 0,
            outputTokens: p.usage?.output_tokens ?? 0,
            ...(p.usage?.cache_read_input_tokens !== undefined
              ? { cachedInputTokens: p.usage.cache_read_input_tokens }
              : {}),
            ...(typeof p.total_cost_usd === "number" ? { costUsd: p.total_cost_usd } : {}),
          },
          ...(status === "failed"
            ? { failure: { code: p.subtype, message: (p.errors ?? []).join("; "), retryable: false } }
            : {}),
        }))
        ledger.note(key, "mapped")
        break
      }
      case "rate_limit_event":
        ledger.note(key, "no-home", "subscription rate-limit meter; proposal: host.status harness limits")
        break
      default:
        ledger.note(key, "no-home")
    }
  }
  return { em, ledger }
}
