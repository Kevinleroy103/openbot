// Optimistic sends. `messages.send` is idempotent by `clientNonce` (architecture §5.1), so a send that
// failed on the transport is retried with the SAME nonce (the brain answers `duplicate` if the first
// attempt landed). Each conversation keeps an outbox of drafts in flight or failed; an item disappears
// when its message entry (same `clientNonce`) arrives on the conversation stream.
import { Effect, Schedule } from "effect"
import type { ConversationId, SendInput, SendResult } from "@openbot/contracts"
import { Atom, AtomRegistry } from "effect/reactivity"
import { RpcClientError } from "effect/rpc"
import { once } from "./once.ts"
import { OpenBotClient } from "./rpc.ts"

export type OutboxStatus = "sending" | "sent" | "failed"

export interface OutboxItem {
  readonly clientNonce: string
  readonly input: SendInput
  readonly status: OutboxStatus
  /** Epoch millis when the draft was first sent. */
  readonly createdAt: number
  readonly result?: SendResult | undefined
  /** Human-readable failure for the error tray ("Couldn't send. Retry"). */
  readonly error?: string | undefined
}

/** A message to send; `clientNonce` is generated when absent (pass one to retry idempotently). */
export type SendDraft = Omit<SendInput, "clientNonce"> & { readonly clientNonce?: string | undefined }

/** Random 128-bit hex nonce. Uses `getRandomValues`, which (unlike `randomUUID`) also works on plain-http LAN origins. */
export const newClientNonce = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let out = "n"
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** Per-conversation outbox: drafts not yet seen on the conversation stream. Oldest first. */
export const outboxAtom = Atom.family((conversationId: ConversationId) =>
  Atom.make<ReadonlyArray<OutboxItem>>([]).pipe(Atom.keepAlive, Atom.withLabel(`openbot/outbox/${conversationId}`)),
)

/** Transport retries for one send (same nonce each time). */
export const SEND_RETRY_TIMES = 4

const describeError = (error: unknown): string => {
  if (error instanceof RpcClientError.RpcClientError) return "Not connected to OpenBot. Check your connection and retry."
  if (typeof error === "object" && error !== null) {
    const e = error as { _tag?: unknown; message?: unknown; reason?: unknown; entity?: unknown }
    if (typeof e.message === "string" && e.message.length > 0) return e.message
    if (typeof e.reason === "string") return e.reason
    if (e._tag === "NotFound") return `${typeof e.entity === "string" ? e.entity : "Item"} not found`
    if (typeof e._tag === "string") return e._tag
  }
  return String(error)
}

const upsertItem = (items: ReadonlyArray<OutboxItem>, item: OutboxItem): ReadonlyArray<OutboxItem> => {
  const i = items.findIndex((o) => o.clientNonce === item.clientNonce)
  if (i === -1) return [...items, item]
  const next = items.slice()
  next[i] = item
  return next
}

/**
 * Sends a message (`messages.send`) through the conversation's outbox. Concurrent: several drafts
 * can be in flight; read per-message status from `outboxAtom(conversationId)`, not from this atom.
 */
/** One nonce per draft object: a re-run of the same send (see once.ts) can never mint a new message. */
const draftNonces = new WeakMap<object, string>()
const nonceFor = (draft: SendDraft): string => {
  if (draft.clientNonce !== undefined) return draft.clientNonce
  const known = draftNonces.get(draft)
  if (known !== undefined) return known
  const fresh = newClientNonce()
  draftNonces.set(draft, fresh)
  return fresh
}

export const sendMessageAtom = OpenBotClient.runtime.fn(
  (draft: SendDraft) => once(draft, sendOnce(draft)),
  { concurrent: true },
)

const sendOnce = (draft: SendDraft) =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const client = yield* OpenBotClient
      const clientNonce = nonceFor(draft)
      const input = { ...draft, clientNonce } as SendInput
      const outbox = outboxAtom(input.conversationId)
      const existing = registry.get(outbox).find((o) => o.clientNonce === clientNonce)
      const base: OutboxItem = { clientNonce, input, status: "sending", createdAt: existing?.createdAt ?? Date.now() }
      registry.update(outbox, (items) => upsertItem(items, base))

      return yield* client("messages.send", input).pipe(
        Effect.retry({
          while: (e) => e instanceof RpcClientError.RpcClientError,
          schedule: Schedule.exponential("250 millis", 2),
          times: SEND_RETRY_TIMES,
        }),
        Effect.tap((result) =>
          Effect.sync(() => {
            // A duplicate means the entry already exists (and was already streamed): nothing to wait for.
            if (result.disposition === "duplicate") {
              registry.update(outbox, (items) => items.filter((o) => o.clientNonce !== clientNonce))
              return
            }
            // The stream may already have delivered the entry and removed the item.
            if (registry.get(outbox).some((o) => o.clientNonce === clientNonce)) {
              registry.update(outbox, (items) => upsertItem(items, { ...base, status: "sent", result }))
            }
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            // Gone already = its entry arrived on the stream, so it was delivered after all.
            if (registry.get(outbox).some((o) => o.clientNonce === clientNonce)) {
              registry.update(outbox, (items) => upsertItem(items, { ...base, status: "failed", error: describeError(error) }))
            }
          }),
        ),
      )
    })

/** Re-sends a failed outbox item with its original nonce (idempotent). Set with `{conversationId, clientNonce}`. */
export const retrySendAtom = Atom.writable(
  () => undefined,
  (ctx, target: { readonly conversationId: ConversationId; readonly clientNonce: string }) => {
    const item = ctx.get(outboxAtom(target.conversationId)).find((o) => o.clientNonce === target.clientNonce)
    // A fresh draft object (same nonce): a real, idempotent retry rather than a replay of the failure.
    if (item !== undefined) ctx.set(sendMessageAtom, { ...item.input })
  },
)

/** Drops an outbox item (the user dismissed a failed draft). */
export const discardOutboxItemAtom = Atom.writable(
  () => undefined,
  (ctx, target: { readonly conversationId: ConversationId; readonly clientNonce: string }) => {
    const outbox = outboxAtom(target.conversationId)
    ctx.set(
      outbox,
      ctx.get(outbox).filter((o) => o.clientNonce !== target.clientNonce),
    )
  },
)
