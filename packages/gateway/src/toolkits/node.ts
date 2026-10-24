/**
 * NodeToolkit (D1.6, architecture §4.6, §5.4): `shell`, `read_file`, `write_file`, `edit_file`,
 * `list_dir`, `glob`, `grep`, each with an optional `node` parameter (default: the host node; it must
 * be the host node or one of the bot's bound nodes). Calls go to `NodeDirectory.client(node)` →
 * `NodeRpcs`; every side-effecting call carries `inv = {invocationId, botId, runId: sessionKey,
 * toolCallId?}` (interfaces §8.1).
 *
 * Approvals (interfaces §8.3, mcp-conformance R10): before `shell`, `write_file` and `edit_file`, the
 * gateway asks `Orchestrator.approveToolCall`; read-only tools are not asked about (node policy still
 * applies on the node).
 *
 * Results (R4): at most about 10 KB of text; longer output is written to
 * `<workspace>/.openbot/out/<invocationId>.log` on the node and the path is returned.
 */
import type { HarnessApprovalRequest, NodeId, NodeSummary } from "@openbot/contracts"
import {
  type McpClaims,
  DataDir,
  IdGen,
  type NodeClient,
  NodeDirectory,
  Orchestrator,
  workspacePathFor,
} from "@openbot/core"
import { type ExecEvent, hasCapability, type Invocation } from "@openbot/node-protocol"
import { Effect, Stream } from "effect"
import * as p from "../params.ts"
import { capText, errorResult, MAX_RESULT_TEXT_BYTES, textResult, ToolRefusal, utf8Length } from "../results.ts"
import { type AnyTool, defineTool, type ToolCallContext } from "../tool.ts"

export type NodeToolkitServices = NodeDirectory | IdGen | DataDir | Orchestrator

/** Room left for headers/footers around spilled output. */
const OUTPUT_BUDGET_BYTES = MAX_RESULT_TEXT_BYTES - 1_000
/** How much command output the node streams before it spills the rest to a file itself. */
const SHELL_STREAM_LIMIT_BYTES = 256 * 1024
const DEFAULT_SHELL_TIMEOUT_SECONDS = 120
const MAX_SHELL_TIMEOUT_SECONDS = 60 * 60
const DEFAULT_READ_LIMIT_BYTES = 8_000
const LIST_LIMIT = 500

// ============================================================================ paths

const isAbsolutePath = (path: string): boolean =>
  path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)

/** Resolves `path` against the bot's workspace on the node (relative paths are workspace-relative). */
export const resolveNodePath = (workspace: string, path: string | undefined): string => {
  if (path === undefined || path.trim() === "" || path.trim() === ".") return workspace
  const trimmed = path.trim()
  if (isAbsolutePath(trimmed)) return trimmed
  const base = workspace.replace(/[\\/]+$/, "")
  const sep = /^[A-Za-z]:\\/.test(base) && !base.includes("/") ? "\\" : "/"
  return `${base}${sep}${trimmed.replace(/^\.[\\/]/, "")}`
}

// ============================================================================ target node

/** The node of a call, without a client (tools that reach the node through a port, e.g. send_file). */
export interface NodeChoice {
  readonly nodeId: NodeId
  readonly node: NodeSummary
  /** The bot's workspace on this node (default cwd and base of relative paths). */
  readonly workspace: string
  readonly inv: Invocation
}

export interface NodeTarget extends NodeChoice {
  readonly client: NodeClient
}

/** Nodes the claims allow: the host node first, then the bound nodes. */
export const allowedNodeIds = (claims: McpClaims): ReadonlyArray<NodeId> => [
  claims.hostNodeId,
  ...claims.boundNodeIds.filter((id) => id !== claims.hostNodeId),
]

/**
 * Picks the node for a call (`node` = id or label, default the host node), checks it is allowed and
 * offers `capability`, and builds the invocation.
 */
export const resolveTarget = (
  ctx: ToolCallContext,
  nodeArg: string | undefined,
  capability: string | ReadonlyArray<string>,
): Effect.Effect<NodeTarget, unknown, NodeDirectory | IdGen | DataDir> =>
  Effect.gen(function* () {
    const choice = yield* chooseNode(ctx, nodeArg, capability)
    const client = yield* (yield* NodeDirectory).client(choice.nodeId)
    return { ...choice, client }
  })

