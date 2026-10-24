// Project folders on the local computer: HOME / git repo roots (HostPathsLive) and the local node's
// extra path-policy roots kept current from the roster (projectFolderRoots).
import { afterAll, describe, expect, test } from "bun:test"
import type { BotId, KnownRosterStreamItem, NodeId } from "@openbot/contracts"
import { DEFAULT_SETTINGS } from "@openbot/contracts"
import { HostPaths, LiveHub } from "@openbot/core"
import { makeBot } from "@openbot/core/testing"
import { Effect, Layer, Queue, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { gitRootOf, HostPathsLive, localHome, localProjectRoots, projectFolderRoots } from "../src/index.ts"
import { tempDir } from "./helpers.ts"

const t = tempDir()
afterAll(t.cleanup)

describe("HostPathsLive", () => {
  const repo = path.join(t.path, "projects", "snip")
  const worktree = path.join(t.path, "projects", "wt")
  mkdirSync(path.join(repo, ".git"), { recursive: true })
  mkdirSync(path.join(repo, "src", "deep"), { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere")
  mkdirSync(path.join(t.path, "plain", "dir"), { recursive: true })

  test("git root: the nearest ancestor with .git (dir or worktree file), else undefined", () => {
    expect(gitRootOf(path.join(repo, "src", "deep"))).toBe(repo)
    expect(gitRootOf(repo)).toBe(repo)
    expect(gitRootOf(worktree)).toBe(worktree)
    // the temp dir is not inside a repository on CI machines; when it is, the answer is above `t.path`
    const plain = gitRootOf(path.join(t.path, "plain", "dir"))
    expect(plain === undefined || !plain.startsWith(t.path)).toBe(true)
  })

  test("the local node answers home and repo roots; remote nodes answer nothing", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* HostPaths
        return {
          home: host.home("node_local" as NodeId),
          remoteHome: host.home("nod_mac" as NodeId),
          root: yield* host.projectRoot("node_local" as NodeId, path.join(repo, "src")),
          remoteRoot: yield* host.projectRoot("nod_mac" as NodeId, path.join(repo, "src")),
        }
      }).pipe(Effect.provide(HostPathsLive)),
    )
    expect(out).toEqual({ home: localHome(), remoteHome: undefined, root: repo, remoteRoot: undefined })
  })

  test("localProjectRoots: `~` expanded, invalid / duplicate / whole-home entries dropped", () => {
    expect(
      localProjectRoots(["~/projects", "/srv/code/", "/srv/code", "/", "relative", "~", "/home/me"], "/home/me"),
    ).toEqual(["/home/me/projects", "/srv/code"])
  })
})

describe("projectFolderRoots (the local node's extra roots)", () => {
  const ada = makeBot({ id: "bot_ada" as BotId, projectFolders: ["/srv/snip"] })
  const bo = makeBot({ id: "bot_bo" as BotId })

  test("none without a LiveHub", async () => {
    const roots = await Effect.runPromise(Effect.scoped(projectFolderRoots))
    expect(roots).toBeUndefined()
  })

  test("shared ∪ per-bot from the roster snapshot, then live changes", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const items = yield* Queue.unbounded<KnownRosterStreamItem>()
          const cursor = { epoch: "r", sequence: 0 }
          yield* Queue.offer(items, {
            kind: "snapshot",
            cursor,
            bots: [ada, bo],
            conversations: [],
            activities: [],
            nodes: [],
            sections: [],
            settings: { ...DEFAULT_SETTINGS, sharedProjectFolders: ["/srv/shared"] },
          })
          const hub = Layer.mock(LiveHub, { subscribeRoster: () => Stream.fromQueue(items) })
          const roots = (yield* projectFolderRoots.pipe(Effect.provide(hub)))!
          const initial = { ada: roots(ada.id), bo: roots(bo.id) }
          yield* Queue.offer(items, {
            kind: "change",
            cursor,
            change: { type: "bot.upserted", bot: { ...bo, projectFolders: ["/srv/bo"] } },
          })
          yield* Queue.offer(items, { kind: "change", cursor, change: { type: "bot.removed", botId: ada.id } })
          yield* Queue.offer(items, {
            kind: "change",
            cursor,
            change: { type: "settings.updated", settings: DEFAULT_SETTINGS },
          })
          for (let i = 0; i < 100 && roots(bo.id).join() !== "/srv/bo"; i++) yield* Effect.yieldNow
          return { initial, later: { ada: roots(ada.id), bo: roots(bo.id) } }
        }),
      ),
    )
    expect(out.initial).toEqual({ ada: ["/srv/shared", "/srv/snip"], bo: ["/srv/shared"] })
    expect(out.later).toEqual({ ada: [], bo: ["/srv/bo"] })
  })
})
