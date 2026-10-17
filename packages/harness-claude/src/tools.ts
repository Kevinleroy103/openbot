/**
 * Classification of Claude Code tools (built-ins and `mcp__<server>__<tool>`) into OpenBot's
 * normalized vocabulary: transcript `ToolKind`, approval `surface`, a human title, a one-line input
 * summary and an activity label. Pure; shared by the normalizer and the permission bridge.
 */
import type { ApprovalSurface, NodeId, ToolKind } from "@openbot/contracts"
import { CONNECTED_APP_ACTIVITY, openBotToolActivity, THINKING_ACTIVITY } from "@openbot/contracts"

/** The OpenBot gateway server name (`McpBinding.name`). */
export const OPENBOT_MCP_SERVER = "openbot"

export interface ToolClassification {
  readonly kind: ToolKind
  readonly surface: ApprovalSurface
  /** Human title, e.g. "Run command", "Read README.md". */
  readonly title: string
  /** One-line summary of the input ("ls -la", "src/index.ts"). */
  readonly inputSummary: string
  /**
   * Activity row phrase while the tool runs: human and plumbing-free (never a tool name; OpenBot's
   * bookkeeping tools and native helpers read as `THINKING_ACTIVITY`).
   */
  readonly activity: string
  /** Shell command, for shell-like tools. */
  readonly command?: string | undefined
  /** Paths touched, for file tools. */
  readonly paths?: ReadonlyArray<string> | undefined
  /** MCP reference for `mcp__server__tool`. */
  readonly mcp?: { readonly server: string; readonly tool: string } | undefined
  /** Node the tool targets (OpenBot gateway node tools carry it in `input.node`). */
  readonly nodeId?: NodeId | undefined
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)

/** Collapses whitespace and caps the length of a one-line summary. */
export const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "")
  const index = trimmed.lastIndexOf("/")
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** Splits `mcp__<server>__<tool>`; server names may contain single underscores. */
export const parseMcpToolName = (name: string): { readonly server: string; readonly tool: string } | undefined => {
  if (!name.startsWith("mcp__")) return undefined
  const rest = name.slice("mcp__".length)
  const index = rest.indexOf("__")
  if (index <= 0 || index === rest.length - 2) return undefined
  return { server: rest.slice(0, index), tool: rest.slice(index + 2) }
}

const jsonSummary = (input: Record<string, unknown>): string => {
  const keys = Object.keys(input)
  if (keys.length === 0) return ""
  try {
    return oneLine(JSON.stringify(input))
  } catch {
    return keys.join(", ")
  }
}

const humanize = (name: string): string => {
  const spaced = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim()
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name
}

/** Gateway node tools (D3.2) and their natural kinds. */
const classifyOpenBotTool = (tool: string, input: Record<string, unknown>): ToolClassification => {
  const mcp = { server: OPENBOT_MCP_SERVER, tool }
  const node = str(input.node) as NodeId | undefined
  const base = { mcp, ...(node ? { nodeId: node } : {}) }
  const path = str(input.path) ?? str(input.file_path)
  switch (tool) {
    case "shell": {
      const command = str(input.command) ?? ""
      return { ...base, kind: "shell", surface: "shell", title: "Run command", inputSummary: oneLine(command), activity: "Running a command", command }
    }
    case "read_file":
      return { ...base, kind: "file-read", surface: "file-read", title: path ? `Read ${basename(path)}` : "Read file", inputSummary: path ?? "", activity: "Reading files", ...(path ? { paths: [path] } : {}) }
    case "write_file":
      return { ...base, kind: "file-write", surface: "file-edit", title: path ? `Write ${basename(path)}` : "Write file", inputSummary: path ?? "", activity: "Editing files", ...(path ? { paths: [path] } : {}) }
    case "edit_file":
      return { ...base, kind: "file-edit", surface: "file-edit", title: path ? `Edit ${basename(path)}` : "Edit file", inputSummary: path ?? "", activity: "Editing files", ...(path ? { paths: [path] } : {}) }
    case "list_dir":
      return { ...base, kind: "file-read", surface: "file-read", title: "List directory", inputSummary: path ?? "", activity: "Reading files" }
    case "glob":
    case "grep": {
      const pattern = str(input.pattern) ?? ""
      return { ...base, kind: "search", surface: "file-read", title: tool === "glob" ? "Find files" : "Search files", inputSummary: oneLine(pattern), activity: "Searching" }
    }
    case "browser": {
      const action = str(input.action) ?? ""
      const url = str(input.url)
      return { ...base, kind: "browser", surface: "browser", title: action ? `Browser: ${action}` : "Use the browser", inputSummary: oneLine(url ?? action), activity: "Using the browser" }
    }
    case "computer": {
      const action = str(input.action) ?? ""
      return { ...base, kind: "computer", surface: "computer", title: action ? `Computer: ${action}` : "Use the computer", inputSummary: oneLine(action), activity: "Using the computer" }
    }
    default:
      return { ...base, kind: "mcp", surface: "mcp", title: humanize(tool), inputSummary: jsonSummary(input), activity: openBotToolActivity(tool) }
  }
}

