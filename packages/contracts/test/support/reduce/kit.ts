// TEST HELPER ONLY (fixture reducers): adapters own the real normalizers (HarnessEvent). Ported from vendor/scratch/contracts/src/reduce.
// Shared machinery for harness reducers: native frames -> KnownConversationChange upserts.
// Mirrors what a server-side ingestor does (t3code ProviderEventIngestor + IdAllocator):
// allocate stable app ids for native keys, keep the full current entity, bump `revision`, and
// re-emit the WHOLE entity on every change. Research scratch.
import type {
  Author,
  BotId,
  ConversationId,
  EntryId,
  HarnessKind,
  RequestId,
  TurnId,
  UserId,
} from "../../../src/index.ts"
import type { RuntimeRequest } from "../../../src/index.ts"
import type { KnownConversationChange } from "../../../src/index.ts"
import type { KnownTranscriptEntry, ToolKind, Turn } from "../../../src/index.ts"

export type Frame = { readonly seq: number; readonly t: number; readonly source: string; readonly payload: any }
export const readFixture = async (path: string): Promise<Frame[]> =>
  (await Bun.file(path).text())
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Frame)

/** How a native event was handled. `elsewhere` = belongs to another replica/API, not the conversation. */
export type Disposition = "mapped" | "state" | "elsewhere" | "no-home"
export class Ledger {
  readonly rows = new Map<string, { disposition: Disposition; count: number; note: string }>()
  note(key: string, disposition: Disposition, note = "") {
    const row = this.rows.get(key)
    if (row) {
      row.count++
      if (row.disposition !== disposition && rank(disposition) > rank(row.disposition)) row.disposition = disposition
    } else this.rows.set(key, { disposition, count: 1, note })
  }
  keys(d: Disposition): string[] {
    return [...this.rows]
      .filter(([, r]) => r.disposition === d)
      .map(([k]) => k)
      .sort()
  }
}
const rank = (d: Disposition) => ({ "no-home": 0, elsewhere: 1, state: 2, mapped: 3 })[d]

export interface Ctx {
  readonly harness: HarnessKind
  readonly conversationId: ConversationId
  readonly botId: BotId
  readonly userId: UserId
  /** Base wall clock; frame.t (ms offset) is added for deterministic timestamps. */
  readonly t0: number
}

export const defaultCtx = (harness: HarnessKind): Ctx => ({
  harness,
  conversationId: "conv_fixture" as ConversationId,
  botId: "bot_fixture" as BotId,
  userId: "user_owner" as UserId,
  t0: 1_792_000_000_000,
})

type EntryOf<K extends KnownTranscriptEntry["kind"]> = Extract<KnownTranscriptEntry, { kind: K }>
type Base = Pick<KnownTranscriptEntry, "id" | "conversationId" | "revision" | "createdAt" | "updatedAt" | "author">
/** Entry fields a reducer supplies; the emitter fills id/revision/timestamps/author. */
export type Body<K extends KnownTranscriptEntry["kind"]> = Omit<EntryOf<K>, keyof Base>

export class Emitter {
  readonly changes: KnownConversationChange[] = []
  readonly entries = new Map<EntryId, KnownTranscriptEntry>()
  readonly requests = new Map<RequestId, RuntimeRequest>()
  readonly turns = new Map<TurnId, Turn>()
  private readonly ids = new Map<string, string>()
  private readonly counters = { ent: 0, req: 0, turn: 0 }
  constructor(readonly ctx: Ctx) {}

  at(frame: Frame): number {
    return this.ctx.t0 + frame.t
  }
  get botAuthor(): Author {
    return { kind: "bot", botId: this.ctx.botId }
  }
  get userAuthor(): Author {
    return { kind: "user", userId: this.ctx.userId }
  }

  private alloc(prefix: "ent" | "req" | "turn", nativeKey: string): string {
    const k = `${prefix}|${nativeKey}`
    let id = this.ids.get(k)
    if (!id) {
      id = `${prefix}_${String(++this.counters[prefix]).padStart(3, "0")}`
      this.ids.set(k, id)
    }
    return id
  }
  entryId(nativeKey: string): EntryId {
    return this.alloc("ent", nativeKey) as EntryId
  }
  hasEntry(nativeKey: string): boolean {
    return this.ids.has(`ent|${nativeKey}`)
  }
  requestId(nativeKey: string): RequestId {
    return this.alloc("req", nativeKey) as RequestId
  }
  hasRequest(nativeKey: string): boolean {
    return this.ids.has(`req|${nativeKey}`)
  }
  turnId(nativeKey: string): TurnId {
    return this.alloc("turn", nativeKey) as TurnId
  }

  entry<K extends KnownTranscriptEntry["kind"]>(nativeKey: string): EntryOf<K> | undefined {
    if (!this.hasEntry(nativeKey)) return undefined
    return this.entries.get(this.entryId(nativeKey)) as EntryOf<K> | undefined
  }

