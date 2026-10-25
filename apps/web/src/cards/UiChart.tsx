import type { UiBlock } from "@openbot/contracts"
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"

type ChartBlock = Extract<UiBlock, { type: "chart" }>
type Segment = {
  readonly x: string
  readonly y: number
  readonly from: number
  readonly to: number
  readonly hasPoint: boolean
}
const colors = ["var(--ob-accent-fg)", "var(--ob-purple-fg)", "var(--ob-success-fg)", "var(--ob-warn-fg)"]

/** Each series' points with the value range they cover: from 0, or piled on the series before it. */
const layersOf = (block: ChartBlock, labels: ReadonlyArray<string>, stacked: boolean): Segment[][] => {
  if (!stacked)
    return block.series.map((series) =>
      series.points.map((point) => ({ ...point, from: 0, to: point.y, hasPoint: true })),
    )
  const above = new Map<string, number>()
  const below = new Map<string, number>()
  return block.series.map((series) =>
    labels.map((x) => {
      const point = series.points.find((candidate) => candidate.x === x)
      const y = point?.y ?? 0
      const pile = y < 0 ? below : above
      const from = pile.get(x) ?? 0
      pile.set(x, from + y)
      return { x, y, from, to: from + y, hasPoint: point !== undefined }
    }),
  )
}

const chartName = (block: ChartBlock, stacked: boolean): string => {
  if (block.kind === "bar") return stacked ? "Stacked bar chart" : "Bar chart"
  if (block.fill) return stacked ? "Stacked area chart" : "Area chart"
  return "Line chart"
}

const round = (value: number) => Number(value.toPrecision(12))

/** Lines fit the card, so about seven x labels show, none crowding the highlighted one (as on iPhone). */
const lineLabelShown = (index: number, count: number, highlighted: number): boolean => {
  const every = Math.ceil(count / 7)
  if (index === highlighted) return true
  if (highlighted !== -1 && Math.abs(index - highlighted) < every) return false
  return index % every === 0
}

/** The highlighted x's value label and line dot: a stacked total in text ink, else the first series' value. */
const markOf = (block: ChartBlock, layers: Segment[][], highlighted: number, stacked: boolean) => {
  if (highlighted < 0) return undefined
  if (stacked) {
    const pile = layers.map((layer) => layer[highlighted]!)
    return {
      value: pile.reduce((sum, segment) => sum + segment.y, 0),
      top: Math.max(0, ...pile.map((segment) => segment.to)),
      dot: pile.at(-1)!.to,
      color: "var(--ob-fg)",
    }
  }
  const point = block.series[0]?.points.find((candidate) => candidate.x === block.highlight)
  if (point === undefined) return undefined
  return { value: point.y, top: Math.max(0, point.y), dot: point.y, color: colors[0] }
}

