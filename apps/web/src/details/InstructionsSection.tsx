// Details › Instructions (D0.4 "visible, editable instructions"): the bot's persona text, editable in
// place (bots.update), plus the full rendered prompt the harness receives (bots.readContext).
import { botContextAtom } from "@openbot/client"
import type { Bot } from "@openbot/contracts"
import { Dialog, DialogBody, DialogHeader, IconButton, PillButton, TextArea } from "@openbot/ui"
import { Pencil } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ErrorLine, LoadingLine, Section, SectionSheet, useCommand, useQuery } from "./kit.tsx"

export function InstructionsSection({ bot }: { readonly bot: Bot }): ReactNode {
  const update = useCommand("bots.update", `${bot.id}/instructions`)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(bot.instructions)
  const [showPrompt, setShowPrompt] = useState(false)

  const start = () => {
    setDraft(bot.instructions)
    setEditing(true)
  }
  const save = async () => {
    const r = await update.run({ botId: bot.id, patch: { instructions: draft } })
    if (r.ok) setEditing(false)
  }

  return (
    <Section
      title="Instructions"
      id="details-instructions"
      trailing={
        !editing && (
          <IconButton
            icon={Pencil}
            label="Edit instructions"
            size={24}
            iconSize="sm"
            onClick={start}
            data-testid="edit-instructions"
          />
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea
            aria-label="Instructions"
            data-testid="instructions-input"
            rows={9}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void save()
              } else if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setEditing(false)
              }
            }}
            placeholder={`Describe ${bot.name}'s job, tone and how it should work.`}
            className="text-sm"
          />
          {update.error && <ErrorLine>{update.error}</ErrorLine>}
          <div className="flex items-center justify-end gap-2">
            <PillButton variant="ghost" size="md" onClick={() => setEditing(false)}>
              Cancel
            </PillButton>
            <PillButton
              variant="primary"
              size="md"
              loading={update.pending}
              onClick={() => void save()}
              data-testid="save-instructions"
            >
              Save
            </PillButton>
          </div>
        </div>
      ) : (
        <SectionSheet>
          <button
            type="button"
            onClick={start}
            className="rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-hover"
            data-testid="instructions-text"
          >
            {bot.instructions.trim() ? (
              <p className="line-clamp-6 text-sm whitespace-pre-wrap text-fg">{bot.instructions}</p>
            ) : (
              <p className="text-sm text-fg-tertiary">
                Tell {bot.name} what its job is. It reads this before every task.
              </p>
            )}
          </button>
        </SectionSheet>
      )}
      <button
        type="button"
        onClick={() => setShowPrompt(true)}
        className="w-fit px-3 text-xs text-fg-tertiary transition-colors hover:text-fg-secondary"
      >
        Show the full prompt ›
      </button>
      {showPrompt && <RenderedPromptDialog bot={bot} onClose={() => setShowPrompt(false)} />}
    </Section>
  )
}

function RenderedPromptDialog({ bot, onClose }: { readonly bot: Bot; readonly onClose: () => void }): ReactNode {
  const ctx = useQuery(botContextAtom(bot.id))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={640} height={560} label={`${bot.name}'s full prompt`}>
      <DialogHeader
        title={`${bot.name}'s full prompt`}
        description="What the harness receives: instructions, team, memory index and where tools run."
        onClose={onClose}
      />
      <DialogBody>
        {ctx.loading ? (
          <LoadingLine />
        ) : ctx.error && !ctx.value ? (
          <ErrorLine onRetry={ctx.refresh}>{ctx.error}</ErrorLine>
        ) : (
          <pre className="rounded-xl bg-quaternary p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-fg-secondary hairline border-line-quaternary">
            {ctx.value?.instructions}
          </pre>
        )}
      </DialogBody>
    </Dialog>
  )
}
