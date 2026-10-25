import { useAtomSet } from "@effect/atom-react"
import { imageSrc, safeHref } from "@openbot/app-model"
import { actCardAtom } from "@openbot/client"
import type { CardState, EntryId, UiBlock, UiCard, UiValues } from "@openbot/contracts"
import { Exit } from "effect"
import * as Haptics from "expo-haptics"
import { Image } from "expo-image"
import * as Linking from "expo-linking"
import { type ReactNode, useId, useState } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import Svg, { Circle, Defs, Line, LinearGradient, Polygon, Polyline, Rect, Stop } from "react-native-svg"
import { failureText } from "../data.ts"
import type { Theme } from "../theme.ts"
import { Icon } from "../ui/Icon.tsx"
import { Markdown, type MarkdownImage } from "./Markdown.tsx"

type Block<T extends UiBlock["type"]> = Extract<UiBlock, { type: T }>
type Value = UiValues[string]

interface Form {
  readonly values: UiValues
  readonly set: (id: string, value: Value) => void
  readonly locked: boolean
}

const listOf = (value: Value | undefined): ReadonlyArray<string> => {
  if (value === undefined) return []
  if (typeof value === "string") return [value]
  return value
}

const formValues = (card: UiCard, edits: UiValues): UiValues => {
  const values: Record<string, Value> = {}
  for (const b of card.blocks) {
    if (b.type === "choice") values[b.id] = edits[b.id] ?? b.default ?? []
    if (b.type === "input") values[b.id] = edits[b.id] ?? b.default ?? ""
  }
  return values
}

export function UiCardView({
  card,
  state,
  entryId,
  theme,
  media,
}: {
  readonly card: UiCard
  readonly state: CardState
  readonly entryId: EntryId | undefined
  readonly theme: Theme
  readonly media: MarkdownImage
}): ReactNode {
  const [open, setOpen] = useState(card.collapsed !== true)
  const [edits, setEdits] = useState<UiValues>({})
  const [busy, setBusy] = useState<string | null>(null)
  const send = useAtomSet(actCardAtom(entryId ?? "none"), { mode: "promiseExit" })

  const values = formValues(card, edits)
  const form: Form = {
    values: state.answer?.values ?? values,
    set: (id, value) => setEdits({ ...edits, [id]: value }),
    locked: state.status !== "pending" || busy !== null,
  }

  const act = async (actionId: string) => {
    if (entryId === undefined) return
    setBusy(actionId)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    try {
      const exit = await send({ entryId, actionId, values })
      if (Exit.isFailure(exit)) Alert.alert("Couldn't send that", failureText(exit))
    } finally {
      setBusy(null)
    }
  }

  if (card.version !== 1) {
    return (
      <View style={[styles.card, { backgroundColor: theme.bubbleBot }]}>
        <Text style={[styles.body, { color: theme.fg }]}>{card.fallback}</Text>
      </View>
    )
  }

  if (!open) {
    return (
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityHint="Shows the whole card"
        style={[styles.card, styles.summary, { backgroundColor: theme.bubbleBot }]}
      >
        <Text numberOfLines={2} style={[styles.body, { color: theme.fg, flex: 1 }]}>
          {card.fallback}
        </Text>
        <Icon name="chevronRight" size={14} color={theme.iconSecondary} />
      </Pressable>
    )
  }

  const heading = card.title ?? (card.collapsed ? card.fallback : undefined)
  return (
    <View style={[styles.card, { backgroundColor: theme.bubbleBot }]}>
      {(heading !== undefined || card.subtitle !== undefined) && (
        <Pressable
          onPress={() => setOpen(false)}
          disabled={!card.collapsed}
          accessibilityRole={card.collapsed ? "button" : "header"}
          style={styles.header}
        >
          <View style={{ flex: 1, gap: 2 }}>
            {heading !== undefined && <Text style={[styles.title, { color: theme.fg }]}>{heading}</Text>}
            {card.subtitle ? <Text style={[styles.small, { color: theme.fgSecondary }]}>{card.subtitle}</Text> : null}
          </View>
          {card.collapsed && <Icon name="chevronDown" size={14} color={theme.iconSecondary} />}
        </Pressable>
      )}
      {card.blocks.map((block, i) => (
        <BlockView key={i} block={block} theme={theme} media={media} form={form} />
      ))}
      {card.actions !== undefined && card.actions.length > 0 && (
        <View style={styles.row}>
          {card.actions.map((a) => (
            <ActionButton
              key={a.id}
              theme={theme}
              label={a.label}
              variant={a.style ?? "secondary"}
              busy={busy === a.id}
              chosen={state.answer?.actionId === a.id}
              disabled={form.locked}
              onPress={() => void act(a.id)}
            />
          ))}
        </View>
      )}
    </View>
  )
}