export function UiChart({ block }: { readonly block: ChartBlock }): ReactNode {
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(480)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width)
    })
    observer.observe(container.current!)
    return () => observer.disconnect()
  }, [])
  const labels = [...new Set(block.series.flatMap((series) => series.points.map((point) => point.x)))]
  const stacked = block.stacked === true && (block.kind === "bar" || block.fill === true)
  const layers = layersOf(block, labels, stacked)
  const values = layers.flatMap((layer) => layer.map((segment) => segment.to))
  const totals = new Map<string, number>()
  for (const segment of layers.flat()) totals.set(segment.x, (totals.get(segment.x) ?? 0) + segment.y)
  const unit = block.unit ? ` ${block.unit}` : ""
  const tip = (name: string, segment: Segment) =>
    `${name}: ${segment.x}, ${segment.y}${unit}${stacked ? ` of ${round(totals.get(segment.x)!)}${unit} total` : ""}`
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const rawStep = (max - min || 1) / 2
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const tickStep = Math.ceil(rawStep / magnitude) * magnitude
  const low = Math.floor(min / tickStep) * tickStep
  const high = Math.max(low + tickStep, Math.ceil(max / tickStep) * tickStep)
  const range = high - low
  const ticks = Array.from({ length: Math.round(range / tickStep) + 1 }, (_, index) => low + index * tickStep)
  const width = block.kind === "line" ? availableWidth : Math.max(availableWidth, labels.length * 24 + 56)
  const step = (width - 56) / Math.max(1, labels.length)
  const x = (label: string) => 44 + step * (labels.indexOf(label) + 0.5)
  const y = (value: number) => 162 - ((value - low) / range) * 140
  const highlighted = labels.indexOf(block.highlight ?? "")
  const mark = markOf(block, layers, highlighted, stacked)
  // A dense line fits the width, leaving its points too close together for markers.
  const markers = step >= 10
  const barLabelEvery = Math.max(1, Math.ceil(labels.length / (width / 56)))
  const labelShown = (index: number) =>
    block.kind === "line"
      ? lineLabelShown(index, labels.length, highlighted)
      : index % barLabelEvery === 0 || index === highlighted
  return (
    <figure className="rounded-xl bg-elevated p-3" data-ui-block="chart">
      <figcaption className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary">
        {block.series.map((series, index) => (
          <span key={series.name} className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: colors[index] }} aria-hidden />
            {series.name}
          </span>
        ))}
        {block.unit && <span className="ms-auto">{block.unit}</span>}
      </figcaption>
      <div ref={container} className="overflow-x-auto scrollbar-thin">
        <svg
          viewBox={`0 0 ${width} 200`}
          className="w-full"
          style={{ minWidth: width > availableWidth ? width : undefined }}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
        >
          <title id={`${id}-title`}>{`${chartName(block, stacked)}${block.unit ? ` (${block.unit})` : ""}`}</title>
          <desc id={`${id}-description`}>
            {block.series
              .map((series) => `${series.name}: ${series.points.map((point) => `${point.x}: ${point.y}`).join(", ")}`)
              .join(". ")}
            {stacked && `. Totals: ${labels.map((label) => `${label}: ${round(totals.get(label)!)}`).join(", ")}`}
          </desc>
          {highlighted >= 0 && (
            <rect x={44 + step * highlighted} y={14} width={step} height={154} rx={4} fill="var(--ob-accent-soft)" />
          )}
          {ticks.map((value) => (
            <g key={value}>
              <line
                x1={44}
                x2={width - 12}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--ob-line-secondary)"
                strokeWidth={0.5}
              />
              <text x={36} y={y(value) + 4} textAnchor="end" fill="var(--ob-fg-tertiary)" fontSize={11}>
                {round(value)}
              </text>
            </g>
          ))}
          {labels.map(
            (label, index) =>
              labelShown(index) && (
                <text key={label} x={x(label)} y={184} textAnchor="middle" fill="var(--ob-fg-secondary)" fontSize={11}>
                  {label.length > 8 ? `${label.slice(0, 7)}…` : label}
                </text>
              ),
          )}
          {block.kind === "line" &&
            block.fill &&
            layers.map((layer, index) => (
              <g key={block.series[index]!.name}>
                {!stacked && (
                  <linearGradient id={`${id}-${index}`} x1={0} y1={0} x2={0} y2={1}>
                    <stop offset={0} stopColor={colors[index]} stopOpacity={0.25} />
                    <stop offset={1} stopColor={colors[index]} stopOpacity={0} />
                  </linearGradient>
                )}
                <path
                  d={`M${[
                    ...layer.map((segment) => `${x(segment.x)},${y(segment.to)}`),
                    ...layer.toReversed().map((segment) => `${x(segment.x)},${y(segment.from)}`),
                  ].join("L")}Z`}
                  fill={stacked ? colors[index] : `url(#${id}-${index})`}
                  fillOpacity={stacked ? 0.55 : undefined}
                />
              </g>
            ))}
          {layers.map((layer, index) => {
            const name = block.series[index]!.name
            const color = colors[index]
            if (block.kind === "line")
              return (
                <g key={name}>
                  <polyline
                    points={layer.map((segment) => `${x(segment.x)},${y(segment.to)}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                  {layer
                    .filter((segment) => segment.hasPoint && markers)
                    .map((segment) => (
                      <circle key={segment.x} cx={x(segment.x)} cy={y(segment.to)} r={3} fill={color}>
                        <title>{tip(name, segment)}</title>
                      </circle>
                    ))}
                </g>
              )
            const bars = stacked ? 1 : block.series.length
            const barWidth = Math.min(stacked ? 40 : 32, (step * 0.75) / bars)
            const left = (segment: Segment) =>
              stacked ? x(segment.x) - barWidth / 2 : x(segment.x) - (barWidth * bars) / 2 + index * barWidth
            return (
              <g key={name} fill={color}>
                {(stacked ? layer.filter((segment) => segment.y !== 0) : layer).map((segment) => (
                  <rect
                    key={segment.x}
                    x={left(segment)}
                    y={Math.min(y(segment.from), y(segment.to))}
                    width={barWidth - 2}
                    height={Math.abs(y(segment.to) - y(segment.from))}
                    rx={3}
                    stroke={stacked ? "var(--ob-elevated)" : undefined}
                    strokeWidth={stacked ? 2 : undefined}
                  >
                    <title>{tip(name, segment)}</title>
                  </rect>
                ))}
              </g>
            )
          })}
          {mark && (
            <g fill={mark.color}>
              {block.kind === "line" && <circle cx={x(labels[highlighted]!)} cy={y(mark.dot)} r={4} />}
              <text x={x(labels[highlighted]!)} y={y(mark.top) - 8} textAnchor="middle" fontSize={11} fontWeight={600}>
                {round(mark.value)}
              </text>
            </g>
          )}
        </svg>
      </div>
    </figure>
  )
}
