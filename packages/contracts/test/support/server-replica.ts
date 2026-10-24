// TEST HELPER ONLY: a minimal in-memory server-side conversation replica (sequence numbers, change
// log, snapshot / `after` resume) built on the pure contracts reducers. core's LiveHub owns the real one.
import {
  applyConversationChange,
  compareEntries,
  type Conversation,
  type ConversationState,
  emptyConversationState,
  type KnownConversationChange,
  type KnownConversationStreamItem,
  type KnownTranscriptEntry,
  MAX_REPLAY_GAP,
  resumePlan,
  SNAPSHOT_TAIL_ENTRIES,
  type StreamCursor,
} from "../../src/index.ts"

type ChangeItem = Extract<KnownConversationStreamItem, { kind: "change" }>

export class ServerReplica {
  epoch: string
  sequence = 0
  state: ConversationState
  readonly log: ChangeItem[] = []

  constructor(conversation: Conversation) {
    this.epoch = conversation.epoch
    this.state = { ...emptyConversationState, conversation }
  }

  get head(): StreamCursor {
    return { epoch: this.epoch, sequence: this.sequence }
  }

  apply(change: KnownConversationChange): ChangeItem {
    this.state = applyConversationChange(this.state, change)
    const item: ChangeItem = { kind: "change", cursor: { epoch: this.epoch, sequence: ++this.sequence }, change }
    this.log.push(item)
    if (this.log.length > MAX_REPLAY_GAP) this.log.shift()
    return item
  }

  snapshot(tailLimit = SNAPSHOT_TAIL_ENTRIES): Extract<KnownConversationStreamItem, { kind: "snapshot" }> {
    const all = [...this.state.entries.values()].sort(compareEntries) as KnownTranscriptEntry[]
    const window = all.slice(Math.max(0, all.length - tailLimit))
    const ids = new Set(window.map((e) => e.id))
    return {
      kind: "snapshot",
      cursor: this.head,
      conversation: this.state.conversation!,
      entries: window,
      requests: [...this.state.requests.values()].filter((r) => r.status === "pending" || ids.has(r.cardEntryId)),
      turns: [...this.state.turns.values()],
      hasMoreBefore: window.length < all.length,
      beforeCursor: window.length < all.length ? `before:${window[0]!.id}` : null,
    }
  }

  /** What `conversations.subscribe({ after })` sends before going live. */
  subscribe(after?: StreamCursor, tailLimit?: number): KnownConversationStreamItem[] {
    const oldest = this.log[0]?.cursor.sequence ?? this.sequence + 1
    if (resumePlan(after, this.head, oldest) === "replay") {
      return [
        ...this.log.filter((i) => i.cursor.sequence > after!.sequence),
        { kind: "synchronized", cursor: this.head },
      ]
    }
    return [this.snapshot(tailLimit), { kind: "synchronized", cursor: this.head }]
  }

  /** New session / rollback: new epoch, empty replica, then clients get a snapshot. */
  reset(epoch: string, reason: "new-session" | "rollback" | "rebuild"): KnownConversationStreamItem {
    this.epoch = epoch
    this.sequence = 0
    this.log.length = 0
    this.state = { ...emptyConversationState, conversation: { ...this.state.conversation!, epoch } }
    return { kind: "reset", epoch, reason }
  }
}
