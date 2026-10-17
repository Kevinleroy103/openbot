/**
 * Codex server requests → `HarnessRequest` (for `OpenSessionInput.onRequest`) and the resolution →
 * the native reply (architecture §4.5 Codex "Server requests", D2.2, domain-contract.md §F.8).
 *
 * - `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 *   `item/permissions/requestApproval`, `mcpServer/elicitation/request` and
 *   `item/tool/requestUserInput` are asked; everything else is answered here.
 * - **Deny is always offered** even when Codex's `availableDecisions` omits it (0.162.1 accepted a
 *   `decline` that was not listed: sdk-codex.md §5 turn 3).
 * - "Always allow" is OpenBot's rule (D5.6, rules live on the brain), so it is answered natively
 *   as a one-off or session approval. OpenBot never asks Codex to persist approvals of its own
 *   (`acceptWithExecpolicyAmendment`, elicitation `persist: "always"`): a rule the user deletes in
 *   OpenBot must stop applying.
 */
import type { HarnessApprovalRequest, HarnessDecisionSuggestion, HarnessRequest, HarnessRequestResolution, NodeId, Question } from "@openbot/contracts"
import { isAnswersResolution } from "@openbot/contracts"
import { RpcErrorCodes } from "./errors.ts"
import { type CodexNormalizer, itemKeyOf, stripShellWrapper, truncate } from "./normalize.ts"
import type { RequestReply } from "./protocol.ts"

export type MappedRequest =
  | {
    readonly _tag: "Ask"
    readonly request: HarnessRequest
    /** Native result for the resolution (never throws). */
    readonly reply: (resolution: HarnessRequestResolution) => unknown
  }
  /** Answered without asking anyone. */
  | { readonly _tag: "Answer"; readonly reply: Exclude<RequestReply, symbol> }

