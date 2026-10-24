/**
 * The fake harness's MCP client: calls OpenBot tools through the REAL gateway with the binding the
 * runner minted (`OpenSessionInput.mcp`), exactly like a real harness would. Uses the
 * `@modelcontextprotocol/sdk` Streamable HTTP client; the bearer token travels in the binding's
 * headers, never on argv. SDK types stay inside this module.
 */
import type { McpBinding } from "@openbot/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Duration, Effect, Schema, Scope, Semaphore } from "effect"

export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The model-visible outcome of a tool call (text content joined; images counted). */
export interface ToolCallOutcome {
  readonly text: string
  readonly isError: boolean
  readonly images: number
}

export interface McpToolClient {
  readonly binding: McpBinding
  /** Calls `name` with `args`. Tool-level errors (`isError`) succeed; transport errors fail. */
  readonly call: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolCallOutcome, McpCallError>
}

export interface McpToolClientOptions {
  /** Per-call timeout; progress notifications reset it. */
  readonly timeout: Duration.Input
  readonly clientName?: string
  readonly clientVersion?: string
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

interface Connection {
  readonly client: Client
  readonly transport: StreamableHTTPClientTransport
}

const closeConnection = (connection: Connection): Effect.Effect<void> =>
  Effect.tryPromise(() => connection.client.close()).pipe(Effect.ignore)

const outcomeOf = (result: Record<string, unknown>): ToolCallOutcome => {
  const content = Array.isArray(result["content"]) ? (result["content"] as ReadonlyArray<Record<string, unknown>>) : []
  const texts: Array<string> = []
  let images = 0
  for (const block of content) {
    if (block["type"] === "text" && typeof block["text"] === "string") texts.push(block["text"])
    else if (block["type"] === "image") images += 1
  }
  if (texts.length === 0 && "toolResult" in result) texts.push(JSON.stringify(result["toolResult"]))
  return { text: texts.join("\n"), isError: result["isError"] === true, images }
}

/**
 * A lazily connected MCP client bound to the session scope: it connects on the first call,
 * reconnects after a transport failure, and closes when the scope closes.
 */
export const makeMcpToolClient = (
  binding: McpBinding,
  options: McpToolClientOptions,
): Effect.Effect<McpToolClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    let current: Connection | undefined
    const timeoutMs = Duration.toMillis(options.timeout)

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const connection = current
        current = undefined
        return connection ? closeConnection(connection) : Effect.void
      }),
    )

    const connect = Effect.tryPromise({
      try: async (signal) => {
        const client = new Client({
          name: options.clientName ?? "openbot-fake-harness",
          version: options.clientVersion ?? "0.0.0",
        })
        const transport = new StreamableHTTPClientTransport(new URL(binding.url), {
          requestInit: { headers: { ...binding.headers } },
        })
        const onAbort = () => void client.close().catch(() => undefined)
        signal.addEventListener("abort", onAbort, { once: true })
        try {
          await client.connect(transport, { signal, timeout: timeoutMs })
        } finally {
          signal.removeEventListener("abort", onAbort)
        }
        return { client, transport } satisfies Connection
      },
      catch: (cause) =>
        new McpCallError({ message: `Could not connect to the OpenBot MCP server: ${describe(cause)}`, cause }),
    })

    const connection = lock.withPermit(
      Effect.suspend(() => {
        if (current) return Effect.succeed(current)
        return Effect.tap(connect, (connection) =>
          Effect.sync(() => {
            current = connection
          }),
        )
      }),
    )

    const drop = (connection: Connection) =>
      Effect.suspend(() => {
        if (current !== connection) return Effect.void
        current = undefined
        return closeConnection(connection)
      })

    const call = (name: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const conn = yield* connection
        return yield* Effect.tryPromise({
          try: (signal) =>
            conn.client.callTool({ name, arguments: args }, undefined, {
              signal,
              timeout: timeoutMs,
              resetTimeoutOnProgress: true,
              onprogress: () => undefined,
            }),
          catch: (cause) => new McpCallError({ message: `Tool call ${name} failed: ${describe(cause)}`, cause }),
        }).pipe(
          Effect.map((result) => outcomeOf(result as Record<string, unknown>)),
          Effect.tapError(() => drop(conn)),
        )
      })

    return { binding, call } satisfies McpToolClient
  })