function BlockView({
  block,
  theme,
  media,
  form,
}: {
  readonly block: UiBlock
  readonly theme: Theme
  readonly media: MarkdownImage
  readonly form: Form
}): ReactNode {
  switch (block.type) {
    case "text":
      return <Markdown text={block.markdown} theme={theme} size={15} image={media} uiCard />
    case "fields":
      return <FieldsBlock block={block} theme={theme} />
    case "table":
      return <TableBlock block={block} theme={theme} />
    case "options":
      return <OptionsBlock block={block} theme={theme} />
    case "stats":
      return <StatsBlock block={block} theme={theme} />
    case "checklist":
      return <ChecklistBlock block={block} theme={theme} />
    case "timeline":
      return <TimelineBlock block={block} theme={theme} />
    case "chart":
      return <ChartBlock block={block} theme={theme} />
    case "image":
      return <ImageBlock block={block} theme={theme} media={media} />
    case "link":
      return <LinkBlock block={block} theme={theme} />
    case "choice":
      return <ChoiceBlock block={block} theme={theme} form={form} />
    case "input":
      return <InputBlock block={block} theme={theme} form={form} />
    default:
      return (
        <Text style={[styles.small, { color: theme.fgTertiary }]}>
          This part can't be shown in this version of the app.
        </Text>
      )
  }
}

const sheet = (theme: Theme) => ({ backgroundColor: theme.bg, borderColor: theme.lineTertiary })
const divider = (theme: Theme) => ({ borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.lineSecondary })

type Tone = "accent" | "success" | "danger" | "neutral"

function Pill({ theme, tone, text }: { readonly theme: Theme; readonly tone: Tone; readonly text: string }): ReactNode {
  const colors: Record<Tone, readonly [string, string]> = {
    accent: [theme.accentSoft, theme.accentFg],
    success: [theme.successSoft, theme.successFg],
    danger: [theme.dangerSoft, theme.dangerFg],
    neutral: [theme.secondary, theme.fgSecondary],
  }
  const [background, color] = colors[tone]
  return (
    <View style={[styles.pill, { backgroundColor: background }]}>
      <Text style={{ color, fontSize: 12, lineHeight: 16 }}>{text}</Text>
    </View>
  )
}

function FieldsBlock({ block, theme }: { readonly block: Block<"fields">; readonly theme: Theme }): ReactNode {
  return (
    <View style={[styles.sheet, sheet(theme)]}>
      {block.items.map((f, i) => (
        <View key={i} style={[styles.field, i > 0 && divider(theme)]}>
          <Text style={[styles.small, { color: theme.fgSecondary, maxWidth: "45%" }]}>{f.label}</Text>
          <Text selectable style={[styles.body, { color: theme.fg, flex: 1, textAlign: "right" }]}>
            {f.value}
          </Text>
        </View>
      ))}
    </View>
  )
}