export interface RequestContext {
  readonly normalizer: CodexNormalizer
  /** The OpenBot node a Codex environment id runs on (`undefined` = unknown/host). */
  readonly nodeIdForEnvironment: (environmentId: string | undefined) => NodeId | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

type Decision = HarnessDecisionSuggestion["decision"]

const decisionOf = (resolution: HarnessRequestResolution): Decision =>
  isAnswersResolution(resolution) ? "deny" : resolution.decision

const DEFAULT_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"]

/** Suggestions beyond allow-once / deny (which every approval card offers). */
const suggestionsFor = (offered: ReadonlyArray<unknown>): ReadonlyArray<HarnessDecisionSuggestion> => {
  const suggestions: Array<HarnessDecisionSuggestion> = []
  if (offered.includes("acceptForSession")) suggestions.push({ decision: "allow-session", label: "Allow for this chat" })
  if (offered.includes("cancel")) suggestions.push({ decision: "cancel", label: "Deny and stop" })
  return suggestions
}

/** Command / file-change decision for a resolution. */
const approvalDecision = (resolution: HarnessRequestResolution, offered: ReadonlyArray<unknown>): string => {
  switch (decisionOf(resolution)) {
    case "allow-once":
      return "accept"
    case "allow-session":
    case "allow-always":
      return offered.includes("acceptForSession") ? "acceptForSession" : "accept"
    case "deny":
      return "decline"
    case "cancel":
      return "cancel"
  }
}

const unsupported = (method: string): MappedRequest => ({
  _tag: "Answer",
  reply: { error: { code: RpcErrorCodes.methodNotFound, message: `OpenBot does not support ${method}.` } },
})

const commandApproval = (id: string, params: Record<string, unknown>, ctx: RequestContext): MappedRequest => {
  const native = str(params.turnId)
  const itemId = str(params.itemId)
  const raw = str(params.command) ?? ""
  const actions = Array.isArray(params.commandActions) ? params.commandActions.filter(isRecord) : []
  const display = actions.length === 1 && typeof actions[0]?.command === "string" ? actions[0].command : stripShellWrapper(raw)
  const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : DEFAULT_DECISIONS
  const cwd = str(params.cwd)
  const reason = str(params.reason)
  const nodeId = ctx.nodeIdForEnvironment(str(params.environmentId))
  const network = isRecord(params.networkApprovalContext)
  const request: HarnessApprovalRequest = {
    kind: "command-approval",
    toolName: "exec_command",
    title: network ? "Allow network access?" : "Run this command?",
    detail: reason ?? display,
    surface: network ? "network" : "shell",
    nativeRequestId: id,
    ...(native && itemId ? { toolKey: itemKeyOf(native, itemId) } : {}),
    ...(display ? { command: display } : {}),
    ...(cwd ? { cwd } : {}),
    ...(nodeId ? { nodeId } : {}),
    suggestions: suggestionsFor(offered),
  }
  return { _tag: "Ask", request, reply: (resolution) => ({ decision: approvalDecision(resolution, offered) }) }
}

const fileApproval = (id: string, params: Record<string, unknown>, ctx: RequestContext): MappedRequest => {
  const native = str(params.turnId)
  const itemId = str(params.itemId)
  const tool = native && itemId ? ctx.normalizer.toolInfo(native, itemId) : undefined
  const changes = tool?.fileChanges ?? []
  const paths = changes.map((change) => change.path)
  const diff = changes.map((change) => change.diff ?? "").filter((d) => d !== "").join("\n")
  const reason = str(params.reason)
  const grantRoot = str(params.grantRoot)
  const nodeId = ctx.nodeIdForEnvironment(undefined)
  const request: HarnessApprovalRequest = {
    kind: "file-approval",
    toolName: "apply_patch",
    title: grantRoot ? `Allow writing under ${grantRoot}?` : "Apply these file changes?",
    detail: reason ?? (paths.length > 0 ? paths.join(", ") : "Codex wants to edit files."),
    surface: "file-edit",
    nativeRequestId: id,
    ...(native && itemId ? { toolKey: itemKeyOf(native, itemId) } : {}),
    ...(paths.length > 0 ? { paths } : grantRoot ? { paths: [grantRoot] } : {}),
    ...(diff ? { diff: truncate(diff, 20_000) } : {}),
    ...(nodeId ? { nodeId } : {}),
    suggestions: suggestionsFor(DEFAULT_DECISIONS),
  }
  return { _tag: "Ask", request, reply: (resolution) => ({ decision: approvalDecision(resolution, DEFAULT_DECISIONS) }) }
}

const permissionsApproval = (id: string, params: Record<string, unknown>, ctx: RequestContext): MappedRequest => {
  const native = str(params.turnId)
  const itemId = str(params.itemId)
  const requested = isRecord(params.permissions) ? params.permissions : {}
  const network = isRecord(requested.network) ? requested.network : undefined
  const fileSystem = isRecord(requested.fileSystem) ? requested.fileSystem : undefined
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [])
  const writes = list(fileSystem?.write)
  const reads = list(fileSystem?.read)
  const parts: Array<string> = []
  if (network?.enabled === true) parts.push("network access")
  if (writes.length > 0) parts.push(`write access to ${writes.join(", ")}`)
  if (reads.length > 0) parts.push(`read access to ${reads.join(", ")}`)
  const summary = parts.length > 0 ? `Codex asks for ${parts.join(" and ")}.` : "Codex asks for extra permissions."
  const reason = str(params.reason)
  const cwd = str(params.cwd)
  const nodeId = ctx.nodeIdForEnvironment(str(params.environmentId))
  const request: HarnessApprovalRequest = {
    kind: "tool-approval",
    toolName: "request_permissions",
    title: "Grant extra permissions?",
    detail: reason ? `${reason}\n${summary}` : summary,
    surface: writes.length > 0 ? "file-edit" : network?.enabled === true ? "network" : "other",
    nativeRequestId: id,
    ...(native && itemId ? { toolKey: itemKeyOf(native, itemId) } : {}),
    ...(writes.length + reads.length > 0 ? { paths: [...writes, ...reads] } : {}),
    ...(cwd ? { cwd } : {}),
    ...(nodeId ? { nodeId } : {}),
    input: requested,
    suggestions: [{ decision: "allow-session", label: "Allow for this chat" }],
  }
  return {
    _tag: "Ask",
    request,
    reply: (resolution) => {
      const decision = decisionOf(resolution)
      if (decision === "deny" || decision === "cancel") return { permissions: {}, scope: "turn" }
      return {
        permissions: {
          ...(network ? { network } : {}),
          ...(fileSystem ? { fileSystem } : {}),
        },
        scope: decision === "allow-once" ? "turn" : "session",
      }
    },
  }
}