/** `resolveTarget` without the RPC client: the node (allowed, offering `capability` or one of several), workspace and invocation. */
export const chooseNode = (
  ctx: ToolCallContext,
  nodeArg: string | undefined,
  capability: string | ReadonlyArray<string>,
): Effect.Effect<NodeChoice, unknown, NodeDirectory | IdGen | DataDir> =>
  Effect.gen(function* () {
    const claims = ctx.claims
    const directory = yield* NodeDirectory
    const allowed = allowedNodeIds(claims)
    let nodeId: NodeId = claims.hostNodeId
    if (nodeArg !== undefined && nodeArg.trim() !== "") {
      const wanted = nodeArg.trim()
      const byId = allowed.find((id) => id === wanted)
      if (byId !== undefined) nodeId = byId
      else {
        const nodes = yield* directory.list
        const byLabel = nodes.find((n) => allowed.includes(n.id) && n.label.toLowerCase() === wanted.toLowerCase())
        if (byLabel === undefined) {
          return yield* new ToolRefusal({
            message: `You cannot use node "${wanted}". Your nodes: ${allowed.join(", ")} (see list_nodes).`,
          })
        }
        nodeId = byLabel.id
      }
    }
    const node = yield* directory.get(nodeId)
    const capabilities = yield* directory.capabilities(nodeId)
    const wanted = typeof capability === "string" ? [capability] : capability
    if (!wanted.some((c) => hasCapability(capabilities, c))) {
      return yield* new ToolRefusal({
        message: `Node ${node.label} does not offer ${wanted.join(" or ")} (capabilities: ${capabilities.join(", ") || "none"}).`,
      })
    }
    const workspace =
      nodeId === claims.hostNodeId
        ? claims.workspacePath
        : workspacePathFor({ node, botId: claims.botId, dataDir: yield* DataDir })
    const invocationId = yield* (yield* IdGen).next("inv")
    const inv: Invocation = {
      invocationId,
      botId: claims.botId,
      runId: claims.sessionKey,
      ...(ctx.tool.callId === undefined ? {} : { toolCallId: ctx.tool.callId }),
    }
    return { nodeId, node, workspace, inv }
  })

// ============================================================================ approvals

/** Asks OpenBot's approval layer (interfaces §8.3); a deny becomes a refusal with `ERROR:` text. */
export const approve = (
  ctx: ToolCallContext,
  request: HarnessApprovalRequest,
  what: string,
): Effect.Effect<void, ToolRefusal, Orchestrator> =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator
    yield* ctx.progress(`Waiting for approval: ${request.title}`)
    const resolution = yield* orchestrator.approveToolCall(ctx.tool, request)
    if ("decision" in resolution) {
      if (
        resolution.decision === "allow-once" ||
        resolution.decision === "allow-session" ||
        resolution.decision === "allow-always"
      ) {
        return
      }
      const why = resolution.message === undefined || resolution.message === "" ? "" : ` Reason: ${resolution.message}`
      return yield* new ToolRefusal({
        message: `The user did not allow ${what}.${why} Do not retry it unless the user asks you to.`,
      })
    }
    return yield* new ToolRefusal({ message: `The user did not allow ${what}.` })
  })

const oneLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ============================================================================ spilling (R4)

/** Writes `text` to `<workspace>/.openbot/out/<invocationId>.log` on the node; undefined when that fails. */
export const spillToNode = (target: NodeTarget, text: string): Effect.Effect<string | undefined> => {
  const path = resolveNodePath(target.workspace, `.openbot/out/${target.inv.invocationId}.log`)
  return target.client["fs.write"]({ inv: target.inv, path, content: text, createParents: true }).pipe(
    Effect.as(path as string | undefined),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
}

/** Caps `text` for a result; when it is too long the full text is spilled to the node first. */
export const fitToResult = (target: NodeTarget, text: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (utf8Length(text) <= OUTPUT_BUDGET_BYTES) return text
    const path = yield* spillToNode(target, text)
    return capText(
      text,
      OUTPUT_BUDGET_BYTES,
      path === undefined
        ? undefined
        : `full output saved on node ${target.node.label} at ${path} (read it with read_file using offset/limit, or grep it)`,
    ).text
  })