function TableBlock({ block, theme }: { readonly block: Block<"table">; readonly theme: Theme }): ReactNode {
  const [width, setWidth] = useState(320)
  const column = Math.max(104, width / Math.max(1, block.columns.length))
  const cells = (row: ReadonlyArray<string>, head: boolean) =>
    row.map((c, i) => (
      <Text
        key={i}
        selectable
        style={[
          styles.cell,
          { width: column, color: head ? theme.fgSecondary : theme.fg, fontWeight: head ? "500" : "400" },
        ]}
      >
        {c}
      </Text>
    ))
  return (
    <View style={[styles.sheet, sheet(theme)]} onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={{ flexDirection: "row" }}>{cells(block.columns, true)}</View>
          {block.rows.map((row, r) => (
            <View key={r} style={[{ flexDirection: "row" }, divider(theme)]}>
              {cells(row, false)}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

function OptionsBlock({ block, theme }: { readonly block: Block<"options">; readonly theme: Theme }): ReactNode {
  return (
    <View style={{ gap: 6 }}>
      {block.items.map((o) => {
        const pick = o.id === block.pick
        return (
          <View
            key={o.id}
            style={[
              styles.option,
              sheet(theme),
              pick && { borderColor: theme.accentFg, borderWidth: 1, padding: 11.5 },
            ]}
          >
            {(pick || o.badge) && (
              <View style={styles.row}>
                {pick && <Pill theme={theme} tone="accent" text="My pick" />}
                {o.badge ? <Pill theme={theme} tone="neutral" text={o.badge} /> : null}
              </View>
            )}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.strong, { color: theme.fg }]}>{o.title}</Text>
                {o.subtitle ? <Text style={[styles.small, { color: theme.fgSecondary }]}>{o.subtitle}</Text> : null}
                {(o.lines ?? []).map((line, i) => (
                  <Text key={i} style={[styles.small, { color: theme.fgSecondary }]}>
                    {line}
                  </Text>
                ))}
              </View>
              {(o.value || o.note) && (
                <View style={{ alignItems: "flex-end", justifyContent: "center", maxWidth: "45%" }}>
                  {o.value ? <Text style={[styles.figure, { color: theme.fg }]}>{o.value}</Text> : null}
                  {o.note ? (
                    <Text style={[styles.small, { color: theme.fgSecondary, textAlign: "right" }]}>{o.note}</Text>
                  ) : null}
                </View>
              )}
            </View>
          </View>
        )
      })}
    </View>
  )
}

function StatsBlock({ block, theme }: { readonly block: Block<"stats">; readonly theme: Theme }): ReactNode {
  const toneColor = { good: theme.successFg, bad: theme.dangerFg, neutral: theme.fgSecondary }
  return (
    <View style={[styles.sheet, sheet(theme), styles.stats]}>
      {block.items.map((s, i) => (
        <View
          key={i}
          style={[
            styles.stat,
            i % 3 > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: theme.lineSecondary },
          ]}
        >
          <Text style={[styles.small, { color: theme.fgSecondary }]}>{s.label}</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.figure, { color: theme.fg }]}>
            {s.value}
          </Text>
          {s.delta ? <Text style={[styles.small, { color: toneColor[s.tone ?? "neutral"] }]}>{s.delta}</Text> : null}
        </View>
      ))}
    </View>
  )
}

