// Details › Library: the skills library (D5.5; skills.list / upsert / delete). Skills are shared by
// every Bot in v1 (per-bot subsets are v1.1). Workspace files have no RPC yet (interfaces.md §9).
import { skillsAtom } from "@openbot/client"
import type { Bot, Skill, SkillName } from "@openbot/contracts"
import { Dialog, DialogBody, DialogFooter, DialogHeader, Icon, IconButton, PillButton, TextArea, TextField } from "@openbot/ui"
import { ChevronRight, Plus, Sparkles, Trash2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ConfirmDialog, EmptyNote, ErrorLine, LoadingLine, Section, SectionSheet, formatAgo, useCommand, useQuery } from "./kit.tsx"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)

export function LibraryTab({ bot }: { readonly bot: Bot }): ReactNode {
  const skills = useQuery(skillsAtom)
  const [editing, setEditing] = useState<Skill | "new" | undefined>(undefined)
  const list = [...(skills.value ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className="flex flex-col gap-6">
      <Section title="Skills" trailing={<IconButton icon={Plus} label="New skill" size={24} iconSize="sm" onClick={() => setEditing("new")} data-testid="new-skill" />}>
        {skills.loading ? (
          <LoadingLine />
        ) : skills.error && !skills.value ? (
          <ErrorLine onRetry={skills.refresh}>{skills.error}</ErrorLine>
        ) : list.length === 0 ? (
          <EmptyNote>Skills are reusable how-tos your Bots follow. Ask {bot.name} to save one, or add one here.</EmptyNote>
        ) : (
          <SectionSheet>
            {list.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => setEditing(s)}
                data-testid="skill-row"
                className="flex min-h-12 items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-hover"
              >
                <Icon icon={Sparkles} size="md" className="text-accent" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg">{s.name}</span>
                  <span className="truncate text-sm text-fg-secondary">{s.description || "No description"}</span>
                </div>
                <Icon icon={ChevronRight} size="xs" className="text-icon-tertiary" />
              </button>
            ))}
          </SectionSheet>
        )}
        <p className="px-3 text-2xs text-fg-quaternary">Every Bot can use the skills library.</p>
      </Section>
      {editing && <SkillDialog skill={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function SkillDialog({ skill, onClose }: { readonly skill: Skill | undefined; readonly onClose: () => void }): ReactNode {
  const upsert = useCommand("skills.upsert", skill?.name ?? "new")
  const del = useCommand("skills.delete", skill?.name ?? "new")
  const [name, setName] = useState<string>(skill?.name ?? "")
  const [description, setDescription] = useState(skill?.description ?? "")
  const [body, setBody] = useState(skill?.body ?? "")
  const [confirm, setConfirm] = useState(false)
  const finalName = skill ? skill.name : slug(name)
  const save = async () => {
    const r = await upsert.run({ name: finalName as SkillName, description: description.trim(), body })
    if (r.ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={600} label={skill ? `Skill ${skill.name}` : "New skill"}>
      <DialogHeader title={skill ? skill.name : "New skill"} description={skill ? `Updated ${formatAgo(skill.updatedAt)}` : "A SKILL.md every Bot can use."} onClose={onClose} />
      <DialogBody className="flex flex-col gap-3">
        {!skill && (
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="weekly-report"
            description={name && finalName !== name ? `Saved as ${finalName}` : "Lower-case letters, digits and dashes."}
            data-autofocus
          />
        )}
        <TextField label="When to use it" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when asked for the weekly status report" />
        <TextArea label="Instructions (markdown)" rows={12} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
        {(upsert.error ?? del.error) && <ErrorLine className="px-0">{upsert.error ?? del.error}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        {skill && <IconButton icon={Trash2} label="Delete skill" size={36} variant="secondary" className="me-auto" onClick={() => setConfirm(true)} />}
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Cancel
        </PillButton>
        <PillButton variant="primary" size="card" disabled={!finalName || !description.trim()} loading={upsert.pending} onClick={() => void save()}>
          Save
        </PillButton>
      </DialogFooter>
      {skill && (
        <ConfirmDialog
          open={confirm}
          title={`Delete ${skill.name}?`}
          body="No Bot will be able to use it any more."
          confirmLabel="Delete"
          danger
          pending={del.pending}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            const r = await del.run({ name: skill.name })
            if (r.ok) onClose()
          }}
        />
      )}
    </Dialog>
  )
}
