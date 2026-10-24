import type { UiBlock } from "@openbot/contracts"
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"

type ChartBlock = Extract<UiBlock, { type: "chart" }>
const colors = ["var(--ob-accent-fg)", "var(--ob-purple-fg)", "var(--ob-success-fg)", "var(--ob-warn-fg)"]

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
  const values = block.series.flatMap((series) => series.points.map((point) => point.y))
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const rawStep = (max - min || 1) / 2
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const tickStep = Math.ceil(rawStep / magnitude) * magnitude
  const low = Math.floor(min / tickStep) * tickStep
  const high = Math.max(low + tickStep, Math.ceil(max / tickStep) * tickStep)
  const range = high - low
  const ticks = Array.from({ length: Math.round(range / tickStep) + 1 }, (_, index) => low + index * tickStep)
  const width = Math.max(availableWidth, labels.length * 24 + 56)
  const step = (width - 56) / Math.max(1, labels.length)
  const x = (label: string) => 44 + step * (labels.indexOf(label) + 0.5)
  const y = (value: number) => 162 - ((value - low) / range) * 140
  const highlighted = labels.indexOf(block.highlight ?? "")
  const labelEvery = Math.max(1, Math.ceil(labels.length / (width / 56)))
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
          <title id={`${id}-title`}>
            {`${block.kind === "bar" ? "Bar chart" : "Line chart"}${block.unit ? ` (${block.unit})` : ""}`}
          </title>
          <desc id={`${id}-description`}>
            {block.series
              .map((series) => `${series.name}: ${series.points.map((point) => `${point.x}: ${point.y}`).join(", ")}`)
              .join(". ")}
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
                {Number(value.toPrecision(12))}
              </text>
            </g>
          ))}
          {labels.map(
            (label, index) =>
              (index % labelEvery === 0 || index === highlighted) && (
                <text key={label} x={x(label)} y={184} textAnchor="middle" fill="var(--ob-fg-secondary)" fontSize={11}>
                  {label.length > 8 ? `${label.slice(0, 7)}…` : label}
                </text>
              ),
          )}
          {block.series.map((series, index) => {
            const color = colors[index]
            if (block.kind === "line")
              return (
                <g key={series.name}>
                  <polyline
                    points={series.points.map((point) => `${x(point.x)},${y(point.y)}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                  {series.points.map((point) => (
                    <circle key={point.x} cx={x(point.x)} cy={y(point.y)} r={3} fill={color}>
                      <title>{`${series.name}: ${point.x}, ${point.y} ${block.unit ?? ""}`}</title>
                    </circle>
                  ))}
                </g>
              )
            const barWidth = Math.min(32, (step * 0.75) / block.series.length)
            return (
              <g key={series.name} fill={color}>
                {series.points.map((point) => (
                  <rect
                    key={point.x}
                    x={x(point.x) - (barWidth * block.series.length) / 2 + index * barWidth}
                    y={Math.min(y(0), y(point.y))}
                    width={barWidth - 2}
                    height={Math.abs(y(point.y) - y(0))}
                    rx={3}
                  >
                    <title>{`${series.name}: ${point.x}, ${point.y} ${block.unit ?? ""}`}</title>
                  </rect>
                ))}
              </g>
            )
          })}
        </svg>
      </div>
    </figure>
  )
}