const CHECK_STATUS = {
  done: { label: "Done", tone: "success" },
  active: { label: "In progress", tone: "accent" },
  upcoming: { label: "Up next", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
} as const satisfies Record<Block<"checklist">["items"][number]["status"], { label: string; tone: Tone }>

function CheckMark({
  theme,
  status,
}: {
  readonly theme: Theme
  readonly status: Block<"checklist">["items"][number]["status"]
}): ReactNode {
  switch (status) {
    case "done":
      return (
        <View style={[styles.mark, { backgroundColor: theme.successSoft }]}>
          <Icon name="check" size={13} color={theme.successFg} />
        </View>
      )
    case "failed":
      return (
        <View style={[styles.mark, { backgroundColor: theme.dangerSoft }]}>
          <Icon name="close" size={12} color={theme.dangerFg} />
        </View>
      )
    case "active":
      return (
        <View style={[styles.mark, { backgroundColor: theme.accentSoft }]}>
          <View style={[styles.ring, { borderColor: theme.accentFg }]} />
        </View>
      )
    case "upcoming":
      return (
        <View style={[styles.mark, { backgroundColor: theme.secondary }]}>
          <View style={[styles.ring, { borderColor: theme.fgTertiary }]} />
        </View>
      )
  }
}

function ChecklistBlock({ block, theme }: { readonly block: Block<"checklist">; readonly theme: Theme }): ReactNode {
  const done = block.items.filter((c) => c.status === "done").length
  const total = block.items.length
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.progress}>
        <View style={[styles.track, { backgroundColor: theme.lineSecondary }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: theme.accentFg, width: `${total === 0 ? 0 : (done / total) * 100}%` },
            ]}
          />
        </View>
        <Text style={[styles.small, { color: theme.fgSecondary }]}>
          {done} of {total} complete
        </Text>
      </View>
      <View style={[styles.sheet, sheet(theme)]}>
        {block.items.map((c, i) => (
          <View key={i} style={[styles.check, i > 0 && divider(theme)]}>
            <CheckMark theme={theme} status={c.status} />
            <View style={{ flex: 1, gap: 2, alignItems: "flex-start" }}>
              <Text style={[styles.body, { color: theme.fg }]}>{c.label}</Text>
              {c.detail ? <Text style={[styles.small, { color: theme.fgSecondary }]}>{c.detail}</Text> : null}
              <View style={{ marginTop: 6 }}>
                <Pill theme={theme} tone={CHECK_STATUS[c.status].tone} text={CHECK_STATUS[c.status].label} />
              </View>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

function TimelineBlock({ block, theme }: { readonly block: Block<"timeline">; readonly theme: Theme }): ReactNode {
  return (
    <View style={[styles.sheet, sheet(theme), { paddingHorizontal: 12 }]}>
      {block.items.map((t, i) => (
        <View key={i} style={styles.event}>
          <Text style={[styles.time, { color: theme.fg }]}>{t.time}</Text>
          <View style={styles.rail}>
            <View style={[styles.dot, { backgroundColor: theme.accentFg }]} />
            {i < block.items.length - 1 && <View style={[styles.line, { backgroundColor: theme.lineSecondary }]} />}
          </View>
          <View style={{ flex: 1, gap: 2, paddingVertical: 12, alignItems: "flex-start" }}>
            <Text style={[styles.body, { color: theme.fg }]}>{t.title}</Text>
            {t.detail ? <Text style={[styles.small, { color: theme.fgSecondary }]}>{t.detail}</Text> : null}
            {t.tag ? (
              <View style={{ marginTop: 4 }}>
                <Pill theme={theme} tone="neutral" text={t.tag} />
              </View>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  )
}

const number = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 1 })

/** A round ceiling for the y axis: 8.7 → 9, 42 → 45, 1234 → 1500. */
const roundUp = (n: number): number => {
  if (n <= 0) return 0
  const step = 10 ** Math.floor(Math.log10(n)) / 2
  return Math.ceil(n / step) * step
}

interface Span {
  readonly x: string
  readonly from: number
  readonly to: number
}

// Stacked, positive values pile up from zero and negative ones pile down.
const spansOf = (
  block: Block<"chart">,
  xs: ReadonlyArray<string>,
  stacked: boolean,
): ReadonlyArray<ReadonlyArray<Span>> => {
  if (!stacked) return block.series.map((s) => s.points.map((p) => ({ x: p.x, from: 0, to: p.y })))
  const up = new Map<string, number>()
  const down = new Map<string, number>()
  return block.series.map((s) =>
    xs.map((x) => {
      const y = s.points.find((p) => p.x === x)?.y ?? 0
      const sums = y < 0 ? down : up
      const from = sums.get(x) ?? 0
      sums.set(x, from + y)
      return { x, from, to: from + y }
    }),
  )
}

function ChartBlock({ block, theme }: { readonly block: Block<"chart">; readonly theme: Theme }): ReactNode {
  const [width, setWidth] = useState(300)
  const gradientId = useId()
  const palette = [theme.accentFg, theme.success, theme.warn, theme.dangerFg]
  const color = (series: number) => palette[series % palette.length]!
  const xs = [...new Set(block.series.flatMap((s) => s.points.map((p) => p.x)))]
  const stacked = block.stacked === true && (block.kind === "bar" || block.fill === true)
  const spans = spansOf(block, xs, stacked)
  const ys = spans.flatMap((s) => s.map((p) => p.to))
  const top = roundUp(Math.max(0, ...ys))
  const low = Math.min(0, ...ys)
  const bottom = low < 0 ? -roundUp(-low) : 0
  const span = top - bottom || 1
  const left = 34
  const plotTop = 20
  const plotHeight = 140
  // Only bars need room per x; lines and areas fit the card width.
  const plotWidth = block.kind === "bar" ? Math.max(width - left - 4, xs.length * 24) : width - left - 4
  const chartWidth = left + plotWidth + 4
  const slot = plotWidth / Math.max(1, xs.length)
  const xAt = (x: string) => left + slot * xs.indexOf(x) + slot / 2
  const yAt = (y: number) => plotTop + ((top - y) / span) * plotHeight
  const labelEvery = Math.ceil(xs.length / 7)
  const labelWidth = slot * labelEvery
  const highlightAt = xs.findIndex((x) => x === block.highlight)
  // Thinned labels count from the first x and keep clear of the highlight, which is always labelled.
  const labelled = (i: number) => {
    if (i === highlightAt) return true
    if (highlightAt !== -1 && Math.abs(i - highlightAt) < labelEvery) return false
    return i % labelEvery === 0
  }
  const ticks = [top, (top + bottom) / 2, bottom]
  const single = block.series.length === 1
  const columns = stacked ? 1 : block.series.length
  const barWidth = Math.min(28, (slot * 0.7) / columns)
  const highlightSeries = stacked ? spans.length - 1 : 0
  const highlighted = spans[highlightSeries]?.find((p) => p.x === block.highlight)
  // A stacked total belongs to no single series.
  const highlightColor = stacked ? theme.fg : color(0)
  const barColor = (series: number, x: string) => {
    if (single && block.highlight !== undefined && x !== block.highlight) return theme.lineSecondary
    return color(series)
  }
  const caption = single ? [block.series[0]?.name, block.unit].filter(Boolean).join(" · ") : (block.unit ?? "")
  const summary = block.series
    .map((s) => `${s.name}: ${s.points.map((p) => `${p.x} ${number(p.y)}`).join(", ")}`)
    .join("; ")

  return (
    <View
      style={[styles.sheet, sheet(theme), { padding: 12, gap: 8 }]}
      onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width) - 24)}
      accessible
      accessibilityLabel={summary}
    >
      {caption !== "" && <Text style={[styles.small, { color: theme.fgSecondary }]}>{caption}</Text>}
      {!single && (
        <View style={styles.row}>
          {block.series.map((s, i) => (
            <View key={s.name} style={styles.legend}>
              <View style={[styles.swatch, { backgroundColor: color(i) }]} />
              <Text style={[styles.small, { color: theme.fgSecondary }]}>{s.name}</Text>
            </View>
          ))}
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ width: chartWidth, height: plotTop + plotHeight + 24 }}>
          <Svg width={chartWidth} height={plotTop + plotHeight + 24}>
            {ticks.map((v) => (
              <Line
                key={v}
                x1={left}
                x2={chartWidth}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke={theme.lineSecondary}
                strokeWidth={StyleSheet.hairlineWidth}
              />
            ))}
            {block.kind === "bar" &&
              spans.flatMap((s, si) =>
                s.map((p) => (
                  <Rect
                    key={`${si}:${p.x}`}
                    x={xAt(p.x) - (barWidth * columns) / 2 + barWidth * (stacked ? 0 : si)}
                    y={Math.min(yAt(p.to), yAt(p.from))}
                    width={columns === 1 ? barWidth : barWidth * 0.8}
                    height={Math.abs(yAt(p.to) - yAt(p.from))}
                    rx={3}
                    fill={barColor(si, p.x)}
                  />
                )),
              )}
            {block.kind === "line" && block.fill === true && !stacked && (
              <Defs>
                {block.series.map((s, si) => (
                  <LinearGradient key={s.name} id={`${gradientId}-${si}`} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={color(si)} stopOpacity={0.25} />
                    <Stop offset="1" stopColor={color(si)} stopOpacity={0} />
                  </LinearGradient>
                ))}
              </Defs>
            )}
            {block.kind === "line" &&
              block.fill === true &&
              spans.map((s, si) => (
                <Polygon
                  key={si}
                  points={[
                    ...s.map((p) => `${xAt(p.x)},${yAt(p.to)}`),
                    ...[...s].reverse().map((p) => `${xAt(p.x)},${yAt(p.from)}`),
                  ].join(" ")}
                  fill={stacked ? color(si) : `url(#${gradientId}-${si})`}
                  fillOpacity={stacked ? 0.55 : 1}
                />
              ))}
            {block.kind === "line" &&
              spans.map((s, si) => (
                <Polyline
                  key={si}
                  points={s.map((p) => `${xAt(p.x)},${yAt(p.to)}`).join(" ")}
                  fill="none"
                  stroke={color(si)}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            {highlighted !== undefined && block.kind === "line" && (
              <Circle cx={xAt(highlighted.x)} cy={yAt(highlighted.to)} r={4} fill={highlightColor} />
            )}
          </Svg>
          {ticks.map((v) => (
            <Text key={v} style={[styles.axis, { top: yAt(v) - 8, color: theme.fgTertiary }]}>
              {number(v)}
            </Text>
          ))}
          {xs.map((x, i) =>
            labelled(i) ? (
              <Text
                key={x}
                numberOfLines={1}
                style={[
                  styles.axis,
                  styles.centered,
                  {
                    left: xAt(x) - labelWidth / 2,
                    width: labelWidth,
                    top: plotTop + plotHeight + 6,
                    color: theme.fgSecondary,
                  },
                ]}
              >
                {x}
              </Text>
            ) : null,
          )}
          {highlighted !== undefined && (
            <Text
              style={[
                styles.axis,
                styles.centered,
                {
                  left: xAt(highlighted.x) - 40,
                  width: 80,
                  top: yAt(Math.max(0, highlighted.to)) - 24,
                  color: highlightColor,
                },
              ]}
            >
              {number(highlighted.to)}
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

function ImageBlock({
  block,
  theme,
  media,
}: {
  readonly block: Block<"image">
  readonly theme: Theme
  readonly media: MarkdownImage
}): ReactNode {
  const [failed, setFailed] = useState<string>()
  const src = imageSrc(`/api/attachments/${block.attachmentId}`)
  if (src === undefined || src === failed) {
    return (
      <View style={[styles.image, styles.placeholder, sheet(theme)]}>
        <Icon name="photo" size={20} color={theme.iconSecondary} />
        <Text style={[styles.small, { color: theme.fgSecondary }]}>{block.alt}</Text>
      </View>
    )
  }
  return (
    <Image
      source={{ uri: media.origin + src, headers: media.headers }}
      alt={block.alt}
      accessibilityLabel={block.alt}
      onError={() => setFailed(src)}
      contentFit="contain"
      style={[styles.image, { backgroundColor: theme.bg }]}
    />
  )
}

function LinkBlock({ block, theme }: { readonly block: Block<"link">; readonly theme: Theme }): ReactNode {
  const href = /^https:\/\//i.test(block.url) ? safeHref(block.url) : undefined
  if (href === undefined) return <Text style={[styles.body, { color: theme.fgSecondary }]}>{block.label}</Text>
  return (
    <Pressable
      onPress={() => void Linking.openURL(href)}
      accessibilityRole="link"
      style={({ pressed }) => [
        styles.button,
        styles.link,
        { backgroundColor: theme.secondary, opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <Text style={[styles.buttonText, { color: theme.fg }]}>{block.label}</Text>
      <Icon name="external" size={13} color={theme.iconSecondary} />
    </Pressable>
  )
}

function ChoiceBlock({
  block,
  theme,
  form,
}: {
  readonly block: Block<"choice">
  readonly theme: Theme
  readonly form: Form
}): ReactNode {
  const picked = listOf(form.values[block.id])
  const toggle = (id: string) => {
    if (block.mode === "one") form.set(block.id, [id])
    else form.set(block.id, picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id])
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.small, { color: theme.fgSecondary }]}>{block.label}</Text>
      {block.options.map((o) => {
        const on = picked.includes(o.id)
        return (
          <Pressable
            key={o.id}
            onPress={() => toggle(o.id)}
            disabled={form.locked}
            accessibilityRole={block.mode === "one" ? "radio" : "checkbox"}
            accessibilityState={{ checked: on, disabled: form.locked }}
            style={[
              styles.slot,
              sheet(theme),
              on && { borderColor: theme.accentFg, borderWidth: 1, padding: 11.5 },
              form.locked && !on && { opacity: 0.5 },
            ]}
          >
            <ChoiceMark theme={theme} mode={block.mode} on={on} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.body, { color: theme.fg }]}>{o.label}</Text>
              {o.detail ? <Text style={[styles.small, { color: theme.fgSecondary }]}>{o.detail}</Text> : null}
            </View>
            {o.badge ? <Text style={[styles.small, { color: theme.fgSecondary }]}>{o.badge}</Text> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

function ChoiceMark({
  theme,
  mode,
  on,
}: {
  readonly theme: Theme
  readonly mode: Block<"choice">["mode"]
  readonly on: boolean
}): ReactNode {
  if (mode === "one") {
    return (
      <View
        style={[styles.radio, { borderColor: theme.line }, on && { borderColor: theme.accentFg, borderWidth: 5 }]}
      />
    )
  }
  return (
    <View
      style={[
        styles.box,
        { borderColor: theme.line },
        on && { backgroundColor: theme.accentFg, borderColor: theme.accentFg },
      ]}
    >
      {on && <Icon name="check" size={11} color="#ffffff" />}
    </View>
  )
}

function InputBlock({
  block,
  theme,
  form,
}: {
  readonly block: Block<"input">
  readonly theme: Theme
  readonly form: Form
}): ReactNode {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.small, { color: theme.fgSecondary }]}>{block.label}</Text>
      <TextInput
        value={listOf(form.values[block.id]).join(", ")}
        onChangeText={(text) => form.set(block.id, text)}
        editable={!form.locked}
        multiline={block.multiline === true}
        placeholder={block.placeholder}
        placeholderTextColor={theme.fgQuaternary}
        accessibilityLabel={block.label}
        style={[
          styles.input,
          block.multiline && styles.multiline,
          { color: form.locked ? theme.fgSecondary : theme.fg, ...sheet(theme), borderColor: theme.lineSecondary },
        ]}
      />
    </View>
  )
}

function ActionButton({
  theme,
  label,
  variant,
  busy,
  chosen,
  disabled,
  onPress,
}: {
  readonly theme: Theme
  readonly label: string
  readonly variant: "primary" | "secondary" | "danger"
  readonly busy: boolean
  readonly chosen: boolean
  readonly disabled: boolean
  readonly onPress: () => void
}): ReactNode {
  const colors = {
    primary: [theme.primary, theme.onPrimary],
    secondary: [theme.secondary, theme.fg],
    danger: [theme.danger, "#ffffff"],
  } as const
  const [background, color] = colors[variant]
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: chosen }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: (disabled && !chosen) || pressed ? 0.5 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <View style={styles.legend}>
          {chosen && <Icon name="check" size={14} color={color} />}
          <Text style={[styles.buttonText, { color }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, padding: 14, gap: 12, alignSelf: "stretch" },
  summary: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
  body: { fontSize: 15, lineHeight: 20 },
  strong: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  small: { fontSize: 13, lineHeight: 17 },
  figure: { fontSize: 22, lineHeight: 28, fontWeight: "500" },
  row: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  sheet: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  pill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
  field: { flexDirection: "row", gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  cell: { fontSize: 14, lineHeight: 19, paddingHorizontal: 12, paddingVertical: 9 },
  option: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  stats: { flexDirection: "row", flexWrap: "wrap", paddingVertical: 12, rowGap: 12 },
  stat: { flexBasis: "30%", flexGrow: 1, gap: 4, paddingHorizontal: 12 },
  progress: { flexDirection: "row", alignItems: "center", gap: 10 },
  track: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  check: { flexDirection: "row", gap: 10, padding: 12 },
  mark: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  ring: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 },
  event: { flexDirection: "row", gap: 10 },
  time: { width: 46, fontSize: 14, lineHeight: 20, fontWeight: "500", paddingTop: 12, fontVariant: ["tabular-nums"] },
  rail: { width: 8, alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 18 },
  line: { width: 1, flex: 1, marginTop: 4 },
  legend: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  axis: { position: "absolute", left: 0, fontSize: 11, lineHeight: 16 },
  centered: { textAlign: "center" },
  image: { width: "100%", aspectRatio: 1.5, borderRadius: 12 },
  placeholder: { borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", gap: 6 },
  slot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1 },
  box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  input: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  multiline: { minHeight: 88, paddingVertical: 10, lineHeight: 22, textAlignVertical: "top" },
  button: {
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 72,
  },
  link: { flexDirection: "row", gap: 6, alignSelf: "flex-start" },
  buttonText: { fontSize: 15, fontWeight: "600" },
})
