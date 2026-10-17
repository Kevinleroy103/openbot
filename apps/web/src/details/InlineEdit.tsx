// Click-to-edit text (Grok details pane: the name "becomes a field with a 1 px transparent border",
// and "Add a label"). Enter / blur saves, Escape cancels. Empty values are allowed only when
// `allowEmpty` (the label), else the edit is discarded.
import { cn } from "@openbot/ui"
import { type ReactNode, useEffect, useRef, useState } from "react"

export interface InlineEditProps {
  readonly value: string
  readonly placeholder: string
  readonly onSave: (next: string) => Promise<unknown> | void
  readonly allowEmpty?: boolean
  readonly maxLength?: number
  readonly label: string
  /** Typography + color for both the text and the field. */
  readonly className?: string
  readonly placeholderClassName?: string
  readonly testId?: string
  /** Open in edit mode (e.g. after "Rename" in a menu). */
  readonly startEditing?: boolean
  /** Called whenever editing ends (saved or cancelled). */
  readonly onEditEnd?: () => void
}

export function InlineEdit({
  value,
  placeholder,
  onSave,
  allowEmpty = false,
  maxLength = 64,
  label,
  className,
  placeholderClassName,
  testId,
  startEditing = false,
  onEditEnd,
}: InlineEditProps): ReactNode {
  const [editing, setEditingState] = useState(startEditing)
  const setEditing = (on: boolean) => {
    setEditingState(on)
    if (!on) onEditEnd?.()
  }
  // the draft only matters while editing; it is seeded from `value` each time editing starts
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    if (editing) {
      done.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const start = () => {
    setDraft(value)
    setEditing(true)
  }
  const cancel = () => {
    done.current = true
    setEditing(false)
  }
  const commit = () => {
    if (done.current) return
    done.current = true
    const next = draft.trim()
    setEditing(false)
    if (next === value.trim()) return
    if (!next && !allowEmpty) return
    void onSave(next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={label}
        data-testid={testId ? `${testId}-input` : undefined}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            cancel()
          }
        }}
        className={cn(
          "w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-center outline-none focus:border-line-secondary focus-visible:outline-none",
          className,
        )}
      />
    )
  }
  return (
    <button
      type="button"
      aria-label={`${label}: ${value || placeholder}`}
      data-testid={testId}
      onClick={start}
      className={cn("max-w-full truncate rounded-md border border-transparent px-1 transition-colors hover:bg-hover", className, !value && (placeholderClassName ?? "text-fg-tertiary"))}
    >
      {value || placeholder}
    </button>
  )
}
