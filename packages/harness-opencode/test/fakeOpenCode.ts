/**
 * A scripted fake of `opencode serve` + `@opencode/client` for session tests: every `start` is a new
 * server "process" (generation) with its own SSE subscribers, runtime MCP registry and pending
 * permissions (which, like the real stdio server, do not survive an exit). Sessions and instruction
 * entries live in the shared "database" (they survive restarts, like `opencode.db`).
 */
import { HarnessError } from "@openbot/core"
import { Deferred, Effect, Scope } from "effect"
import type { OpenCodeApi, OpenCodeEvent } from "../src/client.ts"
import type { OpenCodeTransport } from "../src/server.ts"

/** Minimal async queue implementing the SSE AsyncIterable. */
class EventChannel implements AsyncIterable<OpenCodeEvent> {
  private buffer: Array<OpenCodeEvent> = []
  private waiters: Array<(r: IteratorResult<OpenCodeEvent>) => void> = []
  private ended = false
  push(event: OpenCodeEvent) {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.buffer.push(event)
  }
  end() {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<OpenCodeEvent> {
    return {
      next: () => {
        const event = this.buffer.shift()
        if (event) return Promise.resolve({ value: event, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

export interface Call {
  readonly generation: number
  readonly method: string
  readonly input: any
  /** `Date.now()` when the call arrived. */
  readonly at: number
}

export interface FakeSessionRecord {
  id: string
  directory: string
  permissions: ReadonlyArray<unknown>
  metadata: unknown
  model: unknown
  entries: Map<string, unknown>
}

export class FakeServer {
  readonly channels = new Set<EventChannel>()
  readonly mcp = new Map<string, { directory: string; config: any; status: string }>()
  readonly exited: Deferred.Deferred<string>
  dead = false
  constructor(readonly owner: FakeOpenCode, readonly generation: number, exited: Deferred.Deferred<string>) {
    this.exited = exited
  }
  emit(type: string, data: unknown) {
    for (const channel of this.channels) channel.push({ type, data, id: `evt_${++this.owner.eventSeq}` })
  }
  /** Simulates the process dying (stdio mode: runtime MCP servers and pending permissions are lost). */
  crash(reason = "killed") {
    if (this.dead) return
    this.dead = true
    for (const channel of this.channels) channel.end()
    Deferred.doneUnsafe(this.exited, Effect.succeed(`The OpenCode server exited (${reason}).`))
  }
}

/** The real client's shape for a declared 404 (verified against 2.0.6): an Error named after `_tag`. */
const sessionNotFound = (sessionID: string) =>
  Object.assign(new Error(`Session gone: ${sessionID}`), { _tag: "SessionNotFoundError", name: "SessionNotFoundError", sessionID })

export class FakeOpenCode {
  readonly calls: Array<Call> = []
  readonly sessions = new Map<string, FakeSessionRecord>()
  readonly servers: Array<FakeServer> = []
  eventSeq = 0
  sessionSeq = 0
  /** Send `server.connected` on subscribe (the readiness barrier). */
  autoConnect = true
  /** `mcp.list` reports `pending` this many times before `connected`. */
  mcpPendingPolls = 1
  /** Scripted reaction to a prompt (runs after the HTTP reply). */
  onPrompt: ((input: any, server: FakeServer) => void) | undefined
  /** Scripted reaction to an interrupt; return `false` for "nothing was running". */
  onInterrupt: ((sessionID: string, server: FakeServer) => boolean) | undefined
  /** Make `prompt` fail. */
  rejectPrompt: string | undefined
  /**
   * Scripted reaction to `session.compact` (runs after the HTTP reply). Default: one busy period
   * with `compaction.started` → `compaction.ended` → `execution.succeeded`.
   */
  onCompact: ((sessionID: string, server: FakeServer) => void) | undefined
  /** Replaces the `model.list` catalog. */
  models: ReadonlyArray<unknown> | undefined
  /** Replaces the `integration.list` result. */
  integrations: ReadonlyArray<unknown> | undefined
  private pendingPolls = new Map<string, number>()

  get server(): FakeServer {
    const server = this.servers[this.servers.length - 1]
    if (!server) throw new Error("no fake server started")
    return server
  }

  callsOf(method: string): ReadonlyArray<Call> {
    return this.calls.filter((c) => c.method === method)
  }

  /** Waits (polling) until `predicate` holds. */
  async until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the fake")
      await Bun.sleep(5)
    }
  }

  get start(): Effect.Effect<OpenCodeTransport, HarnessError, Scope.Scope> {
    return Effect.flatMap(Deferred.make<string>(), (exited) => {
      const server = new FakeServer(this, this.servers.length + 1, exited)
      this.servers.push(server)
      return Effect.as(Effect.addFinalizer(() => Effect.sync(() => server.crash("stopped"))), {
        client: this.clientFor(server),
        url: `http://fake/${server.generation}`,
        version: "2.0.6",
        exited: Deferred.await(exited),
      })
    })
  }

  private clientFor(server: FakeServer): OpenCodeApi {
    const record = (method: string, input: any) => {
      if (server.dead) throw Object.assign(new Error("ClientError: Transport"), { cause: "ECONNREFUSED" })
      this.calls.push({ generation: server.generation, method, input, at: Date.now() })
    }
    const session = (sessionID: string) => {
      const s = this.sessions.get(sessionID)
      if (!s) throw sessionNotFound(sessionID)
      return s
    }
    const later = (f: () => void) => setTimeout(f, 1)
    const api = {
      server: {
        info: async () => {
          record("server.info", undefined)
          return { version: "2.0.6", pid: 1, urls: [], paths: { tmp: "/tmp" } }
        },
      },
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => {
          const channel = new EventChannel()
          if (server.dead) {
            channel.end()
            return channel
          }
          server.channels.add(channel)
          options?.signal?.addEventListener("abort", () => channel.end())
          if (this.autoConnect) channel.push({ type: "server.connected", data: {} })
          return channel
        },
      },
      session: {
        create: async (input: any) => {
          record("session.create", input)
          const id = `ses_fake_${++this.sessionSeq}`
          this.sessions.set(id, {
            id,
            directory: input.location?.directory,
            permissions: input.permissions ?? [],
            metadata: input.metadata,
            model: input.model,
            entries: new Map(),
          })
          return { id, location: input.location }
        },
        get: async (input: any) => {
          record("session.get", input)
          const s = session(input.sessionID)
          return { id: s.id, location: { directory: s.directory } }
        },
        update: async (input: any) => {
          record("session.update", input)
          const s = session(input.sessionID)
          if (input.permissions) s.permissions = input.permissions
          if (input.metadata) s.metadata = input.metadata
        },
        switchModel: async (input: any) => {
          record("session.switchModel", input)
          session(input.sessionID).model = input.model
        },
        prompt: async (input: any) => {
          record("session.prompt", input)
          session(input.sessionID)
          if (this.rejectPrompt) throw new Error(this.rejectPrompt)
          if (this.onPrompt) later(() => this.onPrompt!(input, server))
          return { id: `msg_${this.eventSeq}`, sessionID: input.sessionID, type: "user" }
        },
        interrupt: async (input: any) => {
          record("session.interrupt", input)
          const interrupted = this.onInterrupt ? this.onInterrupt(input.sessionID, server) : true
          return { interrupted }
        },
        compact: async (input: any) => {
          record("session.compact", input)
          session(input.sessionID)
          later(() => (this.onCompact ?? scriptCompaction)(input.sessionID, server))
          return { id: "msg_compact", sessionID: input.sessionID, type: "compaction", payload: {}, delivery: "steer" }
        },
        instructions: {
          entry: {
            list: async (input: any) => {
              record("instructions.entry.list", input)
              return [...session(input.sessionID).entries].map(([key, value]) => ({ key, value }))
            },
            put: async (input: any) => {
              record("instructions.entry.put", input)
              session(input.sessionID).entries.set(input.key, input.value)
            },
            remove: async (input: any) => {
              record("instructions.entry.remove", input)
              session(input.sessionID).entries.delete(input.key)
            },
          },
        },
        form: {
          reply: async (input: any) => {
            record("form.reply", input)
            later(() => server.emit("form.replied", { id: input.formID, sessionID: input.sessionID, answer: input.answer }))
          },
          cancel: async (input: any) => {
            record("form.cancel", input)
            later(() => server.emit("form.cancelled", { id: input.formID, sessionID: input.sessionID }))
          },
        },
      },
      permission: {
        reply: async (input: any) => {
          record("permission.reply", input)
          later(() => server.emit("permission.replied", { sessionID: input.sessionID, requestID: input.requestID, reply: input.decision }))
        },
        list: async (input: any) => {
          record("permission.list", input)
          return []
        },
      },
      mcp: {
        add: async (input: any) => {
          record("mcp.add", input)
          server.mcp.set(input.server, { directory: input.location?.directory, config: input.config, status: "pending" })
          this.pendingPolls.set(`${server.generation}:${input.server}`, this.mcpPendingPolls)
        },
        remove: async (input: any) => {
          record("mcp.remove", input)
          server.mcp.delete(input.server)
        },
        list: async (input: any) => {
          record("mcp.list", input)
          const data = [...server.mcp]
            .filter(([, v]) => v.directory === input?.location?.directory)
            .map(([name]) => {
              const key = `${server.generation}:${name}`
              const left = this.pendingPolls.get(key) ?? 0
              this.pendingPolls.set(key, left - 1)
              return { name, status: { status: left > 0 ? "pending" : "connected" } }
            })
          return { location: { directory: input?.location?.directory }, data }
        },
      },
      model: {
        list: async (input: any) => {
          record("model.list", input)
          if (this.models) return { location: input?.location, data: this.models }
          return {
            location: input?.location,
            data: [
              {
                id: "gpt-test",
                modelID: "gpt-test",
                providerID: "openai",
                name: "GPT Test",
                capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                variants: [{ id: "low" }, { id: "high" }],
                time: { released: 0 },
                cost: [],
                status: "active",
                enabled: true,
                limit: { context: 200_000, output: 32_000 },
              },
              {
                id: "old",
                modelID: "old",
                providerID: "openai",
                name: "Old",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                variants: [],
                time: { released: 0 },
                cost: [],
                status: "deprecated",
                enabled: true,
                limit: { context: 8_000, output: 1_000 },
              },
              {
                id: "free",
                modelID: "free",
                providerID: "opencode",
                name: "Free",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                variants: [],
                time: { released: 0 },
                cost: [],
                status: "active",
                enabled: true,
                limit: { context: 100_000, output: 1_000 },
              },
            ],
          }
        },
        default: async (input: any) => {
          record("model.default", input)
          return { location: input?.location, data: { id: "free", providerID: "opencode" } }
        },
      },
      integration: {
        list: async (input: any) => {
          record("integration.list", input)
          if (this.integrations) return { location: input?.location, data: this.integrations }
          return {
            location: input?.location,
            data: [
              { id: "openai", name: "OpenAI", methods: [], connections: [{ type: "credential", id: "cred_1", label: "OpenAI", method: "oauth" }] },
              { id: "anthropic", name: "Anthropic", methods: [], connections: [] },
            ],
          }
        },
      },
    }
    return api as unknown as OpenCodeApi
  }
}

// ---------------------------------------------------------------------------- scripted turn helpers

/** Emits a simple successful turn: text "…" then `execution.succeeded`. */
export const scriptText = (server: FakeServer, sessionID: string, text: string, opts: { messageID?: string; tokens?: number } = {}) => {
  const assistantMessageID = opts.messageID ?? `msg_a_${server.owner.eventSeq + 1}`
  server.emit("session.execution.started", { sessionID })
  server.emit("session.step.started", { sessionID, assistantMessageID, agent: "build", model: { id: "gpt-test", providerID: "openai" } })
  server.emit("session.text.started", { sessionID, assistantMessageID, ordinal: 0 })
  server.emit("session.text.delta", { sessionID, assistantMessageID, ordinal: 0, delta: text })
  server.emit("session.text.ended", { sessionID, assistantMessageID, ordinal: 0, text })
  server.emit("session.step.ended", {
    sessionID,
    assistantMessageID,
    finish: "stop",
    cost: 0,
    tokens: { input: opts.tokens ?? 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  server.emit("session.execution.succeeded", { sessionID })
}

/** A manual compaction's busy period (`core/src/session/runner/llm.ts` order). */
export const scriptCompaction = (sessionID: string, server: FakeServer, opts: { fail?: string; summary?: string } = {}) => {
  server.emit("session.execution.started", { sessionID })
  server.emit("session.compaction.started", { sessionID, reason: "manual", recent: "" })
  if (opts.fail) {
    server.emit("session.compaction.failed", { sessionID, reason: "manual", error: { type: "compaction.template", message: opts.fail } })
  } else {
    server.emit("session.compaction.ended", {
      sessionID,
      reason: "manual",
      model: { id: "gpt-test", providerID: "openai" },
      text: opts.summary ?? "x".repeat(4_000),
      recent: "",
    })
  }
  server.emit("session.execution.succeeded", { sessionID })
}
