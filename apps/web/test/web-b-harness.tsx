// W2.3 screenshot harness: renders the W2.3 components (details pane, computer view, settings,
// new bot / group forms, onboarding) in a minimal three-pane frame against an OpenBot RPC endpoint
// (the dev mock server or a real brain). Query params:
//   rpc=ws://host:port/rpc   theme=dark|light   scene=details|computer|settings|newbot|newgroup|onboarding
//   tab=details|library|computer (details)   page=general|harnesses|computers|permissions|usage|updates (settings)
import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { botsAtom, clientConfigAtom, conversationSummariesAtom, defaultClientConfig } from "@openbot/client"
import type { Bot, BotId } from "@openbot/contracts"
import { Dialog, DialogHeader, Toaster } from "@openbot/ui"
import { AsyncResult } from "effect/reactivity"
import { StrictMode, type ReactNode, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { ComputerView } from "../src/computer/index.tsx"
import type { DetailsTab, SettingsPage } from "../src/contracts.ts"
import { useComputerView, useDetailsPane } from "../src/contracts.ts"
import { DetailsPane } from "../src/details/index.tsx"
import { NewBotForm, NewGroupForm } from "../src/dialogs/index.tsx"
import { Onboarding } from "../src/onboarding/index.tsx"
import { SettingsDialog } from "../src/settings/index.tsx"

const params = new URLSearchParams(location.search)
const theme = params.get("theme") === "light" ? "light" : "dark"
const scene = params.get("scene") ?? "details"
document.documentElement.dataset.theme = theme
const rpc = params.get("rpc") ?? undefined

function useFirstBot(): Bot | undefined {
  const bots = useAtomValue(botsAtom)
  const want = params.get("bot")
  if (!AsyncResult.isSuccess(bots)) return undefined
  return bots.value.find((b) => b.id === want || b.name === want) ?? bots.value[0]
}

function Frame({ children, details }: { readonly children?: ReactNode; readonly details?: ReactNode }): ReactNode {
  return (
    <div className="relative flex h-screen bg-chrome" data-web-b-ready>
      <div className="w-[280px] shrink-0 bg-sidebar" />
      <main className="relative flex min-w-0 flex-1 flex-col border-s-[0.5px] border-line-tertiary bg-pane">
        {children}
      </main>
      {details && <div className="w-[320px] shrink-0 border-s-[0.5px] border-line-tertiary">{details}</div>}
    </div>
  )
}

function DetailsScene(): ReactNode {
  const bot = useFirstBot()
  const pane = useDetailsPane()
  const computer = useComputerView()
  useEffect(() => {
    const tab = params.get("tab") as DetailsTab | null
    if (tab) pane.setTab(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Frame
      details={
        bot ? <DetailsPane botId={bot.id} onClose={() => {}} /> : <div data-loading className="h-full bg-chrome" />
      }
    >
      {computer.botId && <ComputerView botId={computer.botId} onClose={computer.close} />}
    </Frame>
  )
}

function GroupScene(): ReactNode {
  const summaries = useAtomValue(conversationSummariesAtom)
  const group = AsyncResult.isSuccess(summaries) ? summaries.value.find((c) => c.kind === "group") : undefined
  return (
    <Frame
      details={
        group ? (
          <DetailsPane conversationId={group.id} onClose={() => {}} />
        ) : (
          <div data-loading className="h-full bg-chrome" />
        )
      }
    />
  )
}

function ComputerScene(): ReactNode {
  const bot = useFirstBot()
  return (
    <Frame details={bot ? <DetailsPane botId={bot.id} tab="computer" onClose={() => {}} /> : undefined}>
      {bot && (
        <div className="fixed inset-0 z-[2500]">
          <ComputerView botId={bot.id as BotId} onClose={() => {}} />
        </div>
      )}
    </Frame>
  )
}

function FormScene({ kind }: { readonly kind: "newbot" | "newgroup" }): ReactNode {
  const bots = useAtomValue(botsAtom)
  const initial = AsyncResult.isSuccess(bots) ? bots.value.slice(0, 2).map((b) => b.id) : []
  return (
    <Frame>
      <Dialog
        open
        onOpenChange={() => {}}
        width={kind === "newbot" ? 520 : 480}
        label={kind === "newbot" ? "Create a Bot" : "New group chat"}
      >
        <DialogHeader title={kind === "newbot" ? "Create a Bot" : "New group chat"} onClose={() => {}} />
        {kind === "newbot" ? (
          <NewBotForm onCreated={(id) => (document.body.dataset.created = id)} onCancel={() => {}} />
        ) : AsyncResult.isSuccess(bots) ? (
          <NewGroupForm
            initialBotIds={initial}
            onCreated={(id) => (document.body.dataset.created = id)}
            onCancel={() => {}}
          />
        ) : null}
      </Dialog>
    </Frame>
  )
}

function App(): ReactNode {
  switch (scene) {
    case "computer":
      return <ComputerScene />
    case "group":
      return <GroupScene />
    case "settings":
      return (
        <Frame>
          <SettingsDialog
            open
            initialPage={(params.get("page") as SettingsPage | null) ?? "general"}
            onClose={() => {}}
          />
        </Frame>
      )
    case "newbot":
    case "newgroup":
      return <FormScene kind={scene} />
    case "onboarding":
      return (
        <div className="h-screen" data-web-b-ready>
          <Onboarding onDone={() => (document.body.dataset.onboardingDone = "1")} />
        </div>
      )
    default:
      return <DetailsScene />
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider initialValues={rpc ? [[clientConfigAtom, defaultClientConfig({ url: rpc })]] : []}>
      <Toaster>
        <App />
      </Toaster>
    </RegistryProvider>
  </StrictMode>,
)
