// fs.* handlers (capability fs@1). Every path goes through PathPolicy; writes are atomic
// (tmp file in the same directory + rename) and honour `expectedSha256`.
import * as Effect from "effect/Effect"
import { constants as fsConstants } from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import {
  base64Decode,
  base64Encode,
  EditFailed,
  FsError,
  PathDenied,
  type DirEntry,
  type FileStat,
  type FileType,
  type FsEditResult,
  type FsGlobResult,
  type FsGrepResult,
  type FsListResult,
  type FsReadResult,
  type FsWriteResult,
  type GrepMatch,
  type GrepOutputMode,
  type Invocation,
  type TextEncoding,
} from "@openbot/node-protocol"
import type { NodeConfigShape } from "./config.ts"
import type { Guard } from "./guard.ts"
import type { PathPolicyShape, ResolvedPath } from "./PathPolicy.ts"

export const sha256Hex = (data: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(data).digest("hex")

const errCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "EIO"

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Run a fs promise, mapping Node errors to `FsError`. */
export const attempt = <A>(op: string, p: string, f: () => Promise<A>): Effect.Effect<A, FsError> =>
  Effect.tryPromise({ try: f, catch: (e) => new FsError({ op, path: p, code: errCode(e), reason: errMessage(e) }) })

const typeOf = (st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType =>
  st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"

const statOrUndefined = async (p: string) => {
  try {
    return await fsp.lstat(p)
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return undefined
    throw e
  }
}

/** Atomic write: tmp file next to the target, then rename. */
export const atomicWrite = async (target: string, data: string | Uint8Array): Promise<void> => {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.openbot-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  let mode: number | undefined
  try {
    mode = (await fsp.stat(target)).mode & 0o7777
  } catch {
    mode = undefined
  }
  try {
    await Bun.write(tmp, data)
    if (mode !== undefined) await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, target)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export interface FsOpsDeps {
  readonly config: NodeConfigShape
  readonly paths: PathPolicyShape
  readonly guard: Guard
}

export const makeFsOps = ({ config, paths, guard }: FsOpsDeps) => {
  const limits = config.limits

  const read = (p: {
    readonly inv: Invocation
    readonly path: string
    readonly offset?: number | undefined
    readonly limit?: number | undefined
    readonly encoding?: TextEncoding | undefined
  }) =>
    guard(
      { inv: p.inv, action: "read-file", target: p.path },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "read" })
        const st = yield* attempt("read", p.path, () => fsp.stat(r.real))
        if (st.isDirectory()) return yield* new FsError({ op: "read", path: p.path, code: "EISDIR", reason: "is a directory; use fs.list" })
        if (!st.isFile()) return yield* new FsError({ op: "read", path: p.path, code: "EINVAL", reason: "not a regular file" })
        if (st.size > limits.writeBytes) {
          return yield* new FsError({ op: "read", path: p.path, code: "EFBIG", reason: `file is larger than ${limits.writeBytes} bytes` })
        }
        const bytes = yield* attempt("read", p.path, () => Bun.file(r.real).bytes())
        const offset = Math.max(0, Math.floor(p.offset ?? 0))
        const max = Math.max(0, Math.min(Math.floor(p.limit ?? limits.readBytes), limits.readBytes))
        const slice = bytes.subarray(offset, offset + max)
        const encoding: TextEncoding = p.encoding ?? "utf8"
        const result: FsReadResult = {
          content: encoding === "base64" ? base64Encode(slice) : new TextDecoder().decode(slice),
          encoding,
          sha256: sha256Hex(bytes),
          size: bytes.byteLength,
          truncated: offset > 0 || offset + max < bytes.byteLength,
        }
        return result
      }),
    )

  const currentSha = (real: string) =>
    attempt("write", real, async () => {
      const st = await statOrUndefined(real)
      if (!st) return ""
      if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: st.isDirectory() ? "EISDIR" : "EINVAL" })
      return sha256Hex(await Bun.file(real).bytes())
    })

  const write = (p: {
    readonly inv: Invocation
    readonly path: string
    readonly content: string
    readonly encoding?: TextEncoding | undefined
    readonly expectedSha256?: string | undefined
    readonly createParents?: boolean | undefined
  }) =>
    guard(
      { inv: p.inv, action: "write-file", target: p.path },
      Effect.gen(function* () {
        let r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "write" })
        const data = p.encoding === "base64" ? base64Decode(p.content) : new TextEncoder().encode(p.content)
        if (data.byteLength > limits.writeBytes) {
          return yield* new FsError({ op: "write", path: p.path, code: "EFBIG", reason: `content is larger than ${limits.writeBytes} bytes` })
        }
        const cur = yield* currentSha(r.real)
        if (p.expectedSha256 !== undefined && cur !== p.expectedSha256) {
          return yield* new EditFailed({
            path: p.path,
            reason: `stale write: the file's sha256 is ${cur || "<absent>"}, expected ${p.expectedSha256 || "<absent>"}; re-read it first`,
          })
        }
        const parent = path.dirname(r.real)
        if (p.createParents ?? true) {
          yield* attempt("mkdir", p.path, () => fsp.mkdir(parent, { recursive: true }))
          // re-check containment after creating parents
          r = yield* paths.resolve({ path: r.real, botId: p.inv.botId, access: "write" })
        }
        yield* attempt("write", p.path, () => atomicWrite(r.real, data))
        return { sha256: sha256Hex(data), size: data.byteLength } satisfies FsWriteResult
      }),
    )

  const edit = (p: {
    readonly inv: Invocation
    readonly path: string
    readonly oldString: string
    readonly newString: string
    readonly replaceAll?: boolean | undefined
    readonly expectedSha256?: string | undefined
  }) =>
    guard(
      { inv: p.inv, action: "write-file", target: p.path },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "write" })
        if (!r.exists) return yield* new FsError({ op: "edit", path: p.path, code: "ENOENT", reason: "no such file" })
        const st = yield* attempt("edit", p.path, () => fsp.stat(r.real))
        if (!st.isFile()) return yield* new FsError({ op: "edit", path: p.path, code: st.isDirectory() ? "EISDIR" : "EINVAL", reason: "not a regular file" })
        const bytes = yield* attempt("edit", p.path, () => Bun.file(r.real).bytes())
        const sha = sha256Hex(bytes)
        if (p.expectedSha256 !== undefined && sha !== p.expectedSha256) {
          return yield* new EditFailed({ path: p.path, reason: `stale edit: the file's sha256 is ${sha}, expected ${p.expectedSha256}; re-read it first` })
        }
        if (p.oldString === "") return yield* new EditFailed({ path: p.path, reason: "oldString must not be empty" })
        if (p.oldString === p.newString) return yield* new EditFailed({ path: p.path, reason: "oldString and newString are identical" })
        const text = new TextDecoder().decode(bytes)
        const n = text.split(p.oldString).length - 1
        if (n === 0) return yield* new EditFailed({ path: p.path, reason: "oldString was not found in the file" })
        if (n > 1 && !p.replaceAll) {
          return yield* new EditFailed({ path: p.path, reason: `oldString matches ${n} times; add surrounding context to make it unique, or set replaceAll` })
        }
        const out = p.replaceAll ? text.split(p.oldString).join(p.newString) : text.replace(p.oldString, () => p.newString)
        yield* attempt("edit", p.path, () => atomicWrite(r.real, out))
        return { sha256: sha256Hex(out), replacements: p.replaceAll ? n : 1 } satisfies FsEditResult
      }),
    )

  const stat = (p: { readonly inv: Invocation; readonly path: string }) =>
    guard(
      { inv: p.inv, action: "read-file", target: p.path },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "read" })
        const st = yield* attempt("stat", p.path, () => statOrUndefined(r.requested))
        if (!st) return null
        return { path: r.requested, type: typeOf(st), size: st.size, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 } satisfies FileStat
      }),
    )

  const list = (p: {
    readonly inv: Invocation
    readonly path: string
    readonly depth?: number | undefined
    readonly includeHidden?: boolean | undefined
    readonly limit?: number | undefined
  }) =>
    guard(
      { inv: p.inv, action: "list-directory", target: p.path },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "read" })
        const st = yield* attempt("list", p.path, () => fsp.stat(r.real))
        if (!st.isDirectory()) return yield* new FsError({ op: "list", path: p.path, code: "ENOTDIR", reason: "not a directory" })
        const depth = Math.max(1, Math.floor(p.depth ?? 1))
        const limit = Math.max(1, Math.min(Math.floor(p.limit ?? limits.listEntries), limits.listEntries * 10))
        return yield* attempt("list", p.path, async (): Promise<FsListResult> => {
          const entries: Array<DirEntry> = []
          let truncated = false
          const queue: Array<{ rel: string; level: number }> = [{ rel: "", level: 1 }]
          while (queue.length > 0 && !truncated) {
            const { rel, level } = queue.shift()!
            const dir = rel === "" ? r.real : path.join(r.real, rel)
            let names: Array<string>
            try {
              names = (await fsp.readdir(dir)).sort()
            } catch {
              continue
            }
            for (const name of names) {
              if (!p.includeHidden && name.startsWith(".")) continue
              const childRel = rel === "" ? name : `${rel}/${name}`
              const abs = path.join(r.real, childRel)
              if (!paths.allows(abs, p.inv.botId)) continue
              const cst = await statOrUndefined(abs)
              if (!cst) continue
              if (entries.length >= limit) {
                truncated = true
                break
              }
              const type = typeOf(cst)
              entries.push({ path: childRel, type, size: type === "dir" ? 0 : cst.size, mtimeMs: Math.floor(cst.mtimeMs) })
              if (type === "dir" && level < depth) queue.push({ rel: childRel, level: level + 1 })
            }
          }
          return { entries, truncated }
        })
      }),
    )

  const glob = (p: { readonly inv: Invocation; readonly pattern: string; readonly cwd: string; readonly limit?: number | undefined }) =>
    guard(
      { inv: p.inv, action: "list-directory", target: `${p.cwd}:${p.pattern}` },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.cwd, botId: p.inv.botId, access: "read" })
        const st = yield* attempt("glob", p.cwd, () => fsp.stat(r.real))
        if (!st.isDirectory()) return yield* new FsError({ op: "glob", path: p.cwd, code: "ENOTDIR", reason: "cwd is not a directory" })
        const limit = Math.max(1, Math.min(Math.floor(p.limit ?? limits.globResults), limits.globResults * 10))
        return yield* attempt("glob", p.cwd, async (): Promise<FsGlobResult> => {
          const found: Array<{ abs: string; mtime: number }> = []
          let truncated = false
          const g = new Bun.Glob(p.pattern)
          for await (const rel of g.scan({ cwd: r.real, onlyFiles: true, followSymlinks: false, dot: false })) {
            const abs = path.resolve(r.real, rel)
            if (!paths.allows(abs, p.inv.botId)) continue
            if (found.length >= limit) {
              truncated = true
              break
            }
            const s = await statOrUndefined(abs)
            found.push({ abs, mtime: s?.mtimeMs ?? 0 })
          }
          found.sort((a, b) => b.mtime - a.mtime || a.abs.localeCompare(b.abs))
          return { paths: found.map((f) => f.abs), truncated }
        })
      }),
    )

  const grep = (p: {
    readonly inv: Invocation
    readonly pattern: string
    readonly path: string
    readonly glob?: string | undefined
    readonly ignoreCase?: boolean | undefined
    readonly literal?: boolean | undefined
    readonly contextLines?: number | undefined
    readonly outputMode?: GrepOutputMode | undefined
    readonly limit?: number | undefined
  }) =>
    guard(
      { inv: p.inv, action: "read-file", target: `${p.path}:${p.pattern}` },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "read" })
        if (!r.exists) return yield* new FsError({ op: "grep", path: p.path, code: "ENOENT", reason: "no such file or directory" })
        const limit = Math.max(1, Math.min(Math.floor(p.limit ?? limits.grepMatches), limits.grepMatches * 10))
        const opts = { ...p, limit, contextLines: Math.max(0, Math.min(Math.floor(p.contextLines ?? 0), 20)) }
        const raw = config.binaries.rg ? yield* grepRipgrep(config.binaries.rg, r, opts) : yield* grepJs(r, opts)
        return finishGrep(raw, (abs) => paths.allows(abs, p.inv.botId), opts.outputMode ?? "content", limit)
      }),
    )

  const mkdir = (p: { readonly inv: Invocation; readonly path: string; readonly recursive?: boolean | undefined }) =>
    guard(
      { inv: p.inv, action: "write-file", target: p.path },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "write" })
        yield* attempt("mkdir", p.path, () => fsp.mkdir(r.real, { recursive: p.recursive ?? true }))
      }),
    )

  const move = (p: { readonly inv: Invocation; readonly from: string; readonly to: string; readonly overwrite?: boolean | undefined }) =>
    guard(
      { inv: p.inv, action: "write-file", target: `${p.from} -> ${p.to}` },
      Effect.gen(function* () {
        const from = yield* paths.resolve({ path: p.from, botId: p.inv.botId, access: "write" })
        const to = yield* paths.resolve({ path: p.to, botId: p.inv.botId, access: "write" })
        if (!from.exists) return yield* new FsError({ op: "move", path: p.from, code: "ENOENT", reason: "no such file or directory" })
        if (from.real === from.rootDir) return yield* new PathDenied({ path: p.from, reason: "cannot move a workspace root" })
        if (to.exists && !p.overwrite) return yield* new FsError({ op: "move", path: p.to, code: "EEXIST", reason: "destination exists; set overwrite" })
        yield* attempt("move", p.to, () => fsp.mkdir(path.dirname(to.real), { recursive: true }))
        yield* attempt("move", p.from, async () => {
          try {
            await fsp.rename(from.real, to.real)
          } catch (e) {
            if (errCode(e) !== "EXDEV") throw e
            await fsp.cp(from.real, to.real, { recursive: true, force: p.overwrite ?? false, errorOnExist: !p.overwrite })
            await fsp.rm(from.real, { recursive: true, force: true })
          }
        })
      }),
    )

  const remove = (p: { readonly inv: Invocation; readonly path: string; readonly recursive?: boolean | undefined }) =>
    guard(
      { inv: p.inv, action: "write-file", target: p.path },
      Effect.gen(function* () {
        const r = yield* paths.resolve({ path: p.path, botId: p.inv.botId, access: "write" })
        if (r.real === r.rootDir) return yield* new PathDenied({ path: p.path, reason: "cannot remove a workspace root" })
        const st = yield* attempt("remove", p.path, () => fsp.lstat(r.requested))
        if (st.isDirectory()) {
          yield* attempt("remove", p.path, () => (p.recursive ? fsp.rm(r.real, { recursive: true }) : fsp.rmdir(r.real)))
        } else {
          // a symlink is removed itself, never its target
          yield* attempt("remove", p.path, () => fsp.unlink(r.requested))
        }
      }),
    )

  return { read, write, edit, stat, list, glob, grep, mkdir, move, remove }
}

