/**
 * Quick send: a small panel that floats over whatever the owner is doing, to send it to a Bot. It
 * opens with the global shortcut (⌥⌘O / Ctrl+Alt+O), `openbot://send?…` links (the Share menu
 * Shortcut, the bookmarklet, Raycast or Alfred) or `--quick-send` (a key bound on Linux), and comes
 * filled in with:
 * - the page open in the browser in front (Safari or a Chromium browser, asked over AppleScript on
 *   macOS: the owner allows it once per browser);
 * - what the owner copied in the last two minutes (text or an image), offered once;
 * - what a link carried (`url`, `title`, `text`, `to` = a Bot or group by name).
 * A link only fills the panel: sending always takes the owner's Enter.
 *
 * The panel is the web app's `#/quick-send` page (apps/web/src/quick/QuickSend.tsx), loaded once and
 * kept, so it opens at once; it talks to this module through the preload (`openbotDesktop.quickSend`).
 */
import { BrowserWindow, clipboard, globalShortcut, ipcMain, screen } from "electron"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import type { QuickSendPrefill } from "./links.ts"

export { prefillOfLink, type QuickSendPrefill } from "./links.ts"

const run = promisify(execFile)
const isMac = process.platform === "darwin"
export const QUICK_SEND_SHORTCUT = "CommandOrControl+Alt+O"
/** How recent a copy must be to be offered. */
const CLIPBOARD_FRESH_MS = 2 * 60 * 1000
const PANEL_WIDTH = 640

const CHROMIUM = [
  "Google Chrome",
  "Google Chrome Canary",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Chromium",
  "Vivaldi",
  "Opera",
]
const SAFARI = ["Safari", "Safari Technology Preview"]

/** The page open in the browser in front, on macOS. */
const frontBrowserPage = async (): Promise<QuickSendPrefill["link"]> => {
  if (!isMac) return undefined
  try {
    const front = (await run("lsappinfo", ["front"], { timeout: 1000 })).stdout.trim()
    const info = (await run("lsappinfo", ["info", "-only", "name", front], { timeout: 1000 })).stdout
    const name = /"LSDisplayName"="([^"]+)"/.exec(info)?.[1]
    if (name === undefined) return undefined
    const script = SAFARI.includes(name)
      ? `tell application "${name}" to return (URL of front document) & linefeed & (name of front document)`
      : CHROMIUM.includes(name)
        ? `tell application "${name}" to return (URL of active tab of front window) & linefeed & (title of active tab of front window)`
        : undefined
    if (script === undefined) return undefined
    const [url, ...title] = (await run("osascript", ["-e", script], { timeout: 2000 })).stdout.trim().split("\n")
    return url !== undefined && /^https?:\/\//.test(url)
      ? { url, title: title.join(" ").trim(), from: name }
      : undefined
  } catch {
    return undefined
  }
}