const nodeParam = p.optional(p.text("Node id or name to run on (see list_nodes). Default: your host node."))

// ============================================================================ shell

const shell = defineTool({
  name: "shell",
  toolset: "node",
  description:
    "Run a shell command on a node (default: your host node) in your workspace directory and return its output and exit code. Long output is saved to a file on the node and its path returned. Each call is a fresh shell (no state is kept between calls).",
  params: p.params({
    command: p.text("The command line (run with the node's default shell)."),
    cwd: p.optional(p.string("Working directory; relative paths are inside your workspace. Default: your workspace.")),
    timeout_seconds: p.optional(
      p.number(
        `Kill the command after this many seconds (default ${DEFAULT_SHELL_TIMEOUT_SECONDS}, max ${MAX_SHELL_TIMEOUT_SECONDS}).`,
        {
          integer: true,
          min: 1,
          max: MAX_SHELL_TIMEOUT_SECONDS,
        },
      ),
    ),
    node: nodeParam,
  }),
  annotations: { title: "Run a shell command", destructiveHint: true, openWorldHint: true },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "shell")
      const cwd = resolveNodePath(target.workspace, args.cwd)
      yield* approve(
        ctx,
        {
          kind: "command-approval",
          toolName: "shell",
          title: `Run ${oneLine(args.command, 100)}`,
          detail: `${args.command}\n\nin ${cwd} on ${target.node.label}`,
          surface: "shell",
          command: args.command,
          cwd,
          nodeId: target.nodeId,
        },
        "this command",
      )
      const timeoutSeconds = args.timeout_seconds ?? DEFAULT_SHELL_TIMEOUT_SECONDS
      const chunks: Array<string> = []
      let bytes = 0
      let exit: Extract<ExecEvent, { readonly _tag: "Exit" }> | undefined
      yield* ctx.progress(`Running ${oneLine(args.command, 80)}`)
      yield* Stream.runForEach(
        target.client["shell.exec"]({
          inv: target.inv,
          command: args.command,
          cwd,
          timeoutMs: timeoutSeconds * 1000,
          outputLimitBytes: SHELL_STREAM_LIMIT_BYTES,
        }),
        (event) => {
          switch (event._tag) {
            case "Output": {
              if (bytes < SHELL_STREAM_LIMIT_BYTES * 2) {
                chunks.push(event.data)
                bytes += utf8Length(event.data)
              }
              const last = event.data
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l !== "")
                .pop()
              return last === undefined ? Effect.void : ctx.progress(oneLine(last, 200))
            }
            case "Exit":
              exit = event
              return Effect.void
            case "Started":
              return Effect.void
          }
        },
      )
      const output = chunks.join("")
      if (exit === undefined) {
        return errorResult(`The command ended without an exit status.\n${capText(output, OUTPUT_BUDGET_BYTES).text}`)
      }
      const seconds = (exit.durationMs / 1000).toFixed(1)
      let body: string
      if (exit.outputTruncated === true && exit.spillPath !== undefined) {
        body = capText(
          output,
          OUTPUT_BUDGET_BYTES,
          `full output saved on node ${target.node.label} at ${exit.spillPath} (read it with read_file using offset/limit)`,
        ).text
      } else {
        body = yield* fitToResult(target, output)
      }
      const shown = body === "" ? "(no output)" : body
      if (exit.timedOut) {
        return errorResult(`The command timed out after ${timeoutSeconds} s and was killed.\n${shown}`)
      }
      const status = exit.code !== null ? `exit code ${exit.code}` : `killed by signal ${exit.signal ?? "unknown"}`
      return textResult(`${shown}\n[${status} · ${seconds} s]`)
    }),
})

// ============================================================================ files

