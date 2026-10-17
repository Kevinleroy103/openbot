// Bot autonomy (Grok "Allow automatically", OpenBot `Bot.autonomy`): what a Bot may do without asking
// when none of your Permissions rules decides. Shared by Details › Brain, New Bot and Settings › Permissions.
// Also the project-folder list editor (Settings' shared folders, a Bot's own folders): folders that
// count as the Bot's workspace.
import { type BotAutonomy, cleanProjectFolders, MAX_PROJECT_FOLDERS, normalizeProjectFolder, projectFolderProblem } from "@openbot/contracts"
import { Icon, IconButton, PillButton, Select, type SelectOption, TextField, cn } from "@openbot/ui"
import { Folder, TriangleAlert, X } from "lucide-react"
import { type ReactNode, useState } from "react"

export const AUTONOMY_CHOICES: ReadonlyArray<{ readonly value: BotAutonomy; readonly label: string; readonly hint: string }> = [
  { value: "ask", label: "Ask first", hint: "Asks you before it runs commands or changes files." },
  { value: "workspace", label: "Auto in workspace", hint: "Works freely in its own workspace and project folders; asks before anything outside them." },
  { value: "full", label: "Full auto", hint: "Never asks: runs any command and changes any file on its computer." },
]

export const autonomyChoice = (value: BotAutonomy) => AUTONOMY_CHOICES.find((c) => c.value === value) ?? AUTONOMY_CHOICES[1]!

const OPTIONS: ReadonlyArray<SelectOption<BotAutonomy>> = AUTONOMY_CHOICES.map((c) => ({ value: c.value, label: c.label }))

export function AutonomySelect({
  value,
  onValueChange,
  disabled,
  align,
  className,
  label = "Autonomy",
}: {
  readonly value: BotAutonomy
  readonly onValueChange: (value: BotAutonomy) => void
  readonly disabled?: boolean
  readonly align?: "start" | "end"
  readonly className?: string
  readonly label?: string
}): ReactNode {
  return (
    <Select
      label={label}
      value={value}
      options={OPTIONS}
      onValueChange={onValueChange}
      {...(disabled === undefined ? {} : { disabled })}
      {...(align === undefined ? {} : { align })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

/** "Full auto" warning (shown wherever the choice is made). */
export function FullAutoWarning({ name, className }: { readonly name?: string; readonly className?: string }): ReactNode {
  return (
    <div role="note" data-testid="full-auto-warning" className={cn("flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-fg", className)}>
      <Icon icon={TriangleAlert} size="sm" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {name ?? "This Bot"} won't ask before running commands or changing files anywhere on its computer. Your “Never allow” rules still apply.
      </span>
    </div>
  )
}

/**
 * An editable list of project folders (absolute paths on the Bot's computer, `~/…` allowed).
 * `onChange` gets the whole new list (normalized, validated with `projectFolderProblem`) and resolves
 * `true` when saved.
 */
export function FolderListEditor({
  folders,
  onChange,
  pending,
  placeholder = "~/projects or /srv/code",
  testId,
  emptyText = "No project folders.",
  className,
}: {
  readonly folders: ReadonlyArray<string>
  readonly onChange: (next: ReadonlyArray<string>) => Promise<boolean>
  readonly pending?: boolean
  readonly placeholder?: string
  readonly testId?: string
  readonly emptyText?: string
  readonly className?: string
}): ReactNode {
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const add = async () => {
    const value = draft.trim()
    const why = projectFolderProblem(value)
    if (why !== undefined) return setProblem(why)
    if (folders.length >= MAX_PROJECT_FOLDERS) return setProblem(`At most ${MAX_PROJECT_FOLDERS} folders.`)
    const cleaned = cleanProjectFolders([...folders, value])
    if ("problem" in cleaned) return setProblem(cleaned.problem)
    if (cleaned.folders.length === folders.length) return setProblem(`${normalizeProjectFolder(value)} is already in the list.`)
    setProblem(undefined)
    if (await onChange(cleaned.folders)) setDraft("")
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-testid={testId}>
      {folders.length === 0 ? (
        <p className="text-sm text-fg-tertiary">{emptyText}</p>
      ) : (
        <ul className="flex flex-col">
          {folders.map((folder) => (
            <li key={folder} className="flex min-h-8 items-center gap-2" data-folder={folder}>
              <Icon icon={Folder} size="sm" className="shrink-0 text-icon-tertiary" />
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={folder}>
                {folder}
              </code>
              <IconButton
                icon={X}
                label={`Remove ${folder}`}
                size={24}
                iconSize="sm"
                disabled={pending}
                onClick={() => void onChange(folders.filter((f) => f !== folder))}
              />
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <TextField
          aria-label="Add a project folder"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setProblem(undefined)
          }}
          placeholder={placeholder}
          size="sm"
          wrapperClassName="min-w-0 flex-1"
          className="font-mono text-sm"
        />
        <PillButton type="submit" size="sm" disabled={pending || draft.trim() === ""} loading={pending}>
          Add
        </PillButton>
      </form>
      {problem && (
        <p role="alert" className="text-xs text-danger-fg">
          {problem}
        </p>
      )}
    </div>
  )
}