// ---------------------------------------------------------------- grep backends
interface GrepOpts {
  readonly pattern: string
  readonly glob?: string | undefined
  readonly ignoreCase?: boolean | undefined
  readonly literal?: boolean | undefined
  readonly contextLines: number
  readonly limit: number
}
interface RawGrep {
  /** absolute path -> lines (match + context) */
  readonly lines: Array<GrepMatch & { readonly isMatch: boolean }>
  readonly counts: Map<string, number>
  readonly truncated: boolean
}

const MAX_SCAN_LINES = 20_000

const grepRipgrep = (rg: string, r: ResolvedPath, o: GrepOpts): Effect.Effect<RawGrep, FsError> =>
  Effect.gen(function* () {
    const isDir = (yield* attempt("grep", r.requested, () => fsp.stat(r.real))).isDirectory()
    const args = [rg, "--json", "--no-config", "--no-messages"]
    if (o.ignoreCase) args.push("-i")
    if (o.literal) args.push("-F")
    if (o.contextLines > 0) args.push("-C", String(o.contextLines))
    if (o.glob) args.push("--glob", o.glob)
    args.push("-e", o.pattern, "--", r.real)
    void isDir
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })),
      (proc) =>
        attempt("grep", r.requested, async (): Promise<RawGrep> => {
          const lines: Array<GrepMatch & { isMatch: boolean }> = []
          const counts = new Map<string, number>()
          let matches = 0
          let truncated = false
          let buf = ""
          const decoder = new TextDecoder()
          const handle = (line: string) => {
            if (!line) return
            let m: { type?: string; data?: any }
            try {
              m = JSON.parse(line)
            } catch {
              return
            }
            if (m.type !== "match" && m.type !== "context") return
            const file = m.data?.path?.text as string | undefined
            const text = (m.data?.lines?.text as string | undefined) ?? ""
            const ln = m.data?.line_number as number | undefined
            if (!file || ln === undefined) return
            const abs = path.resolve(r.real, file)
            if (m.type === "match") {
              counts.set(abs, (counts.get(abs) ?? 0) + 1)
              matches++
            }
            if (lines.length < MAX_SCAN_LINES) lines.push({ path: abs, line: ln, text: text.replace(/\r?\n$/, ""), isMatch: m.type === "match" })
          }
          for await (const chunk of proc.stdout) {
            buf += decoder.decode(chunk, { stream: true })
            let i: number
            while ((i = buf.indexOf("\n")) >= 0) {
              handle(buf.slice(0, i))
              buf = buf.slice(i + 1)
            }
            if (matches > o.limit * 4 && lines.length >= MAX_SCAN_LINES) {
              truncated = true
              proc.kill()
              break
            }
          }
          handle(buf)
          const code = await proc.exited
          if (code === 2 && matches === 0) {
            const err = (await new Response(proc.stderr).text()).trim()
            if (err) throw Object.assign(new Error(err.split("\n")[0] ?? err), { code: "EINVAL" })
          }
          return { lines, counts, truncated }
        }),
      (proc) => Effect.sync(() => proc.kill()),
    )
  })

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn"])

