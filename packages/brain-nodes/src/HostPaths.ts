/**
 * Project folders on the brain machine (the local computer, `node_local`):
 *
 * - `HostPathsLive` (core `HostPaths`): the local home is the brain process's `HOME` (else
 *   `os.homedir()`); the project root of a directory is the nearest ancestor holding `.git` (a
 *   directory, or a file for worktrees / submodules). Remote computers answer `undefined` (they do
 *   not report a home yet), so autonomy keeps asking for their `~` folders and "Allow in ‹folder›"
 *   offers the request's directory.
 * - `projectFolderRoots`: the local node's extra path-policy roots per bot = Settings' shared
 *   project folders ∪ the bot's own, `~` expanded, kept current from the roster replica (snapshot,
 *   then `bot.upserted` / `bot.removed` / `settings.updated`). Remote nodes keep their own roots
 *   (their owner's `--root` flags): the brain never widens a remote node's policy.
 */
import type { Bot, NodeId, Settings } from "@openbot/contracts"
import { LOCAL_NODE_ID, normalizeProjectFolder, projectFolderProblem } from "@openbot/contracts"
import { HostPaths, LiveHub } from "@openbot/core"
import { Deferred, Effect, Layer, Option, type Scope, Stream } from "effect"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

/** The brain process's home directory. */
export const localHome = (): string => {
  const home = process.env.HOME
  return home !== undefined && path.isAbsolute(home) ? path.resolve(home) : homedir()
}

/** `~` / `~/x` → absolute with `home`; anything else unchanged. */
export const expandTilde = (p: string, home: string): string =>
  p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p

/** Nearest ancestor of `dir` (itself included) that holds `.git`, or undefined. */
export const gitRootOf = (dir: string): string | undefined => {
  let probe = path.resolve(dir)
  while (true) {
    if (existsSync(path.join(probe, ".git"))) return probe
    const up = path.dirname(probe)
    if (up === probe) return undefined
    probe = up
  }
}

export const HostPathsLive: Layer.Layer<HostPaths> = Layer.succeed(
  HostPaths,
  HostPaths.of({
    home: (nodeId: NodeId) => (nodeId === LOCAL_NODE_ID ? localHome() : undefined),
    projectRoot: (nodeId: NodeId, dir: string) =>
      Effect.sync(() => {
        if (nodeId !== LOCAL_NODE_ID) return undefined
        const absolute = expandTilde(dir, localHome())
        return path.isAbsolute(absolute) ? gitRootOf(absolute) : undefined
      }),
  }),
)

/** Valid project folders as absolute local paths (`~` expanded); invalid entries are dropped. */
export const localProjectRoots = (folders: ReadonlyArray<string>, home: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const raw of folders) {
    if (projectFolderProblem(raw) !== undefined) continue
    const absolute = expandTilde(normalizeProjectFolder(raw), home)
    if (!path.isAbsolute(absolute)) continue
    const resolved = path.resolve(absolute)
    if (resolved !== home && !out.includes(resolved)) out.push(resolved)
  }
  return out
}

/**
 * The local node's per-bot extra roots (`NodeConfigInput.extraRoots`), kept current from the roster
 * while the calling scope lives. Without a `LiveHub` (tests of the node layers alone) there are none.
 */
export const projectFolderRoots: Effect.Effect<((botId: string) => ReadonlyArray<string>) | undefined, never, Scope.Scope> =
  Effect.gen(function*() {
    const hub = Option.getOrUndefined(yield* Effect.serviceOption(LiveHub))
    if (hub === undefined) return undefined
    const home = localHome()
    let shared: ReadonlyArray<string> = []
    const perBot = new Map<string, ReadonlyArray<string>>()
    const setSettings = (settings: Settings) => {
      shared = settings.sharedProjectFolders
    }
    const setBot = (bot: Bot) => {
      if (bot.projectFolders.length === 0) perBot.delete(bot.id)
      else perBot.set(bot.id, bot.projectFolders)
    }
    const ready = yield* Deferred.make<void>()
    yield* hub.subscribeRoster({}).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function*() {
          if (item.kind === "snapshot") {
            setSettings(item.settings)
            perBot.clear()
            for (const bot of item.bots) setBot(bot)
            yield* Deferred.succeed(ready, undefined)
            return
          }
          if (item.kind !== "change") return
          const change = item.change
          if (change.type === "settings.updated") setSettings(change.settings)
          else if (change.type === "bot.upserted") setBot(change.bot)
          else if (change.type === "bot.removed") perBot.delete(change.botId)
        })
      ),
      Effect.catchCause((cause) => Effect.logWarning("local node: project folders no longer tracked", cause)),
      Effect.forkScoped,
    )
    // the first snapshot (bounded: the node must come up even if the roster is slow)
    yield* Deferred.await(ready).pipe(Effect.timeoutOption("5 seconds"))
    return (botId: string) => localProjectRoots([...shared, ...(perBot.get(botId) ?? [])], home)
  })
