import type { CardState, EntryId, UiCard as UiCardModel, UiValues } from "@openbot/contracts"
import { Card, CardActions, CardHeader, Icon, PillButton, StatusPill, cn } from "@openbot/ui"
import { ChevronDown } from "lucide-react"
import { useId, useState, type ReactNode } from "react"
import { UiBlockView } from "./UiBlocks.tsx"
import { useCommand } from "../details/kit.tsx"
import type { CardViewProps } from "./Cards.tsx"

export function UiCard({ card, state, entryId, className }: CardViewProps & { readonly card: UiCardModel }): ReactNode {
  const act = useCommand("cards.act", entryId ?? "")
  return (
    <UiCardContent
      card={card}
      state={state}
      entryId={entryId}
      pending={act.pending}
      error={act.error}
      className={className}
      onAct={(actionId, values) => {
        if (entryId !== undefined) void act.run({ entryId, actionId, values })
      }}
    />
  )
}

export function UiCardContent({
  card,
  state,
  entryId,
  pending,
  error,
  onAct,
  className,
}: {
  readonly card: UiCardModel
  readonly state: CardState
  readonly entryId?: EntryId | undefined
  readonly pending: boolean
  readonly error?: string | undefined
  readonly onAct: (actionId: string, values: UiValues) => void
  readonly className?: string | undefined
}): ReactNode {
  const id = useId()
  const [expanded, setExpanded] = useState(!card.collapsed)
  const [actionId, setActionId] = useState<string>()
  const [edited, setEdited] = useState(() => new Map<string, string | ReadonlyArray<string>>())
  const answered = state.status === "resolved"
  const inputs: Record<string, string | ReadonlyArray<string>> = Object.create(null)
  for (const block of card.blocks) {
    if (block.type === "choice") inputs[block.id] = edited.get(block.id) ?? block.default ?? []
    if (block.type === "input") inputs[block.id] = edited.get(block.id) ?? block.default ?? ""
  }
  const values = answered ? (state.answer?.values ?? {}) : inputs
  if (card.version !== 1)
    return (
      <Card className={cn("max-w-[min(100%,560px)]!", className)} data-card="ui" data-status={state.status}>
        <p className="text-base break-words">{card.fallback}</p>
      </Card>
    )
  const disabled = pending || state.status !== "pending" || entryId === undefined
  return (
    <Card
      className={cn("min-w-0 max-w-[min(100%,560px)]! break-words", className)}
      data-card="ui"
      data-status={state.status}
      aria-label={card.title ?? "Bot reply"}
    >
      {card.collapsed ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-blocks`}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 items-center gap-2 text-start text-base"
        >
          <span className="min-w-0 flex-1">{card.fallback}</span>
          {answered && <StatusPill tone="success">Answered</StatusPill>}
          <Icon icon={ChevronDown} size="md" className={cn("shrink-0 text-icon-tertiary", expanded && "rotate-180")} />
        </button>
      ) : (
        (card.title || card.subtitle || answered) && (
          <CardHeader
            title={card.title ?? ""}
            subtitle={card.subtitle}
            status={answered ? <StatusPill tone="success">Answered</StatusPill> : undefined}
          />
        )
      )}
      {expanded && (
        <div id={`${id}-blocks`} className="flex min-w-0 flex-col gap-2.5">
          {card.collapsed && (card.title || card.subtitle) && (
            <CardHeader title={card.title ?? ""} subtitle={card.subtitle} />
          )}
          {card.blocks.map((block, index) => (
            <UiBlockView
              key={index}
              block={block}
              values={values}
              onChange={(key, value) => setEdited((current) => new Map(current).set(key, value))}
              disabled={disabled}
              answered={answered}
              namePrefix={id}
            />
          ))}
          {answered && (
            <p className="text-sm text-fg-secondary">
              Sent: {card.actions?.find((action) => action.id === state.answer?.actionId)?.label}
            </p>
          )}
          {error && !answered && (
            <p role="alert" className="text-sm text-danger-fg">
              {error}
            </p>
          )}
          {card.actions && card.actions.length > 0 && (
            <CardActions>
              {card.actions.map((action) => (
                <PillButton
                  key={action.id}
                  variant={action.style ?? "secondary"}
                  size="card"
                  className="min-h-11 max-w-full whitespace-normal"
                  disabled={disabled}
                  loading={pending && actionId === action.id}
                  onClick={() => {
                    setActionId(action.id)
                    onAct(action.id, values)
                  }}
                >
                  {action.label}
                </PillButton>
              ))}
            </CardActions>
          )}
        </div>
      )}
    </Card>
  )
}