/** The "Send to OpenBot" Shortcut (Share menu and Services): its input as an `openbot://send` link. */
const shortcutPlist = () => {
  const encode = "6F4F3C8A-0B1D-4C4E-9E59-0A8B2B1F7D11"
  const link = "openbot://send?text=￼"
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WFWorkflowClientVersion</key><string>2302.0.4</string>
<key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
<key>WFWorkflowIcon</key><dict><key>WFWorkflowIconStartColor</key><integer>255</integer><key>WFWorkflowIconGlyphNumber</key><integer>59446</integer></dict>
<key>WFWorkflowTypes</key><array><string>ActionExtension</string><string>QuickActions</string></array>
<key>WFQuickActionSurfaces</key><array><string>Services</string></array>
<key>WFWorkflowInputContentItemClasses</key><array><string>WFURLContentItem</string><string>WFSafariWebPageContentItem</string><string>WFStringContentItem</string><string>WFRichTextContentItem</string><string>WFArticleContentItem</string></array>
<key>WFWorkflowImportQuestions</key><array/>
<key>WFWorkflowActions</key><array>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.urlencode</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>${encode}</string><key>WFEncodeMode</key><string>Encode</string>
<key>WFInput</key><dict><key>Value</key><dict><key>attachmentsByRange</key><dict><key>{0, 1}</key><dict><key>Type</key><string>ExtensionInput</string></dict></dict><key>string</key><string>￼</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict>
</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.openurl</string>
<key>WFWorkflowActionParameters</key><dict>
<key>WFInput</key><dict><key>Value</key><dict><key>attachmentsByRange</key><dict><key>{${link.indexOf("￼")}, 1}</key><dict><key>OutputName</key><string>URL Encoded Text</string><key>OutputUUID</key><string>${encode}</string><key>Type</key><string>ActionOutput</string></dict></dict><key>string</key><string>${link.replaceAll("&", "&amp;")}</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict>
</dict></dict>
</array>
</dict></plist>
`
}

export const makeQuickSend = (input: {
  readonly origin: string
  readonly preload: string
  readonly canOpen: () => boolean
  readonly fallback: () => void
}) => {
  let panel: BrowserWindow | undefined
  let prefill: QuickSendPrefill = { id: 0 }
  let shotting = false

  // What the clipboard holds and since when (Electron cannot tell when it changed: compare every second).
  let clip = { signature: "", changedAt: 0, offered: "" }
  const copiedImage = async (): Promise<Blob | undefined> => {
    if (!(await clipboard.has("image/png"))) return undefined
    const item = (await clipboard.read()).find((i) => i.types.includes("image/png"))
    return item === undefined ? undefined : await item.getType("image/png")
  }
  const signatureOf = async () => {
    const image = await copiedImage().catch(() => undefined)
    if (image !== undefined) return `image:${image.size}`
    return `text:${await clipboard.readText().catch(() => "")}`
  }
  void signatureOf().then((signature) => {
    clip.signature = signature
    setInterval(() => {
      void signatureOf().then((next) => {
        if (next !== clip.signature) clip = { ...clip, signature: next, changedAt: Date.now() }
      })
    }, 1000).unref()
  })

  const freshClipboard = async (): Promise<QuickSendPrefill["clipboard"]> => {
    if (Date.now() - clip.changedAt > CLIPBOARD_FRESH_MS || clip.signature === clip.offered) return undefined
    clip = { ...clip, offered: clip.signature }
    if (clip.signature.startsWith("image:")) {
      const image = await copiedImage().catch(() => undefined)
      if (image === undefined) return undefined
      return { image: `data:image/png;base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}` }
    }
    const text = (await clipboard.readText().catch(() => "")).trim()
    return text === "" ? undefined : { text: text.slice(0, 20_000) }
  }

  const ensurePanel = () => {
    if (panel !== undefined && !panel.isDestroyed()) return panel
    panel = new BrowserWindow({
      width: PANEL_WIDTH,
      height: 260,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: "OpenBot Quick Send",
      // macOS: floats over full-screen apps without bringing OpenBot's main window forward
      ...(isMac ? { type: "panel" as const } : {}),
      webPreferences: { preload: input.preload, contextIsolation: true, sandbox: true, spellcheck: true },
    })
    // without skipTransformProcessType Electron turns OpenBot into a background app and back, and
    // macOS then leaves it out of ⌘Tab until it is activated again; a panel floats without that
    if (isMac) panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    panel.setAlwaysOnTop(true, "pop-up-menu")
    panel.on("blur", () => {
      if (!shotting) panel?.hide()
    })
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    void panel.loadURL(`${input.origin}/#/quick-send`)
    return panel
  }

  const place = (window: BrowserWindow) => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { x, y, width, height } = display.workArea
    const [, h] = window.getSize()
    window.setPosition(
      Math.round(x + (width - PANEL_WIDTH) / 2),
      Math.round(y + Math.max(40, height * 0.22 - (h ?? 0) / 4)),
    )
  }

  /** Opens the panel filled in with `extra` (a link's), the clipboard and, on macOS, the browser's page. */
  const open = async (extra: Omit<QuickSendPrefill, "id"> = {}) => {
    if (!input.canOpen()) return input.fallback()
    const window = ensurePanel()
    const copied = await freshClipboard()
    prefill = { id: prefill.id + 1, ...extra, ...(copied === undefined ? {} : { clipboard: copied }) }
    const id = prefill.id
    window.webContents.send("openbot:qs-prefill", prefill)
    place(window)
    window.show()
    window.focus()
    if (extra.link === undefined) {
      void frontBrowserPage().then((link) => {
        if (link === undefined || prefill.id !== id) return
        prefill = { ...prefill, link }
        window.webContents.send("openbot:qs-prefill", prefill)
      })
    }
  }

  const hide = () => {
    if (panel !== undefined && !panel.isDestroyed()) panel.hide()
  }

  /** A region of the screen the owner picks (macOS `screencapture`, Linux `grim` + `slurp`). */
  const screenshot = async (): Promise<string | undefined> => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-shot-"))
    const file = join(dir, "screenshot.png")
    shotting = true
    panel?.hide()
    try {
      if (isMac) await run("screencapture", ["-i", "-x", file])
      else await run("sh", ["-c", `grim -g "$(slurp)" '${file}'`])
      return `data:image/png;base64,${(await readFile(file)).toString("base64")}`
    } catch {
      return undefined
    } finally {
      shotting = false
      await rm(dir, { recursive: true, force: true })
      if (panel !== undefined && !panel.isDestroyed()) {
        panel.show()
        panel.focus()
      }
    }
  }

  const canScreenshot = async () => {
    if (isMac) return true
    if (process.platform !== "linux") return false
    return run("sh", ["-c", "command -v grim && command -v slurp"]).then(
      () => true,
      () => false,
    )
  }

  /** Adds "Send to OpenBot" to the Share menu and Services (macOS Shortcuts: signed, then opened to add). */
  const installShortcut = async (): Promise<{ readonly ok: boolean; readonly error?: string }> => {
    if (!isMac) return { ok: false, error: "The Share menu Shortcut is for macOS." }
    const dir = await mkdtemp(join(tmpdir(), "openbot-shortcut-"))
    try {
      const unsigned = join(dir, "unsigned.shortcut")
      const signed = join(dir, "Send to OpenBot.shortcut")
      await writeFile(unsigned, shortcutPlist())
      await run("shortcuts", ["sign", "--mode", "anyone", "--input", unsigned, "--output", signed], { timeout: 30_000 })
      await run("open", [signed])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }
    }
  }

  let registered = false
  const registerShortcut = () => {
    try {
      registered = globalShortcut.register(QUICK_SEND_SHORTCUT, () => void open())
    } catch {
      registered = false
    }
  }

  ipcMain.handle("openbot:qs-prefill", () => prefill)
  ipcMain.on("openbot:qs-resize", (_event, height: unknown) => {
    if (panel === undefined || panel.isDestroyed() || typeof height !== "number") return
    panel.setSize(PANEL_WIDTH, Math.max(160, Math.min(720, Math.ceil(height))))
  })
  ipcMain.on("openbot:qs-close", hide)
  ipcMain.handle("openbot:qs-screenshot", screenshot)
  ipcMain.handle("openbot:qs-info", async () => ({
    shortcut: isMac ? "⌥⌘O" : "Ctrl+Alt+O",
    registered,
    canScreenshot: await canScreenshot(),
    platform: process.platform,
  }))
  ipcMain.handle("openbot:qs-install-shortcut", installShortcut)

  return { open, registerShortcut, warm: () => void ensurePanel() }
}