  /** Create or update an entry. `build` receives the previous value (or undefined) and base fields. */
  upsertEntry<K extends KnownTranscriptEntry["kind"]>(
    frame: Frame,
    nativeKey: string,
    build: (prev: EntryOf<K> | undefined) => Body<K>,
    author?: Author,
  ): EntryOf<K> {
    const id = this.entryId(nativeKey)
    const prev = this.entries.get(id) as EntryOf<K> | undefined
    const now = this.at(frame)
    const base: Base = {
      id,
      conversationId: this.ctx.conversationId,
      revision: prev ? prev.revision + 1 : 0,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now,
      author: prev ? prev.author : (author ?? this.botAuthor),
    }
    const body = build(prev) as Record<string, unknown>
    if (prev) for (const k of ["id", "conversationId", "revision", "createdAt", "updatedAt", "author"]) delete body[k]
    const next = { ...body, ...base } as EntryOf<K>
    this.entries.set(id, next)
    this.changes.push({ type: "entry.upserted", entry: next })
    return next
  }

  upsertRequest(
    frame: Frame,
    nativeKey: string,
    build: (prev: RuntimeRequest | undefined, id: RequestId) => RuntimeRequest,
  ): RuntimeRequest {
    const id = this.requestId(nativeKey)
    const next = build(this.requests.get(id), id)
    void frame
    this.requests.set(id, next)
    this.changes.push({ type: "request.upserted", request: next })
    return next
  }

  upsertTurn(nativeKey: string, build: (prev: Turn | undefined, id: TurnId) => Turn): Turn {
    const id = this.turnId(nativeKey)
    const next = build(this.turns.get(id), id)
    this.turns.set(id, next)
    this.changes.push({ type: "turn.upserted", turn: next })
    return next
  }

  /** On turn end: stop every still-streaming entry of the turn (Codex never completes an interrupted item). */
  finalizeStreaming(frame: Frame, turnId: TurnId, aborted: boolean) {
    for (const e of [...this.entries.values()]) {
      if (e.turnId !== turnId) continue
      if ((e.kind === "message" || e.kind === "reasoning") && e.streaming) {
        this.upsertEntryById(
          frame,
          e.id,
          (prev) =>
            ({
              ...prev,
              streaming: false,
              ...(aborted && prev.kind === "message" ? { aborted: true } : {}),
            }) as KnownTranscriptEntry,
        )
      }
      if (
        e.kind === "tool-call" &&
        (e.status === "pending" || e.status === "running" || e.status === "awaiting-approval")
      ) {
        this.upsertEntryById(
          frame,
          e.id,
          (prev) => ({ ...prev, status: "interrupted", completedAt: this.at(frame) }) as KnownTranscriptEntry,
        )
      }
    }
  }
  private upsertEntryById(frame: Frame, id: EntryId, build: (prev: KnownTranscriptEntry) => KnownTranscriptEntry) {
    const prev = this.entries.get(id)!
    const next = { ...build(prev), revision: prev.revision + 1, updatedAt: this.at(frame) } as KnownTranscriptEntry
    this.entries.set(id, next)
    this.changes.push({ type: "entry.upserted", entry: next })
  }
}

export const toolKindFor = (name: string, mcpServers: ReadonlyArray<string> = []): ToolKind => {
  const n = name.toLowerCase()
  if (mcpServers.some((s) => n.startsWith(`${s.toLowerCase()}_`))) return "mcp"
  if (n === "bash" || n === "shell" || n === "exec_command" || n === "commandexecution") return "shell"
  if (n === "read" || n === "read_file") return "file-read"
  if (n === "write") return "file-write"
  if (
    n === "edit" ||
    n === "multiedit" ||
    n === "notebookedit" ||
    n === "patch" ||
    n === "apply_patch" ||
    n === "filechange"
  )
    return "file-edit"
  if (n === "glob" || n === "grep" || n === "ls") return "search"
  if (n === "webfetch" || n === "websearch" || n === "web_search") return "web"
  if (n === "askuserquestion" || n === "question" || n === "request_user_input") return "question"
  if (n === "agent" || n === "task" || n === "subagent") return "subagent"
  if (n.startsWith("mcp__")) return "mcp"
  if (n.startsWith("browser")) return "browser"
  if (n.startsWith("computer")) return "computer"
  return "other"
}

/** Convenience to build a user message entry + turn for an OpenBot send (the server does this at send time). */
export const openbotSend = (em: Emitter, frame: Frame, turnKey: string, text: string, clientNonce: string) => {
  const userEntry = em.upsertEntry<"message">(
    frame,
    `user:${clientNonce}`,
    () => ({
      kind: "message",
      role: "user",
      text,
      attachments: [],
      streaming: false,
      clientNonce,
      delivery: "accepted",
      turnId: em.turnId(turnKey),
    }),
    em.userAuthor,
  )
  em.upsertTurn(turnKey, (_prev, id) => ({
    id,
    conversationId: em.ctx.conversationId,
    botId: em.ctx.botId,
    status: "running",
    trigger: "user",
    inputEntryId: userEntry.id,
    startedAt: em.at(frame),
  }))
  return userEntry
}
