import {
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { cn } from "../cn.ts"

// --------------------------------------------------------------------------------------- TextField

const fieldClass =
  "w-full rounded-lg bg-elevated px-2.5 text-base text-fg hairline border-line-secondary outline-none transition-colors duration-[120ms] " +
  "placeholder:text-fg-quaternary hover:border-line focus:border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--ob-focus)_35%,transparent)] " +
  "disabled:opacity-50 aria-invalid:border-danger"

export interface FieldShellProps {
  readonly label?: ReactNode
  readonly description?: ReactNode
  readonly error?: ReactNode
}

const FieldShell = ({
  id,
  label,
  description,
  error,
  children,
  className,
}: FieldShellProps & { id: string; children: ReactNode; className?: string }) =>
  label || description || error ? (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-xs text-fg-secondary">
          {label}
        </label>
      )}
      {children}
      {description && !error && (
        <p id={`${id}-desc`} className="text-xs text-fg-tertiary">
          {description}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  ) : (
    <>{children}</>
  )

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, FieldShellProps {
  readonly size?: "sm" | "md"
  readonly wrapperClassName?: string
  readonly ref?: Ref<HTMLInputElement>
}

/** Single-line input: radius 8, 0.5 px border, elevated fill (card answer field, settings, details). */
export function TextField({
  label,
  description,
  error,
  size: fieldSize = "md",
  className,
  wrapperClassName,
  id,
  ref,
  ...rest
}: TextFieldProps): ReactNode {
  const auto = useId()
  const fid = id ?? auto
  return (
    <FieldShell id={fid} label={label} description={description} error={error} className={wrapperClassName}>
      <input
        ref={ref}
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-err` : description ? `${fid}-desc` : undefined}
        className={cn(fieldClass, fieldSize === "md" ? "h-8" : "h-7 text-sm", className)}
        {...rest}
      />
    </FieldShell>
  )
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldShellProps {
  readonly wrapperClassName?: string
  readonly ref?: Ref<HTMLTextAreaElement>
}

export function TextArea({
  label,
  description,
  error,
  className,
  wrapperClassName,
  id,
  rows = 4,
  ref,
  ...rest
}: TextAreaProps): ReactNode {
  const auto = useId()
  const fid = id ?? auto
  return (
    <FieldShell id={fid} label={label} description={description} error={error} className={wrapperClassName}>
      <textarea
        ref={ref}
        id={fid}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(fieldClass, "resize-y py-1.5 leading-5 scrollbar-thin", className)}
        {...rest}
      />
    </FieldShell>
  )
}

// ------------------------------------------------------------------------------------------ Switch

export interface SwitchProps {
  readonly checked: boolean
  readonly onCheckedChange?: (checked: boolean) => void
  readonly disabled?: boolean
  readonly label?: string
  readonly id?: string
  readonly className?: string
}

/** Pill toggle, accent when on (Settings rows). */
export function Switch({ checked, onCheckedChange, disabled, label, id, className }: SwitchProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "relative inline-flex h-5 w-8 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-out-soft disabled:opacity-50",
        checked ? "bg-accent" : "bg-[color-mix(in_srgb,var(--ob-fg)_16%,transparent)]",
        className,
      )}
    >
      <span
        className={cn(
          "size-4 rounded-full bg-white shadow-[0_1px_2px_#0000002e] transition-transform duration-200 ease-out-soft",
          checked ? "translate-x-3" : "translate-x-0",
        )}
      />
    </button>
  )
}

// ----------------------------------------------------------------------------------- SegmentedTabs

export interface SegmentedTab<V extends string> {
  readonly value: V
  readonly label: ReactNode
  readonly disabled?: boolean
}

export interface SegmentedTabsProps<V extends string> {
  readonly tabs: ReadonlyArray<SegmentedTab<V>>
  readonly value: V
  readonly onValueChange?: (value: V) => void
  /** `plain` = Grok details/avatar-editor tabs (no track); `track` = pill track behind the tabs. */
  readonly variant?: "plain" | "track"
  readonly size?: "sm" | "md"
  readonly fill?: boolean
  readonly label?: string
  readonly className?: string
  /** Element after the tabs (e.g. "Reset" in the avatar editor). */
  readonly trailing?: ReactNode
}

/** Segmented tabs (Details | Library | Computer) with a sliding thumb (200 ms in-out-strong). */
export function SegmentedTabs<V extends string>({
  tabs,
  value,
  onValueChange,
  variant = "plain",
  size = "md",
  fill = false,
  label,
  className,
  trailing,
}: SegmentedTabsProps<V>): ReactNode {
  const listRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const el = list.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`)
      setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null)
    }
    measure()
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    ro?.observe(list)
    return () => ro?.disconnect()
  }, [value, tabs])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const enabled = tabs.filter((t) => !t.disabled)
    const i = enabled.findIndex((t) => t.value === value)
    let next: SegmentedTab<V> | undefined
    if (e.key === "ArrowRight") next = enabled[(i + 1) % enabled.length]
    else if (e.key === "ArrowLeft") next = enabled[(i - 1 + enabled.length) % enabled.length]
    else if (e.key === "Home") next = enabled[0]
    else if (e.key === "End") next = enabled[enabled.length - 1]
    if (next) {
      e.preventDefault()
      onValueChange?.(next.value)
      listRef.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus()
    }
  }

  return (
    <div className={cn("flex items-center", fill && "w-full", className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn(
          "relative inline-flex items-center",
          fill && "flex-1",
          variant === "track" && "rounded-full bg-secondary p-0.5",
          size === "md" ? "gap-0.5" : "gap-0",
        )}
      >
        {thumb && (
          <span
            aria-hidden
            className="absolute rounded-full bg-active transition-[left,width] duration-200 ease-in-out-strong"
            style={{
              left: thumb.left,
              width: thumb.width,
              top: variant === "track" ? 2 : 0,
              bottom: variant === "track" ? 2 : 0,
            }}
          />
        )}
        {tabs.map((t) => {
          const selected = t.value === value
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              data-value={t.value}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              disabled={t.disabled}
              onClick={() => onValueChange?.(t.value)}
              className={cn(
                "relative z-10 inline-flex items-center justify-center rounded-full whitespace-nowrap transition-colors duration-[120ms] disabled:opacity-40",
                size === "md" ? "h-[26px] px-2.5 text-sm" : "h-6 px-2 text-xs",
                fill && "flex-1",
                selected ? "text-fg" : "text-fg-secondary hover:text-fg",
                selected && !thumb && "bg-active",
              )}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      {trailing && <div className="ms-auto">{trailing}</div>}
    </div>
  )
}
