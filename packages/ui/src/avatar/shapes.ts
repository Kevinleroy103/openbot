/**
 * OpenBot avatar bodies — ORIGINAL art (D0.3/D6.3). Each body is built here from simple geometry
 * (polar functions, unions of circles, rounded polygons) in a 100×100 box; nothing is traced from
 * Grok Bot. Paths are computed once at module load and are deterministic.
 */
import type { AvatarShape } from "./palette.ts"

type Pt = readonly [number, number]

export interface AvatarBody {
  /** SVG path in a 0..100 box. */
  readonly d: string
  /** Face anchor: where the midpoint between the eyes sits (0..100 box). */
  readonly face: Pt
  /** Eye scale for this body (smaller bodies get slightly smaller eyes). */
  readonly eyeScale: number
}

const f = (n: number) => {
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? "0" : String(r)
}

/** Closed Catmull-Rom spline through `pts`, emitted as cubic Béziers. */
const smoothClosed = (pts: ReadonlyArray<Pt>, tension = 1): string => {
  const n = pts.length
  const at = (i: number) => pts[((i % n) + n) % n]!
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1: Pt = [p1[0] + ((p2[0] - p0[0]) / 6) * tension, p1[1] + ((p2[1] - p0[1]) / 6) * tension]
    const c2: Pt = [p2[0] - ((p3[0] - p1[0]) / 6) * tension, p2[1] - ((p3[1] - p1[1]) / 6) * tension]
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`
  }
  return d + "Z"
}

/** Sample a polar radius function around `c` (θ in screen coordinates: 0 = right, π/2 = down). */
const polar = (c: Pt, n: number, r: (theta: number) => number, rotate = 0): Pt[] => {
  const out: Pt[] = []
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n
    const rr = r(t)
    out.push([c[0] + rr * Math.cos(t + rotate), c[1] + rr * Math.sin(t + rotate)])
  }
  return out
}

/** Outline of a union of circles that is star-shaped around `origin`, sampled along rays. */
const circleUnion = (origin: Pt, circles: ReadonlyArray<readonly [number, number, number]>, n = 120): Pt[] =>
  polar(origin, n, (t) => {
    const ux = Math.cos(t)
    const uy = Math.sin(t)
    let best = 0
    for (const [cx, cy, R] of circles) {
      const ox = cx - origin[0]
      const oy = cy - origin[1]
      const b = ux * ox + uy * oy
      const disc = b * b - (ox * ox + oy * oy - R * R)
      if (disc >= 0) best = Math.max(best, b + Math.sqrt(disc))
    }
    return best
  })

/** Polygon with rounded corners (cubic corners approximating a circular fillet of radius `r`). */
const roundedPolygon = (pts: ReadonlyArray<Pt>, r: number): string => {
  const n = pts.length
  const at = (i: number) => pts[((i % n) + n) % n]!
  const k = 0.5523
  let d = ""
  for (let i = 0; i < n; i++) {
    const prev = at(i - 1)
    const cur = at(i)
    const next = at(i + 1)
    const lin = Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
    const lout = Math.hypot(next[0] - cur[0], next[1] - cur[1])
    const rr = Math.min(r, lin / 2, lout / 2)
    const a: Pt = [cur[0] + ((prev[0] - cur[0]) / lin) * rr, cur[1] + ((prev[1] - cur[1]) / lin) * rr]
    const b: Pt = [cur[0] + ((next[0] - cur[0]) / lout) * rr, cur[1] + ((next[1] - cur[1]) / lout) * rr]
    const c1: Pt = [a[0] + (cur[0] - a[0]) * k * 1.2, a[1] + (cur[1] - a[1]) * k * 1.2]
    const c2: Pt = [b[0] + (cur[0] - b[0]) * k * 1.2, b[1] + (cur[1] - b[1]) * k * 1.2]
    d += `${i === 0 ? "M" : "L"}${f(a[0])} ${f(a[1])}C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(b[0])} ${f(b[1])}`
  }
  return d + "Z"
}

const superellipse = (a: number, b: number, e: number) => (t: number) =>
  Math.pow(Math.pow(Math.abs(Math.cos(t) / a), e) + Math.pow(Math.abs(Math.sin(t) / b), e), -1 / e)

const deg = (x: number) => (x * Math.PI) / 180

const regular = (c: Pt, R: number, sides: number, rotateDeg: number): Pt[] =>
  Array.from({ length: sides }, (_, k) => {
    const t = deg(rotateDeg) + (2 * Math.PI * k) / sides
    return [c[0] + R * Math.cos(t), c[1] + R * Math.sin(t)] as Pt
  })

const build = (): Record<AvatarShape, AvatarBody> => ({
  // A soft, slightly lopsided pebble.
  blob: {
    d: smoothClosed(
      polar([50, 51], 48, (t) => 42 * (1 + 0.045 * Math.sin(2 * t + 0.7) + 0.03 * Math.sin(3 * t + 2.1))),
    ),
    face: [50, 45],
    eyeScale: 1,
  },
  // Three puffs on a rounded base.
  cloud: {
    d: smoothClosed(
      circleUnion(
        [50, 58],
        [
          [24, 57, 21],
          [48, 37, 26],
          [75, 52, 22],
          [30, 72, 17],
          [52, 73, 17],
          [72, 70, 17],
        ],
      ),
    ),
    face: [50, 52],
    eyeScale: 0.95,
  },
  // A squircle, tipped a few degrees.
  square: {
    d: smoothClosed(polar([50, 50], 64, superellipse(39, 39, 4.2), deg(-9))),
    face: [50, 47],
    eyeScale: 1,
  },
  // A plump four-point twinkle.
  sparkle: {
    d: smoothClosed(polar([50, 50], 96, (t) => 29 + 20 * Math.pow(Math.abs(Math.cos(2 * t)), 3), deg(10))),
    face: [50, 49],
    eyeScale: 0.85,
  },
  // Four round leaves.
  clover: {
    d: smoothClosed(
      circleUnion(
        [50, 50],
        [
          [50, 28, 21],
          [72, 50, 21],
          [50, 72, 21],
          [28, 50, 21],
          [50, 50, 20],
        ],
      ),
    ),
    face: [50, 48],
    eyeScale: 0.9,
  },
  // Classic parametric heart, scaled and softened.
  heart: {
    d: smoothClosed(
      Array.from({ length: 72 }, (_, k) => {
        const t = (2 * Math.PI * k) / 72
        const x = 16 * Math.pow(Math.sin(t), 3)
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
        return [50 + x * 2.75, 47 + y * 2.75] as Pt
      }),
    ),
    face: [50, 44],
    eyeScale: 0.9,
  },
  // Six petals around a round middle.
  flower: {
    d: smoothClosed(
      circleUnion(
        [50, 50],
        [
          ...Array.from({ length: 6 }, (_, k) => {
            const t = deg(-90 + 30) + (2 * Math.PI * k) / 6
            return [50 + 27 * Math.cos(t), 50 + 27 * Math.sin(t), 17] as const
          }),
          [50, 50, 26] as const,
        ],
      ),
    ),
    face: [50, 49],
    eyeScale: 0.85,
  },
  // A drop leaning to the upper right.
  teardrop: {
    d: smoothClosed(polar([47, 57], 72, (t) => 35 + 25 * Math.pow(Math.max(0, Math.cos(t - deg(-55))), 5.5))),
    face: [46, 56],
    eyeScale: 0.95,
  },
  // A tall rounded slab, tilted.
  tablet: {
    d: smoothClosed(polar([50, 50], 64, superellipse(29, 43, 4.6), deg(7))),
    face: [51, 42],
    eyeScale: 0.9,
  },
  // A rounded doorstop wedge.
  wedge: {
    d: roundedPolygon(
      [
        [6, 88],
        [30, 8],
        [96, 80],
      ],
      21,
    ),
    face: [42, 62],
    eyeScale: 0.9,
  },
  // A little house with a soft roof.
  house: {
    d: roundedPolygon(
      [
        [13, 46],
        [50, 11],
        [87, 46],
        [87, 88],
        [13, 88],
      ],
      13,
    ),
    face: [50, 60],
    eyeScale: 0.95,
  },
  // A chubby five-point star.
  star: {
    d: smoothClosed(
      polar([50, 53], 100, (t) => 30 + 19 * Math.pow(Math.abs(Math.cos((5 * (t + Math.PI / 2)) / 2)), 2)),
    ),
    face: [50, 51],
    eyeScale: 0.8,
  },
  // A rounded hexagon.
  hex: {
    d: roundedPolygon(regular([50, 50], 45, 6, 8), 12),
    face: [50, 48],
    eyeScale: 1,
  },
})

export const avatarBodies: Readonly<Record<AvatarShape, AvatarBody>> = build()
