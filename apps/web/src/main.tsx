// Browser entry (index.html → this file). The whole app shares one atom registry; every
// @openbot/client atom (RPC runtime, roster, conversations, commands) lives in it.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RegistryProvider } from "@effect/atom-react"
import { Toaster } from "@openbot/ui"
import { App } from "./app/App.tsx"
import { desktopApp } from "./app/notifications.ts"
import { QuickSend } from "./quick/QuickSend.tsx"

const root = document.getElementById("root")
if (!root) throw new Error("#root missing from index.html")

// In the desktop app (apps/desktop): `data-desktop` = its platform. On macOS the window has no title
// bar: a strip along the top moves it (app.css `.ob-titlebar`), first in the page so the buttons
// and fields after it stay clickable.
const desktop = desktopApp()
if (desktop !== undefined) document.documentElement.dataset.desktop = desktop.platform

// `#/quick-send`: only the quick send card (the desktop app's floating panel, or the bookmarklet's
// popup), not the app; in the panel the page around the card is transparent.
const quickSend = location.hash.startsWith("#/quick-send")
if (quickSend) document.documentElement.dataset.quickSend = desktop?.quickSend !== undefined ? "panel" : "page"

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <Toaster>
        {quickSend ? (
          <QuickSend />
        ) : (
          <>
            {desktop?.platform === "darwin" && <div aria-hidden className="ob-titlebar" />}
            <App />
          </>
        )}
      </Toaster>
    </RegistryProvider>
  </StrictMode>,
)