/** Classifies a tool call by its raw Claude name and input. */
export const classifyTool = (toolName: string, rawInput: unknown): ToolClassification => {
  const input = asRecord(rawInput)
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    if (mcp.server === OPENBOT_MCP_SERVER) return classifyOpenBotTool(mcp.tool, input)
    return { kind: "mcp", surface: "mcp", title: humanize(mcp.tool), inputSummary: jsonSummary(input), activity: CONNECTED_APP_ACTIVITY, mcp }
  }
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "Monitor": {
      const command = str(input.command) ?? ""
      return {
        kind: "shell",
        surface: "shell",
        title: str(input.description) ?? "Run command",
        inputSummary: oneLine(command || (str(input.bash_id) ?? "")),
        activity: "Running a command",
        ...(command ? { command } : {}),
      }
    }
    case "Read":
      return { kind: "file-read", surface: "file-read", title: filePath ? `Read ${basename(filePath)}` : "Read file", inputSummary: filePath ?? "", activity: "Reading files", ...(filePath ? { paths: [filePath] } : {}) }
    case "Write":
      return { kind: "file-write", surface: "file-edit", title: filePath ? `Write ${basename(filePath)}` : "Write file", inputSummary: filePath ?? "", activity: "Editing files", ...(filePath ? { paths: [filePath] } : {}) }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "file-edit", surface: "file-edit", title: filePath ? `Edit ${basename(filePath)}` : "Edit file", inputSummary: filePath ?? "", activity: "Editing files", ...(filePath ? { paths: [filePath] } : {}) }
    case "Glob":
    case "Grep":
    case "LS": {
      const pattern = str(input.pattern) ?? filePath ?? ""
      return { kind: "search", surface: "file-read", title: toolName === "Grep" ? "Search files" : "Find files", inputSummary: oneLine(pattern), activity: "Searching" }
    }
    case "WebFetch": {
      const url = str(input.url) ?? ""
      return { kind: "web", surface: "network", title: "Fetch web page", inputSummary: oneLine(url), activity: "Reading the web" }
    }
    case "WebSearch": {
      const query = str(input.query) ?? ""
      return { kind: "web", surface: "network", title: "Search the web", inputSummary: oneLine(query), activity: "Searching the web" }
    }
    case "Agent":
    case "Task": {
      const description = str(input.description) ?? "Subagent"
      return { kind: "subagent", surface: "other", title: description, inputSummary: oneLine(str(input.prompt) ?? description), activity: THINKING_ACTIVITY }
    }
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? input.questions : []
      const first = str(asRecord(questions[0]).question) ?? ""
      return { kind: "question", surface: "other", title: "Ask a question", inputSummary: oneLine(first), activity: "Waiting for your answer" }
    }
    case "TodoWrite":
      return { kind: "other", surface: "other", title: "Update plan", inputSummary: "", activity: "Planning" }
    default:
      return { kind: "other", surface: "other", title: humanize(toolName), inputSummary: jsonSummary(input), activity: THINKING_ACTIVITY }
  }
}
