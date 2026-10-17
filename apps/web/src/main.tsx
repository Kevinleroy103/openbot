// Browser entry (index.html → this file). The whole app shares one atom registry; every
// @openbot/client atom (RPC runtime, roster, conversations, commands) lives in it.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RegistryProvider } from "@effect/atom-react"
import { Toaster } from "@openbot/ui"
import { App } from "./app/App.tsx"

const root = document.getElementById("root")
if (!root) throw new Error("#root missing from index.html")

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <Toaster>
        <App />
      </Toaster>
    </RegistryProvider>
  </StrictMode>,
)
