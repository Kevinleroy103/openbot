// Browser entry (index.html → this file). The whole app shares one atom registry; every
// @openbot/client atom (RPC runtime, roster, conversations, commands) lives in it.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RegistryProvider } from "@effect/atom-react"
import { Toaster } from "@openbot/ui"
import { App } from "./app/App.tsx"
import { desktopApp } from "./app/notifications.ts"

const root = document.getElementById("root")
if (!root) throw new Error("#root missing from index.html")

// In the desktop app (apps/desktop): `data-desktop` = its platform. On macOS the window has no title
// bar: a strip along the top moves it (app.css `.ob-titlebar`), first in the page so the buttons
// and fields after it stay clickable.
const desktop = desktopApp()
if (desktop !== undefined) document.documentElement.dataset.desktop = desktop.platform

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <Toaster>
        {desktop?.platform === "darwin" && <div aria-hidden className="ob-titlebar" />}
        <App />
      </Toaster>
    </RegistryProvider>
  </StrictMode>,
)