/** `requestedSchema` (MCP elicitation form) → questions. */
const formQuestions = (schema: unknown): ReadonlyArray<Question & { readonly valueType: string }> => {
  const record = isRecord(schema) ? schema : {}
  const properties = isRecord(record.properties) ? record.properties : {}
  const questions: Array<Question & { readonly valueType: string }> = []
  for (const [key, value] of Object.entries(properties)) {
    if (key === "") continue
    const prop = isRecord(value) ? value : {}
    const title = str(prop.title)
    const description = str(prop.description)
    const type = str(prop.type) ?? "string"
    const enumValues = Array.isArray(prop.enum) ? prop.enum.filter((v): v is string => typeof v === "string") : []
    const enumNames = Array.isArray(prop.enumNames) ? prop.enumNames : []
    const options = type === "boolean"
      ? [{ label: "Yes" }, { label: "No" }]
      : enumValues.map((v, i) => ({ label: typeof enumNames[i] === "string" ? (enumNames[i] as string) : v }))
    questions.push({
      id: key,
      ...(title ? { header: title } : {}),
      prompt: description ?? title ?? key,
      options,
      multiSelect: false,
      allowFreeText: options.length === 0,
      valueType: type,
    })
  }
  return questions
}

const coerceAnswer = (question: { readonly valueType: string; readonly options: ReadonlyArray<{ readonly label: string }> }, answer: string, enumValues: ReadonlyArray<string>): unknown => {
  if (question.valueType === "boolean") return answer === "Yes" || answer === "true"
  if (question.valueType === "number" || question.valueType === "integer") {
    const n = Number(answer)
    return Number.isFinite(n) ? n : answer
  }
  const index = question.options.findIndex((option) => option.label === answer)
  return index >= 0 && enumValues[index] !== undefined ? enumValues[index] : answer
}

const elicitation = (id: string, params: Record<string, unknown>, ctx: RequestContext): MappedRequest => {
  const server = str(params.serverName) ?? "mcp"
  const meta = isRecord(params._meta) ? params._meta : {}
  const message = str(params.message) ?? `The ${server} MCP server needs your input.`
  const mode = str(params.mode)
  const decline = { action: "decline", content: null, _meta: null }
  const cancel = { action: "cancel", content: null, _meta: null }

  if (meta.codex_approval_kind === "mcp_tool_call") {
    const toolParams = meta.tool_params
    const running = ctx.normalizer.runningMcp(server, toolParams)
    const tool = running?.tool ?? /tool "([^"]+)"/.exec(message)?.[1] ?? "tool"
    const persist = Array.isArray(meta.persist) ? meta.persist : []
    const request: HarnessApprovalRequest = {
      kind: "mcp-approval",
      toolName: `mcp__${server}__${tool}`,
      title: message,
      detail: str(meta.tool_description) ?? message,
      surface: "mcp",
      server,
      nativeRequestId: id,
      ...(running ? { toolKey: running.key } : {}),
      ...(toolParams !== undefined ? { input: toolParams } : {}),
      ...(persist.includes("session") ? { suggestions: [{ decision: "allow-session", label: "Allow for this chat" }] } : {}),
    }
    return {
      _tag: "Ask",
      request,
      reply: (resolution) => {
        switch (decisionOf(resolution)) {
          case "allow-once":
            return { action: "accept", content: {}, _meta: null }
          case "allow-session":
          case "allow-always":
            return { action: "accept", content: {}, _meta: persist.includes("session") ? { persist: "session" } : null }
          case "deny":
            return decline
          case "cancel":
            return cancel
        }
      },
    }
  }

  if (mode === "form") {
    const questions = formQuestions(params.requestedSchema)
    const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {}
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (questions.length === 0) {
      // A bare confirmation ("Allow …?") with nothing to fill in.
      const request: HarnessApprovalRequest = {
        kind: "mcp-approval",
        toolName: `mcp__${server}__elicitation`,
        title: message,
        detail: message,
        surface: "mcp",
        server,
        nativeRequestId: id,
      }
      return {
        _tag: "Ask",
        request,
        reply: (resolution) => {
          const decision = decisionOf(resolution)
          return decision === "deny" ? decline : decision === "cancel" ? cancel : { action: "accept", content: {}, _meta: null }
        },
      }
    }
    const request: HarnessRequest = {
      kind: "question",
      title: message,
      nativeRequestId: id,
      questions: questions.map(({ valueType: _valueType, ...question }) => question),
    }
    return {
      _tag: "Ask",
      request,
      reply: (resolution) => {
        if (!isAnswersResolution(resolution)) {
          const decision = resolution.decision
          return decision === "cancel" ? cancel : decision === "deny" ? decline : { action: "accept", content: {}, _meta: null }
        }
        const content: Record<string, unknown> = {}
        for (const question of questions) {
          const answer = resolution.answers[question.id]
          if (answer === undefined) continue
          const first = Array.isArray(answer) ? answer[0] : answer
          if (first === undefined) continue
          const prop = properties[question.id]
          const enumValues = isRecord(prop) && Array.isArray(prop.enum) ? prop.enum.filter((v): v is string => typeof v === "string") : []
          content[question.id] = coerceAnswer(question, first, enumValues)
        }
        return { action: "accept", content, _meta: null }
      },
    }
  }

  if (mode === "url") {
    const url = str(params.url) ?? ""
    const request: HarnessApprovalRequest = {
      kind: "mcp-approval",
      toolName: `mcp__${server}__elicitation`,
      title: message,
      detail: url ? `Open ${url} and approve when you are done.` : message,
      surface: "mcp",
      server,
      nativeRequestId: id,
      ...(url ? { input: { url } } : {}),
    }
    return {
      _tag: "Ask",
      request,
      reply: (resolution) => {
        const decision = decisionOf(resolution)
        return decision === "deny" ? decline : decision === "cancel" ? cancel : { action: "accept", content: null, _meta: null }
      },
    }
  }

  // openai/form, openaiForm, openai/userVerification: not supported by OpenBot.
  return { _tag: "Answer", reply: { result: decline } }
}

