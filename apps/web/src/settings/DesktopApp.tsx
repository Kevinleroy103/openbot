// Settings › General › Apps: the desktop app (built for your computer by this OpenBot,
// `/desktop/download/<target>`, or installed from a terminal with `/desktop/install.sh`) and
// notifications on this device.
import { PillButton, Switch } from "@openbot/ui"
import { type ReactNode, useState } from "react"
import { type DesktopUpdateState, updateReady, useDesktopUpdate } from "../app/desktopUpdate.ts"
import { desktopApp, notificationsSupported, setNotificationsEnabled, useNotificationsEnabled } from "../app/notifications.ts"
import { CommandBlock } from "../details/kit.tsx"
import { SettingsRow } from "./layout.tsx"

type Target = "darwin-arm64" | "darwin-x64" | "win32-x64" | "linux-x64" | "linux-arm64"

const TARGETS: ReadonlyArray<{ readonly id: Target; readonly label: string }> = [
  { id: "darwin-arm64", label: "macOS (Apple silicon)" },
  { id: "darwin-x64", label: "macOS (Intel)" },
  { id: "win32-x64", label: "Windows" },
  { id: "linux-x64", label: "Linux" },
  { id: "linux-arm64", label: "Linux (ARM)" },
]

/** Best guess from the browser (Safari reports every Mac as Intel: Apple silicon is the likely one). */
const guessTarget = (): Target => {
  const ua = navigator.userAgent
  if (/Mac/.test(ua)) return "darwin-arm64"
  if (/Windows/.test(ua)) return "win32-x64"
  return /aarch64|arm64/i.test(ua) ? "linux-arm64" : "linux-x64"
}

const href = (target: Target) => `/desktop/download/${target}`

const checkResult = (state: DesktopUpdateState | undefined): string => {
  if (state === undefined) return ""
  if (updateReady(state)) return "A new version is ready: restart with the button in the sidebar."
  if (state.status === "downloading") return "A new version is downloading."
  if (state.status === "error") return `Couldn't check for updates: ${state.message}`
  return "OpenBot is up to date."
}

/** In the desktop app: its version, and a check for updates (it also checks by itself). */
function RunningApp({ version }: { readonly version: string }): ReactNode {
  const update = useDesktopUpdate()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<string | undefined>()
  const check = async () => {
    setChecking(true)
    setResult(checkResult(await update.check()))
    setChecking(false)
  }
  return (
    <SettingsRow
      title="Desktop app"
      description={update.supported
        ? `Version ${version}. It updates itself from this OpenBot, and keeps running when you close its window so notifications keep coming.`
        : `Version ${version}. Install it once more (below) to get automatic updates from now on.`}
      wide
      control={update.supported
        ? (
          <PillButton variant="secondary" size="md" loading={checking} onClick={() => void check()} data-testid="desktop-check-updates">
            Check for updates
          </PillButton>
        )
        : undefined}
    >
      {result && <p className="pt-2 text-sm text-fg-secondary">{result}</p>}
      {!update.supported && desktopApp()?.platform !== "win32" && (
        <div className="pt-2">
          <CommandBlock command={`curl -fsSL ${location.origin}/desktop/install.sh | sh`} />
        </div>
      )}
    </SettingsRow>
  )
}

export function DesktopAppRow(): ReactNode {
  const running = desktopApp()
  if (running !== undefined) return <RunningApp version={running.version} />
  return <DownloadApp />
}

function DownloadApp(): ReactNode {
  const [target] = useState(guessTarget)
  const primary = TARGETS.find((t) => t.id === target)!
  const others = TARGETS.filter((t) => t.id !== target)
  const unix = !target.startsWith("win32")
  return (
    <SettingsRow
      title="Desktop app"
      description="OpenBot in its own window, with notifications on your computer. It keeps running when you close the window, and updates itself."
      wide
      control={
        // an attachment: the page stays where it is
        <PillButton variant="secondary" size="md" onClick={() => window.location.assign(href(target))} data-testid="desktop-download">
          Download for {primary.label}
        </PillButton>
      }
    >
      <div className="flex flex-col gap-2 pt-2 text-sm text-fg-secondary">
        <span>
          Also for{" "}
          {others.map((t, i) => (
            <span key={t.id}>
              <a className="text-fg underline-offset-2 hover:underline" href={href(t.id)} download>
                {t.label}
              </a>
              {i < others.length - 1 ? ", " : ""}
            </span>
          ))}
          . The first download for a computer takes about a minute to prepare.
        </span>
        {unix && (
          <>
            <span>Or install it from a terminal{target.startsWith("darwin") ? " (on a Mac this skips the security prompt below)" : ""}:</span>
            <CommandBlock command={`curl -fsSL ${location.origin}/desktop/install.sh | sh`} />
          </>
        )}
        {target.startsWith("darwin") && (
          <span>
            Downloaded with the browser, macOS asks once before the first start: open System Settings › Privacy &amp; Security and click
            Open Anyway next to OpenBot.
          </span>
        )}
      </div>
    </SettingsRow>
  )
}

export function NotificationsRow(): ReactNode {
  const enabled = useNotificationsEnabled()
  const [denied, setDenied] = useState(false)
  const inApp = desktopApp() !== undefined
  const supported = notificationsSupported()
  return (
    <SettingsRow
      title="Notifications on this device"
      description={inApp
        ? "Show your Bots' updates as notifications on this computer: when they finish, need you or write to you."
        : "Show your Bots' updates as notifications while OpenBot is open in this browser. The desktop app shows them even when its window is closed."}
      control={
        <Switch
          checked={enabled}
          disabled={!supported}
          onCheckedChange={(on) => void setNotificationsEnabled(on).then((took) => setDenied(on && !took))}
          label="Notifications on this device"
        />
      }
    >
      {denied && <p className="pt-2 text-sm text-warn-fg">This browser blocked notifications for OpenBot. Allow them in its site settings, then turn this on again.</p>}
    </SettingsRow>
  )
}