const grepJs = (r: ResolvedPath, o: GrepOpts): Effect.Effect<RawGrep, FsError> =>
  attempt("grep", r.requested, async (): Promise<RawGrep> => {
    let re: RegExp
    try {
      re = new RegExp(o.literal ? escapeRegExp(o.pattern) : o.pattern, o.ignoreCase ? "i" : "")
    } catch (e) {
      throw Object.assign(new Error(`invalid regular expression: ${errMessage(e)}`), { code: "EINVAL" })
    }
    const globber = o.glob ? new Bun.Glob(o.glob) : undefined
    const lines: Array<GrepMatch & { isMatch: boolean }> = []
    const counts = new Map<string, number>()
    let truncated = false
    const files: Array<string> = []
    const st = await fsp.stat(r.real)
    if (st.isFile()) files.push(r.real)
    else {
      const walk = async (dir: string) => {
        let names: Array<string>
        try {
          names = (await fsp.readdir(dir)).sort()
        } catch {
          return
        }
        for (const name of names) {
          if (name.startsWith(".") || SKIP_DIRS.has(name)) continue
          const abs = path.join(dir, name)
          const s = await statOrUndefined(abs)
          if (!s) continue
          if (s.isDirectory()) await walk(abs)
          else if (s.isFile()) {
            const rel = path.relative(r.real, abs)
            if (globber && !globber.match(rel) && !globber.match(name)) continue
            files.push(abs)
          }
        }
      }
      await walk(r.real)
    }
    let matches = 0
    for (const file of files) {
      if (matches > o.limit * 4) {
        truncated = true
        break
      }
      let bytes: Uint8Array
      try {
        await fsp.access(file, fsConstants.R_OK)
        bytes = await Bun.file(file).bytes()
      } catch {
        continue
      }
      if (bytes.subarray(0, 8192).includes(0)) continue
      const all = new TextDecoder().decode(bytes).split(/\r?\n/)
      const keep = new Set<number>()
      const hit = new Set<number>()
      all.forEach((l, i) => {
        if (re.test(l)) {
          hit.add(i)
          for (let k = Math.max(0, i - o.contextLines); k <= Math.min(all.length - 1, i + o.contextLines); k++) keep.add(k)
        }
      })
      if (hit.size === 0) continue
      counts.set(file, hit.size)
      matches += hit.size
      for (const i of [...keep].sort((a, b) => a - b)) {
        if (lines.length >= MAX_SCAN_LINES) break
        lines.push({ path: file, line: i + 1, text: all[i]!, isMatch: hit.has(i) })
      }
    }
    return { lines, counts, truncated }
  })

const finishGrep = (raw: RawGrep, allows: (abs: string) => boolean, mode: GrepOutputMode, limit: number): FsGrepResult => {
  const files = [...raw.counts.keys()].filter(allows).sort()
  let truncated = raw.truncated
  if (mode === "files_with_matches") {
    if (files.length > limit) truncated = true
    return { matches: [], files: files.slice(0, limit), counts: [], truncated }
  }
  if (mode === "count") {
    if (files.length > limit) truncated = true
    return { matches: [], files: files.slice(0, limit), counts: files.slice(0, limit).map((f) => ({ path: f, count: raw.counts.get(f) ?? 0 })), truncated }
  }
  const matches: Array<GrepMatch> = []
  let n = 0
  for (const l of raw.lines) {
    if (!allows(l.path)) continue
    if (l.isMatch) {
      if (n >= limit) {
        truncated = true
        break
      }
      n++
    }
    matches.push({ path: l.path, line: l.line, text: l.text.length > 2000 ? `${l.text.slice(0, 2000)}…` : l.text })
  }
  return { matches, files, counts: [], truncated }
}