const userInput = (id: string, params: Record<string, unknown>): MappedRequest => {
  const native = str(params.turnId)
  const itemId = str(params.itemId)
  const raw = Array.isArray(params.questions) ? params.questions.filter(isRecord) : []
  const questions: Array<Question> = []
  for (const q of raw) {
    const questionId = str(q.id)
    if (!questionId) continue
    const options = (Array.isArray(q.options) ? q.options.filter(isRecord) : [])
      .filter((o) => typeof o.label === "string")
      .map((o) => ({ label: o.label as string, ...(str(o.description) ? { description: o.description as string } : {}) }))
    const header = str(q.header)
    questions.push({
      id: questionId,
      ...(header ? { header } : {}),
      prompt: str(q.question) ?? header ?? questionId,
      options,
      multiSelect: false,
      allowFreeText: q.isOther === true || options.length === 0,
      ...(q.isSecret === true ? { isSecret: true } : {}),
    })
  }
  const first = questions[0]
  const request: HarnessRequest = {
    kind: "question",
    title: questions.length === 1 && first ? first.header ?? "Question" : "Questions",
    nativeRequestId: id,
    ...(native && itemId ? { toolKey: itemKeyOf(native, itemId) } : {}),
    questions,
  }
  return {
    _tag: "Ask",
    request,
    reply: (resolution) => {
      if (!isAnswersResolution(resolution)) return { answers: {} }
      const answers: Record<string, { answers: ReadonlyArray<string> }> = {}
      for (const question of questions) {
        const answer = resolution.answers[question.id]
        if (answer === undefined) continue
        answers[question.id] = { answers: Array.isArray(answer) ? answer : [answer as string] }
      }
      return { answers }
    },
  }
}

/** Maps one server request of the session's thread. Pure. */
export const mapServerRequest = (
  id: string | number,
  method: string,
  params: Record<string, unknown>,
  ctx: RequestContext,
): MappedRequest => {
  const nativeId = String(id)
  switch (method) {
    case "item/commandExecution/requestApproval":
      return commandApproval(nativeId, params, ctx)
    case "item/fileChange/requestApproval":
      return fileApproval(nativeId, params, ctx)
    case "item/permissions/requestApproval":
      return permissionsApproval(nativeId, params, ctx)
    case "mcpServer/elicitation/request":
      return elicitation(nativeId, params, ctx)
    case "item/tool/requestUserInput":
      return userInput(nativeId, params)
    case "item/tool/call":
      // OpenBot registers no dynamic tools (its tools are MCP); answer like a failed tool.
      return {
        _tag: "Answer",
        reply: {
          result: {
            contentItems: [{ type: "inputText", text: "ERROR: OpenBot does not provide this tool. Use the openbot MCP tools." }],
            success: false,
          },
        },
      }
    default:
      return unsupported(method)
  }
}
