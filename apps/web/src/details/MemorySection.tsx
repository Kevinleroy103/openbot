// Details › Memory (D5.4): the bot's facts (one file each) and the MEMORY.md index, viewable and
// editable (memory.get / putFact / deleteFact / setIndex).
import { memoryAtom } from "@openbot/client"
import type { Bot, MemoryFact } from "@openbot/contracts"
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  PillButton,
  TextArea,
  TextField,
} from "@openbot/ui"
import { BookOpen, ChevronRight, Plus, Trash2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { EmptyNote, ErrorLine, LoadingLine, Section, SectionSheet, formatAgo, useCommand, useQuery } from "./kit.tsx"

const SHOWN = 5

export function MemorySection({ bot }: { readonly bot: Bot }): ReactNode {
  const memory = useQuery(memoryAtom(bot.id))
  const [editing, setEditing] = useState<MemoryFact | "new" | undefined>(undefined)
  const [indexOpen, setIndexOpen] = useState(false)
  const [all, setAll] = useState(false)
  const facts = [...(memory.value?.facts ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const shown = all ? facts : facts.slice(0, SHOWN)

  return (
    <Section
      title="Memory"
      id="details-memory"
      trailing={
        <IconButton icon={Plus} label="Add a memory" size={24} iconSize="sm" onClick={() => setEditing("new")} />
      }
    >
      {memory.loading ? (
        <LoadingLine />
      ) : memory.error && !memory.value ? (
        <ErrorLine onRetry={memory.refresh}>{memory.error}</ErrorLine>
      ) : (
        <SectionSheet>
          {shown.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setEditing(f)}
              data-testid="memory-fact"
              className="flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-hover"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg">{f.title}</span>
                {(f.description || f.body) && (
                  <span className="truncate text-xs text-fg-tertiary">{f.description || f.body}</span>
                )}
              </div>
              <Icon icon={ChevronRight} size="xs" className="text-icon-tertiary" />
            </button>
          ))}
          {facts.length === 0 && (
            <EmptyNote className="py-2">
              Nothing remembered yet. {bot.name} saves facts here as it learns about you and your work.
            </EmptyNote>
          )}
          {facts.length > SHOWN && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="rounded-lg px-2 py-1.5 text-start text-sm text-fg-secondary transition-colors hover:bg-hover"
            >
              {all ? "Show less" : `Show all ${facts.length}`}
            </button>
          )}
          <button
            type="button"
            onClick={() => setIndexOpen(true)}
            className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm text-fg-secondary transition-colors hover:bg-hover"
          >
            <Icon icon={BookOpen} size="sm" className="text-icon-tertiary" />
            <span className="flex-1">Memory index</span>
            <span className="font-mono text-2xs text-fg-quaternary">MEMORY.md</span>
          </button>
        </SectionSheet>
      )}
      {editing && (
        <FactDialog bot={bot} fact={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} />
      )}
      {indexOpen && <IndexDialog bot={bot} index={memory.value?.index ?? ""} onClose={() => setIndexOpen(false)} />}
    </Section>
  )
}

function FactDialog({
  bot,
  fact,
  onClose,
}: {
  readonly bot: Bot
  readonly fact: MemoryFact | undefined
  readonly onClose: () => void
}): ReactNode {
  const put = useCommand("memory.putFact", `${bot.id}/${fact?.id ?? "new"}`)
  const del = useCommand("memory.deleteFact", `${bot.id}/${fact?.id ?? "new"}`)
  const [title, setTitle] = useState(fact?.title ?? "")
  const [description, setDescription] = useState(fact?.description ?? "")
  const [body, setBody] = useState(fact?.body ?? "")
  const save = async () => {
    const r = await put.run({
      botId: bot.id,
      fact: {
        ...(fact ? { id: fact.id } : {}),
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        body,
      },
    })
    if (r.ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={520} label={fact ? "Edit memory" : "New memory"}>
      <DialogHeader
        title={fact ? "Edit memory" : "New memory"}
        description={fact ? `Updated ${formatAgo(fact.updatedAt)}` : `Something ${bot.name} should always remember.`}
        onClose={onClose}
      />
      <DialogBody className="flex flex-col gap-3">
        <TextField
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Prefers short summaries"
          data-autofocus
        />
        <TextField
          label="One-line hook (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Shown in the memory index"
        />
        <TextArea
          label="Details"
          rows={7}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="The fact, with any context that helps."
          className="text-sm"
        />
        {(put.error ?? del.error) && <ErrorLine className="px-0">{put.error ?? del.error}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        {fact && (
          <PillButton
            variant="danger-soft"
            size="card"
            leadingIcon={Trash2}
            loading={del.pending}
            className="me-auto"
            onClick={async () => {
              const r = await del.run({ botId: bot.id, factId: fact.id })
              if (r.ok) onClose()
            }}
          >
            Forget
          </PillButton>
        )}
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Cancel
        </PillButton>
        <PillButton
          variant="primary"
          size="card"
          disabled={!title.trim()}
          loading={put.pending}
          onClick={() => void save()}
        >
          Save
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}

function IndexDialog({
  bot,
  index,
  onClose,
}: {
  readonly bot: Bot
  readonly index: string
  readonly onClose: () => void
}): ReactNode {
  const set = useCommand("memory.setIndex", bot.id)
  const [draft, setDraft] = useState(index)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={600} label="Memory index">
      <DialogHeader
        title="Memory index"
        description={`MEMORY.md: the short list ${bot.name} reads at the start of every session. Keep it brief.`}
        onClose={onClose}
      />
      <DialogBody>
        <TextArea
          aria-label="Memory index"
          rows={14}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="font-mono text-xs"
          data-autofocus
        />
        {set.error && <ErrorLine className="px-0">{set.error}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Cancel
        </PillButton>
        <PillButton
          variant="primary"
          size="card"
          loading={set.pending}
          onClick={async () => {
            const r = await set.run({ botId: bot.id, index: draft })
            if (r.ok) onClose()
          }}
        >
          Save
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}