const readFile = defineTool({
  name: "read_file",
  toolset: "node",
  description:
    "Read a text file on a node (default: your host node). Relative paths are inside your workspace. Large files are returned in pages: pass `offset` (bytes) to continue.",
  params: p.params({
    path: p.text("File path."),
    offset: p.optional(p.number("Byte offset to start at (default 0).", { integer: true, min: 0 })),
    limit: p.optional(
      p.number(`Maximum bytes to return (default and max ${DEFAULT_READ_LIMIT_BYTES}).`, {
        integer: true,
        min: 1,
        max: DEFAULT_READ_LIMIT_BYTES,
      }),
    ),
    node: nodeParam,
  }),
  annotations: { title: "Read a file", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "fs")
      const path = resolveNodePath(target.workspace, args.path)
      const offset = args.offset ?? 0
      const limit = args.limit ?? DEFAULT_READ_LIMIT_BYTES
      const result = yield* target.client["fs.read"]({ inv: target.inv, path, offset, limit })
      if (result.encoding !== "utf8") {
        return textResult(`${path} is a binary file (${result.size} bytes); it cannot be shown as text.`)
      }
      const shown = utf8Length(result.content)
      const end = offset + shown
      const footer =
        result.truncated || end < result.size
          ? `\n\n[bytes ${offset}–${end} of ${result.size}; call read_file with offset=${end} to continue]`
          : ""
      const text = capText(result.content, OUTPUT_BUDGET_BYTES).text
      return textResult(result.size === 0 ? `${path} is empty.` : `${text}${footer}`)
    }),
})

const writeFile = defineTool({
  name: "write_file",
  toolset: "node",
  description:
    "Create or overwrite a text file on a node (default: your host node). Relative paths are inside your workspace; missing parent directories are created.",
  params: p.params({
    path: p.text("File path."),
    content: p.string("The complete new file content."),
    node: nodeParam,
  }),
  annotations: { title: "Write a file", destructiveHint: true, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "fs")
      const path = resolveNodePath(target.workspace, args.path)
      yield* approve(
        ctx,
        {
          kind: "file-approval",
          toolName: "write_file",
          title: `Write ${path}`,
          detail: `${utf8Length(args.content)} bytes on ${target.node.label}`,
          surface: "file-edit",
          paths: [path],
          diff: capText(args.content, 4_000).text,
          nodeId: target.nodeId,
        },
        "writing this file",
      )
      const result = yield* target.client["fs.write"]({
        inv: target.inv,
        path,
        content: args.content,
        createParents: true,
      })
      return textResult(`Wrote ${result.size} bytes to ${path}.`)
    }),
})

const editFile = defineTool({
  name: "edit_file",
  toolset: "node",
  description:
    "Replace text in a file on a node (default: your host node). `old_string` must match exactly once unless `replace_all` is true. Read the file first.",
  params: p.params({
    path: p.text("File path."),
    old_string: p.text("Exact text to replace (include enough context to be unique)."),
    new_string: p.string("Replacement text."),
    replace_all: p.optional(p.boolean("Replace every occurrence (default false).")),
    node: nodeParam,
  }),
  annotations: { title: "Edit a file", destructiveHint: true, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "fs")
      const path = resolveNodePath(target.workspace, args.path)
      const diff = capText(
        `${args.old_string
          .split("\n")
          .map((l) => `-${l}`)
          .join("\n")}\n${args.new_string
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}`,
        4_000,
      ).text
      yield* approve(
        ctx,
        {
          kind: "file-approval",
          toolName: "edit_file",
          title: `Edit ${path}`,
          detail: `on ${target.node.label}`,
          surface: "file-edit",
          paths: [path],
          diff,
          nodeId: target.nodeId,
        },
        "this edit",
      )
      const result = yield* target.client["fs.edit"]({
        inv: target.inv,
        path,
        oldString: args.old_string,
        newString: args.new_string,
        replaceAll: args.replace_all ?? false,
      })
      return textResult(`Edited ${path}: ${result.replacements} replacement${result.replacements === 1 ? "" : "s"}.`)
    }),
})

