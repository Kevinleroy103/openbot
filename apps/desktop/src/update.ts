/**
 * Updates from the brain that built this copy: `/desktop/latest` names the build it serves now; a
 * different one is downloaded in the background (`/desktop/download/<platform>-<arch>`), and once it
 * is ready the web app shows "Restart to update" (preload `onUpdate`). Installing swaps the app in
 * place after it quits and starts the new one: on macOS the `.app` bundle (re-signed ad hoc by the
 * Mac's own `codesign`), on Linux the folder the app runs from. Windows (an exe cannot replace itself
 * while it runs) and a macOS app run from where it was downloaded (App Translocation: read-only) get
 * the download in the browser instead.
 */
import { execFile, spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

export type UpdateState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "up-to-date" }
  | { readonly status: "downloading"; readonly build: string }
  | { readonly status: "ready"; readonly build: string }
  | { readonly status: "manual"; readonly build: string }
  | { readonly status: "error"; readonly message: string }

const run = promisify(execFile)

export const makeUpdater = (input: {
  readonly origin: string
  readonly build: string | undefined
  readonly workDir: string
  readonly onChange: (state: UpdateState) => void
  readonly quit: () => void
  readonly openExternal: (url: string) => void
}) => {
  const target = `${process.platform}-${process.arch}`
  const download = `${input.origin}/desktop/download/${target}`
  let state: UpdateState = { status: "idle" }
  let staged: string | undefined
  const set = (next: UpdateState) => {
    state = next
    input.onChange(next)
  }

  /** The installed app: the `.app` bundle on macOS, the folder with the executable elsewhere. */
  const installed = (): string =>
    process.platform === "darwin" ? resolve(dirname(process.execPath), "../..") : dirname(process.execPath)

  const canSwap = () => process.platform !== "win32" && !installed().includes("/AppTranslocation/")

  const fetchStaged = async (build: string) => {
    const dir = join(input.workDir, build)
    await rm(input.workDir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const res = await fetch(download)
    if (!res.ok || res.body === null) throw new Error(`download failed (${res.status})`)
    const archive = join(dir, "package")
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive))
    const unpacked = join(dir, "app")
    await mkdir(unpacked)
    if (process.platform === "darwin") {
      await run("ditto", ["-x", "-k", archive, unpacked])
      const app = join(unpacked, "OpenBot.app")
      await run("xattr", ["-cr", app]).catch(() => undefined)
      await run("codesign", ["--force", "--deep", "--sign", "-", app]).catch(() => undefined)
      return app
    }
    await run("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1"])
    return unpacked
  }

  const check = async (): Promise<UpdateState> => {
    if (state.status === "checking" || state.status === "downloading") return state
    if (state.status === "ready" || state.status === "manual") return state
    set({ status: "checking" })
    try {
      const res = await fetch(`${input.origin}/desktop/latest`, { cache: "no-store" })
      const latest = (await res.json()) as { build?: unknown }
      if (typeof latest.build !== "string" || latest.build === input.build) {
        set({ status: "up-to-date" })
        return state
      }
      if (!canSwap()) {
        set({ status: "manual", build: latest.build })
        return state
      }
      set({ status: "downloading", build: latest.build })
      staged = await fetchStaged(latest.build)
      set({ status: "ready", build: latest.build })
    } catch (e) {
      set({ status: "error", message: e instanceof Error ? e.message : String(e) })
    }
    return state
  }

  /** Swaps the app in place once this process is gone, and starts the new one. */
  const install = () =>
    swap().catch((e: unknown) => {
      // could not swap it in place: the owner gets the download instead
      console.error("OpenBot: installing the update failed", e)
      set({ status: "error", message: e instanceof Error ? e.message : String(e) })
      input.openExternal(download)
    })

  const swap = async () => {
    if (state.status === "manual" || staged === undefined) {
      input.openExternal(download)
      return
    }
    const old = installed()
    const relaunch =
      process.platform === "darwin"
        ? `open "${old}"`
        : `nohup "${old}/${process.execPath.split("/").at(-1)}" ${process.argv
            .slice(1)
            .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
            .join(" ")} >/dev/null 2>&1 &`
    const script = join(input.workDir, "apply.sh")
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
        `rm -rf "${old}.previous"`,
        `mv "${old}" "${old}.previous" && mv "${staged}" "${old}" && rm -rf "${old}.previous"`,
        // the swap failed: put the old app back
        `[ -e "${old}" ] || mv "${old}.previous" "${old}"`,
        relaunch,
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref()
    input.quit()
  }

  return { check, install, state: () => state }
}
