// Path policy, enforced on the node (D1.4; remote-prior-art.md §4.7):
//  1. resolve the path against a root (relative paths use the first root that applies),
//  2. realpath the deepest existing ancestor and re-attach the missing tail,
//  3. require containment in a root (symlink escapes are therefore refused),
//  4. refuse the deny-list (secrets dirs, the node's own state dir, extra globs),
//  5. refuse writes to read-only roots and writes through a final-component symlink,
//  6. reject NUL bytes.
// Roots may contain `{botId}` (the calling bot's id) and `*` segments (any single name).
// `extraRoots(botId)` adds per-bot roots computed at call time (the local node: the brain's project
// folders); they are plain read-write directories under the same rules (realpath, deny-list).
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { lstatSync, mkdirSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { PathDenied, type NodeRoot } from "@openbot/node-protocol"
import { NodeConfig } from "./config.ts"

export type PathAccess = "read" | "write"

/** A root made concrete for one bot (its `{botId}` substituted). */
export interface ConcreteRoot {
  readonly id: string
  /** realpath of the static prefix (before the first `*` segment); the whole root when no `*` */
  readonly base: string
  /** segments after `base` that must match (`*` = any single name) */
  readonly pattern: ReadonlyArray<string>
  readonly mode: "rw" | "ro"
  /** the root as configured, `{botId}` substituted */
  readonly display: string
}

export interface ResolvedPath {
  /** the canonical (realpath'd) absolute path the operation acts on */
  readonly real: string
  /** the lexical absolute path as requested */
  readonly requested: string
  /** the root that contains it, plus the root's concrete directory for this path */
  readonly root: ConcreteRoot
  readonly rootDir: string
  /** true when `real` exists */
  readonly exists: boolean
}

export interface PathPolicyShape {
  /** Resolve and check a path for a bot. `cwd` is used for relative paths (it must itself be in a root). */
  readonly resolve: (input: {
    readonly path: string
    readonly botId: string
    readonly access: PathAccess
    readonly cwd?: string | undefined
  }) => Effect.Effect<ResolvedPath, PathDenied>
  /** True when a canonical path is inside a root for the bot and not denied (for list/glob/grep results). */
  readonly allows: (real: string, botId: string) => boolean
  /** Roots as reported in `node.hello`. */
  readonly roots: ReadonlyArray<NodeRoot>
}

export class PathPolicy extends Context.Service<PathPolicy, PathPolicyShape>()("openbot/node-daemon/PathPolicy") {}

/** Directory names that are never readable or writable through the node. */
export const DENIED_SEGMENTS: ReadonlyArray<string> = [".ssh", ".gnupg", ".aws", ".kube", ".password-store"]
/** File names that are never readable or writable through the node. */
export const DENIED_FILES: ReadonlyArray<string> = [".netrc", ".pgpass", "id_rsa", "id_ed25519", "id_ecdsa"]

const BOT_TOKEN = "{botId}"
const SAFE_BOT = /^[A-Za-z0-9_-]{1,128}$/

/** realpath of the deepest existing ancestor, with the missing tail re-attached. */
export const canonicalize = (abs: string): { readonly real: string; readonly exists: boolean } => {
  let probe = abs
  const tail: Array<string> = []
  while (true) {
    try {
      const real = realpathSync(probe)
      return { real: tail.length ? path.join(real, ...tail.reverse()) : real, exists: tail.length === 0 }
    } catch {
      const up = path.dirname(probe)
      if (up === probe) return { real: abs, exists: false }
      tail.push(path.basename(probe))
      probe = up
    }
  }
}

const isInside = (child: string, parent: string): boolean => {
  if (child === parent) return true
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

export const makePathPolicy = (options: {
  readonly roots: ReadonlyArray<NodeRoot>
  readonly dataDir: string
  readonly denyGlobs?: ReadonlyArray<string> | undefined
  /** create static roots that do not exist yet (default true) */
  readonly createRoots?: boolean | undefined
  /** per-bot roots computed at call time (absolute; never created, never in `roots`) */
  readonly extraRoots?: ((botId: string) => ReadonlyArray<string>) | undefined
}): PathPolicyShape => {
  const createRoots = options.createRoots ?? true
  const dataDirReal = canonicalize(path.resolve(options.dataDir)).real
  const denyGlobs = (options.denyGlobs ?? []).map((g) => new Bun.Glob(g))

  for (const r of options.roots) {
    if (createRoots && !r.path.includes(BOT_TOKEN) && !r.path.split(path.sep).includes("*")) {
      try {
        mkdirSync(r.path, { recursive: true })
      } catch {
        // reported as PathDenied on use
      }
    }
  }

  const concrete = (r: NodeRoot, botId: string): ConcreteRoot | undefined => {
    if (r.path.includes(BOT_TOKEN) && !SAFE_BOT.test(botId)) return undefined
    const display = r.path.split(BOT_TOKEN).join(botId)
    const segs = display.split(path.sep)
    const star = segs.indexOf("*")
    const baseLexical = star < 0 ? display : segs.slice(0, star).join(path.sep) || path.sep
    const pattern = star < 0 ? [] : segs.slice(star)
    return { id: r.id, base: canonicalize(baseLexical).real, pattern, mode: r.mode, display }
  }

  /** The concrete directory of `root` that contains `real`, or undefined. */
  const containing = (root: ConcreteRoot, real: string): string | undefined => {
    if (!isInside(real, root.base)) return undefined
    if (root.pattern.length === 0) return root.base
    const rel = path.relative(root.base, real)
    const segs = rel === "" ? [] : rel.split(path.sep)
    if (segs.length < root.pattern.length) return undefined
    for (let i = 0; i < root.pattern.length; i++) {
      const p = root.pattern[i]!
      const s = segs[i]!
      if (p === "*" ? s === "" || s === ".." : p !== s) return undefined
    }
    return path.join(root.base, ...segs.slice(0, root.pattern.length))
  }

  const denyReason = (real: string): string | undefined => {
    if (isInside(real, dataDirReal)) return "the node's own state directory is not accessible"
    const segs = real.split(path.sep)
    for (const s of segs) {
      if (DENIED_SEGMENTS.includes(s)) return `${s} is on the node's deny-list`
    }
    const base = path.basename(real)
    if (DENIED_FILES.includes(base)) return `${base} is on the node's deny-list`
    for (const g of denyGlobs) if (g.match(real)) return "matches the node's deny-list"
    return undefined
  }

  /** The bot's extra roots: absolute, not `/`, without `*` / `{botId}` (taken literally otherwise). */
  const extraFor = (botId: string): ReadonlyArray<ConcreteRoot> => {
    if (options.extraRoots === undefined) return []
    let raw: ReadonlyArray<string>
    try {
      raw = options.extraRoots(botId)
    } catch {
      return []
    }
    const out: Array<ConcreteRoot> = []
    for (const [i, p] of raw.entries()) {
      if (!path.isAbsolute(p) || p.includes("\0")) continue
      const lexical = path.resolve(p)
      if (lexical === path.parse(lexical).root) continue
      out.push({ id: `project${i + 1}`, base: canonicalize(lexical).real, pattern: [], mode: "rw", display: lexical })
    }
    return out
  }

  const rootsFor = (botId: string) => [
    ...options.roots.map((r) => concrete(r, botId)).filter((r): r is ConcreteRoot => r !== undefined),
    ...extraFor(botId),
  ]

  const find = (real: string, botId: string): { root: ConcreteRoot; dir: string } | undefined => {
    for (const root of rootsFor(botId)) {
      const dir = containing(root, real)
      if (dir !== undefined) return { root, dir }
    }
    return undefined
  }

  const resolve: PathPolicyShape["resolve"] = ({ path: input, botId, access, cwd }) =>
    Effect.suspend(() => {
      const deny = (reason: string) => Effect.fail(new PathDenied({ path: input, reason }))
      if (input.includes("\0") || (cwd ?? "").includes("\0")) return deny("NUL byte in path")
      const roots = rootsFor(botId)
      if (roots.length === 0) return deny("the node has no workspace root for this bot")
      let base: string
      if (path.isAbsolute(input)) base = "/"
      else if (cwd !== undefined && cwd !== "") {
        const cwdAbs = path.isAbsolute(cwd) ? path.resolve(cwd) : undefined
        if (cwdAbs === undefined) {
          const first = roots.find((r) => r.pattern.length === 0)
          if (!first) return deny("relative paths need an absolute cwd on this node")
          base = path.resolve(first.base, cwd)
        } else base = cwdAbs
        const c = canonicalize(base)
        if (!find(c.real, botId)) return deny(`cwd ${cwd} is outside the node's roots`)
      } else {
        const first = roots.find((r) => r.pattern.length === 0)
        if (!first) return deny("relative paths need an absolute path on this node")
        base = first.base
      }
      const requested = path.resolve(base, input)
      const { real, exists } = canonicalize(requested)
      const hit = find(real, botId)
      if (!hit) {
        return deny(
          `outside the node's roots (${roots.map((r) => r.display).join(", ")})${real !== requested ? " after resolving symlinks" : ""}`,
        )
      }
      const reason = denyReason(real) ?? denyReason(requested)
      if (reason) return deny(reason)
      if (access === "write") {
        if (hit.root.mode === "ro") return deny(`root ${hit.root.id} is read-only`)
        try {
          if (lstatSync(requested).isSymbolicLink()) return deny("refusing to write through a symlink")
        } catch {
          // does not exist: fine
        }
      }
      return Effect.succeed({ real, requested, root: hit.root, rootDir: hit.dir, exists })
    })

  return {
    resolve,
    allows: (real, botId) => find(real, botId) !== undefined && denyReason(real) === undefined,
    roots: options.roots,
  }
}

export const PathPolicyLive: Layer.Layer<PathPolicy, never, NodeConfig> = Layer.effect(
  PathPolicy,
  Effect.gen(function* () {
    const config = yield* NodeConfig
    return PathPolicy.of(
      makePathPolicy({ roots: config.roots, dataDir: config.dataDir, denyGlobs: config.denyGlobs, extraRoots: config.extraRoots }),
    )
  }),
)