const listDir = defineTool({
  name: "list_dir",
  toolset: "node",
  description: "List a directory on a node (default: your workspace on your host node). Directories end with `/`.",
  params: p.params({
    path: p.optional(p.string("Directory path (default: your workspace).")),
    depth: p.optional(
      p.number("Recursion depth (default 1 = direct children, max 5).", { integer: true, min: 1, max: 5 }),
    ),
    include_hidden: p.optional(p.boolean("Include dotfiles (default false).")),
    node: nodeParam,
  }),
  annotations: { title: "List a directory", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "fs")
      const path = resolveNodePath(target.workspace, args.path)
      const result = yield* target.client["fs.list"]({
        inv: target.inv,
        path,
        depth: args.depth ?? 1,
        includeHidden: args.include_hidden ?? false,
        limit: LIST_LIMIT,
      })
      const lines = result.entries.map((e) =>
        e.type === "dir" ? `${e.path}/` : e.type === "symlink" ? `${e.path}@` : `${e.path} (${e.size} B)`,
      )
      if (result.truncated) lines.push(`[… more entries not shown; list a subdirectory or use glob]`)
      const text = lines.length === 0 ? `${path} is empty.` : `${path}:\n${lines.join("\n")}`
      return textResult(yield* fitToResult(target, text))
    }),
})

const glob = defineTool({
  name: "glob",
  toolset: "node",
  description: 'Find files by glob pattern (e.g. "**/*.ts") on a node (default: in your workspace on your host node).',
  params: p.params({
    pattern: p.text("Glob pattern."),
    path: p.optional(p.string("Directory to search in (default: your workspace).")),
    node: nodeParam,
  }),
  annotations: { title: "Find files", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "fs")
      const cwd = resolveNodePath(target.workspace, args.path)
      const result = yield* target.client["fs.glob"]({ inv: target.inv, pattern: args.pattern, cwd, limit: LIST_LIMIT })
      const lines = [...result.paths]
      if (result.truncated) lines.push(`[… more matches not shown; narrow the pattern]`)
      if (lines.length === 0) return textResult(`No files match ${args.pattern} in ${cwd}.`)
      return textResult(yield* fitToResult(target, lines.join("\n")))
    }),
})

const grep = defineTool({
  name: "grep",
  toolset: "node",
  description:
    "Search file contents with a regular expression (ripgrep syntax) on a node (default: your workspace on your host node). Modes: files_with_matches (default), content (matching lines), count.",
  params: p.params({
    pattern: p.text("Regular expression (or literal text with literal=true)."),
    path: p.optional(p.string("File or directory to search (default: your workspace).")),
    glob: p.optional(p.string('Only search files matching this glob, e.g. "*.md".')),
    output_mode: p.optional(
      p.literals(["files_with_matches", "content", "count"], "What to return (default files_with_matches)."),
    ),
    ignore_case: p.optional(p.boolean("Case-insensitive (default false).")),
    literal: p.optional(p.boolean("Treat the pattern as literal text (default false).")),
    context_lines: p.optional(
      p.number("Lines of context around matches in content mode (default 0, max 10).", {
        integer: true,
        min: 0,
        max: 10,
      }),
    ),
    node: nodeParam,
  }),
  annotations: { title: "Search file contents", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(ctx, args.node, "fs")
      const path = resolveNodePath(target.workspace, args.path)
      const mode = args.output_mode ?? "files_with_matches"
      const result = yield* target.client["fs.grep"]({
        inv: target.inv,
        pattern: args.pattern,
        path,
        glob: args.glob,
        ignoreCase: args.ignore_case,
        literal: args.literal,
        contextLines: args.context_lines,
        outputMode: mode,
        limit: LIST_LIMIT,
      })
      const lines =
        mode === "content"
          ? result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`)
          : mode === "count"
            ? result.counts.map((c) => `${c.path}: ${c.count}`)
            : [...result.files]
      if (result.truncated) lines.push(`[… more results not shown; narrow the search]`)
      if (lines.length === 0) return textResult(`No matches for ${args.pattern} in ${path}.`)
      return textResult(yield* fitToResult(target, lines.join("\n")))
    }),
})

/** Every node tool. */
export const NodeToolkit: ReadonlyArray<AnyTool<NodeToolkitServices>> = [
  shell,
  readFile,
  writeFile,
  editFile,
  listDir,
  glob,
  grep,
]
