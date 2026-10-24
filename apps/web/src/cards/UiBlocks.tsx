import type { UiBlock, UiValues } from "@openbot/contracts"
import { imageSrc } from "@openbot/app-model"
import { CardTable, Icon, Sheet, SheetField, StatusPill, TextArea, TextField, cn } from "@openbot/ui"
import { Check, Circle, CircleAlert, Clock, ExternalLink } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Markdown, safeHref } from "../chat/Markdown.tsx"
import { UiChart } from "./UiChart.tsx"

const stepStyle = {
  done: { icon: Check, tone: "success", label: "Done", className: "bg-success-soft text-success-fg" },
  active: { icon: Clock, tone: "accent", label: "In progress", className: "bg-accent-soft text-accent-fg" },
  upcoming: { icon: Circle, tone: "neutral", label: "Upcoming", className: "bg-secondary text-icon-tertiary" },
  failed: { icon: CircleAlert, tone: "danger", label: "Failed", className: "bg-danger-soft text-danger-fg" },
} as const

export function UiBlockView({
  block,
  values,
  onChange,
  disabled,
  answered,
  namePrefix,
}: {
  readonly block: UiBlock
  readonly values: UiValues
  readonly onChange: (id: string, value: string | ReadonlyArray<string>) => void
  readonly disabled: boolean
  readonly answered: boolean
  readonly namePrefix: string
}): ReactNode {
  switch (block.type) {
    case "text":
      return (
        <div data-ui-block="text">
          <Markdown text={block.markdown} uiCard />
        </div>
      )
    case "fields":
      return (
        <Sheet>
          {block.items.map((item, index) => (
            <SheetField key={index} label={item.label} className="items-start break-words">
              {item.value}
            </SheetField>
          ))}
        </Sheet>
      )
    case "table":
      return <CardTable columns={block.columns} rows={block.rows} />
    case "options":
      return (
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]"
          data-ui-block="options"
        >
          {block.items.map((item) => (
            <div
              key={item.id}
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-xl border bg-elevated p-3 break-words",
                item.id === block.pick ? "border-accent-fg" : "border-line-quaternary",
              )}
            >
              {(item.id === block.pick || item.badge) && (
                <div>
                  <StatusPill
                    tone={item.id === block.pick ? "accent" : "neutral"}
                    className="h-auto! min-h-6 max-w-full whitespace-normal!"
                  >
                    <span className="min-w-0 break-words">{item.id === block.pick ? "My pick" : item.badge}</span>
                  </StatusPill>
                </div>
              )}
              <div>
                <div className="text-base font-medium">{item.title}</div>
                {item.subtitle && <p className="mt-0.5 text-sm text-fg-secondary">{item.subtitle}</p>}
              </div>
              {item.lines && (
                <ul className="flex flex-col gap-1 text-sm text-fg-secondary">
                  {item.lines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              )}
              {item.value && <p className="mt-auto text-2xl font-medium tabular-nums">{item.value}</p>}
              {item.note && <p className="text-xs text-fg-secondary">{item.note}</p>}
            </div>
          ))}
        </div>
      )
    case "stats":
      return (
        <div
          className="grid grid-cols-[repeat(auto-fit,minmax(85px,1fr))] gap-y-3 rounded-xl bg-elevated py-3"
          data-ui-block="stats"
        >
          {block.items.map((item, index) => (
            <div key={index} className="min-w-0 border-s border-line-secondary px-3 first:border-s-0">
              <p className="text-xs text-fg-secondary">{item.label}</p>
              <p className="my-1 text-2xl font-medium break-words tabular-nums">{item.value}</p>
              {item.delta && (
                <p
                  className={cn(
                    "text-xs",
                    item.tone === "good" && "text-success-fg",
                    item.tone === "bad" && "text-danger-fg",
                    (!item.tone || item.tone === "neutral") && "text-fg-secondary",
                  )}
                >
                  {item.delta}
                </p>
              )}
            </div>
          ))}
        </div>
      )
    case "checklist":
      return (
        <Sheet>
          {block.items.map((item, index) => {
            const style = stepStyle[item.status]
            return (
              <div key={index} className="flex items-start gap-2.5 p-3">
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", style.className)}>
                  <Icon icon={style.icon} size="sm" />
                </span>
                <div className="min-w-0 flex-1 break-words">
                  <p className="text-base">{item.label}</p>
                  {item.detail && <p className="mt-0.5 text-sm text-fg-secondary">{item.detail}</p>}
                  <span className="sr-only">{style.label}</span>
                </div>
                <StatusPill tone={style.tone} className="hidden sm:inline-flex">
                  {style.label}
                </StatusPill>
              </div>
            )
          })}
        </Sheet>
      )
    case "timeline":
      return (
        <ol className="rounded-xl bg-elevated px-3" data-ui-block="timeline">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-2.5">
              <span className="w-12 shrink-0 pt-3 text-sm tabular-nums">{item.time}</span>
              <span className="relative w-2 shrink-0">
                <span className="absolute top-5 size-2 rounded-full bg-accent-fg" />
                {index < block.items.length - 1 && (
                  <span className="absolute top-7 bottom-[-20px] left-[3.5px] w-px bg-line-secondary" />
                )}
              </span>
              <div className="min-w-0 flex-1 py-3 break-words">
                <p className="text-base">{item.title}</p>
                {item.detail && <p className="mt-0.5 text-sm text-fg-secondary">{item.detail}</p>}
                {item.tag && (
                  <span className="mt-1 inline-block rounded-sm bg-secondary px-1.5 text-xs text-fg-secondary">
                    {item.tag}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )
    case "chart":
      return <UiChart block={block} />
    case "image":
      return <UiImage key={block.attachmentId} attachmentId={block.attachmentId} alt={block.alt} />
    case "link": {
      const href = safeHref(block.url)
      if (!href || !/^https:\/\//i.test(href)) return <p className="text-sm text-fg-secondary">{block.label}</p>
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="flex w-fit items-center gap-1 text-base text-accent-fg hover:underline"
        >
          <span className="break-words">{block.label}</span>
          <Icon icon={ExternalLink} size="sm" className="shrink-0" />
        </a>
      )
    }
    case "choice": {
      const selected = values[block.id]
      const picked = Array.isArray(selected) ? selected : []
      if (answered)
        return (
          <Sheet>
            <SheetField label={block.label} className="items-start break-words">
              {block.options
                .filter((option) => picked.includes(option.id))
                .map((option) => option.label)
                .join(", ") || "None selected"}
            </SheetField>
          </Sheet>
        )
      return (
        <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-1.5" data-ui-block="choice">
          <legend className="mb-1.5 text-xs text-fg-secondary">{block.label}</legend>
          {block.options.map((option) => (
            <label
              key={option.id}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border bg-elevated p-3 has-focus-visible:outline-2 has-focus-visible:outline-focus",
                picked.includes(option.id) ? "border-accent-fg" : "border-transparent",
                disabled && "cursor-default",
              )}
            >
              <input
                type={block.mode === "one" ? "radio" : "checkbox"}
                name={`${namePrefix}-${block.id}`}
                value={option.id}
                checked={picked.includes(option.id)}
                onChange={() => {
                  let next = [option.id]
                  if (block.mode === "many")
                    next = picked.includes(option.id) ? picked.filter((id) => id !== option.id) : [...picked, option.id]
                  onChange(block.id, next)
                }}
                className="size-4 shrink-0 accent-accent-fg"
              />
              <span className="min-w-0 flex-1 break-words text-base">
                {option.label}
                {option.detail && <span className="mt-0.5 block text-sm text-fg-secondary">{option.detail}</span>}
              </span>
              {option.badge && (
                <StatusPill className="h-auto! min-h-6 max-w-[45%] whitespace-normal!">
                  <span className="min-w-0 break-words">{option.badge}</span>
                </StatusPill>
              )}
            </label>
          ))}
        </fieldset>
      )
    }
    case "input": {
      const value = values[block.id]
      const text = typeof value === "string" ? value : ""
      if (answered)
        return (
          <Sheet>
            <SheetField label={block.label} className="items-start break-words whitespace-pre-wrap">
              {text || "No answer"}
            </SheetField>
          </Sheet>
        )
      const props = {
        label: block.label,
        placeholder: block.placeholder,
        value: text,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          onChange(block.id, event.target.value),
      }
      if (block.multiline) return <TextArea {...props} />
      return <TextField {...props} className="min-h-11" />
    }
    default:
      return (
        <p className="text-sm text-fg-secondary" data-ui-block="unknown">
          Can't show this part in this version of OpenBot.
        </p>
      )
  }
}

function UiImage({ attachmentId, alt }: { readonly attachmentId: string; readonly alt: string }): ReactNode {
  const [failed, setFailed] = useState(false)
  const src = imageSrc(`/api/attachments/${attachmentId}`)
  if (failed || src === undefined)
    return <p className="rounded-xl bg-elevated p-3 text-sm text-fg-secondary">{alt} (image unavailable)</p>
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="max-h-96 max-w-full rounded-xl object-contain"
    />
  )
}
