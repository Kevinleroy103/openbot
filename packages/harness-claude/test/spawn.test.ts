import { describe, expect, test } from "bun:test"
import { makeProcessGroupSpawner, supportsProcessGroups } from "../src/spawn.ts"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(10)
}

/** The "CLI" starts a grandchild in its group, prints its pid, then waits on stdin. */
const CLI_SCRIPT = "sleep 30 & echo $!; read line"

const grandchildOf = (child: ReturnType<ReturnType<typeof makeProcessGroupSpawner>["spawn"]>) =>
  new Promise<number>((resolve) => {
    child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
  })

describe.skipIf(!supportsProcessGroups)("process-group spawner", () => {
  test("spawns detached, reports pid, and kills the whole group when the CLI exits", async () => {
    const spawned: Array<number> = []
    const exited: Array<number> = []
    const spawner = makeProcessGroupSpawner({ onSpawn: (pid) => spawned.push(pid), onExit: (pid) => exited.push(pid) })
    expect(spawner.pid()).toBeUndefined()
    await spawner.waitExit() // nothing started: resolves at once
    const controller = new AbortController()
    const child = spawner.spawn({ command: "sh", args: ["-c", CLI_SCRIPT], env: { PATH: process.env.PATH }, signal: controller.signal })
    const grandchild = await grandchildOf(child)
    expect(spawned).toEqual([child.pid!])
    expect(spawner.pid()).toBe(child.pid!)
    expect(alive(grandchild)).toBe(true)
    child.stdin!.end() // the CLI exits on stdin EOF
    await spawner.waitExit()
    await waitFor(() => !alive(grandchild))
    expect(exited).toEqual([child.pid!])
    expect(alive(grandchild)).toBe(false)
  })

  test("killGroup stops a CLI that ignores stdin EOF, grandchildren included", async () => {
    const exited: Array<number> = []
    const spawner = makeProcessGroupSpawner({ onExit: (pid) => exited.push(pid) })
    const child = spawner.spawn({
      command: "sh",
      args: ["-c", "sleep 30 & echo $!; trap '' TERM; sleep 30"],
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    })
    const grandchild = await grandchildOf(child)
    child.stdin!.end()
    spawner.killGroup()
    await spawner.waitExit()
    await waitFor(() => !alive(grandchild))
    expect(exited).toEqual([child.pid!])
    expect(alive(grandchild)).toBe(false)
  })
})
