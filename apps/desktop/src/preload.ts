/**
 * The bridge between the page (the web app, or connect.html) and the desktop app: `window.openbotDesktop`.
 * The web app uses it to show the unread badge, bring the window forward when a notification is
 * clicked, offer "Restart to update" and sign the app out; connect.html to retry or reopen the browser.
 */
import { contextBridge, ipcRenderer } from "electron"

const info = ipcRenderer.sendSync("openbot:info") as { readonly version: string; readonly build: string; readonly origin: string }

contextBridge.exposeInMainWorld("openbotDesktop", {
  version: info.version,
  build: info.build,
  platform: process.platform,
  setBadgeCount: (count: number) => ipcRenderer.send("openbot:badge", count),
  focus: () => ipcRenderer.send("openbot:focus"),
  signOut: () => ipcRenderer.send("openbot:sign-out"),
  retry: () => ipcRenderer.send("openbot:retry"),
  reconnect: () => ipcRenderer.send("openbot:connect"),
  openApproval: (url: string) => ipcRenderer.send("openbot:open-approval", url),
  // updates (update.ts): the state now, every change, a check on demand, and the restart
  updateState: () => ipcRenderer.invoke("openbot:update-state"),
  onUpdate: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state)
    ipcRenderer.on("openbot:update", handler)
    return () => void ipcRenderer.removeListener("openbot:update", handler)
  },
  checkForUpdates: () => ipcRenderer.invoke("openbot:check-updates"),
  installUpdate: () => ipcRenderer.send("openbot:install-update"),
})
