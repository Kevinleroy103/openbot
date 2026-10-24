import { UiCard as UiCardSchema, type CardState, type UiCard, type UiValues } from "@openbot/contracts"
import { Schema } from "effect"
import { useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { UiCardContent } from "../src/cards/UiCard.tsx"
import choice from "./fixtures/ui/ui-choice.json"
import everything from "./fixtures/ui/ui-everything.json"
import hostile from "./fixtures/ui/ui-hostile.json"

const fixtures: Record<string, unknown> = { choice, everything, hostile }
const params = new URLSearchParams(location.search)
const initial = Schema.decodeUnknownSync(UiCardSchema)(fixtures[params.get("fixture") ?? "everything"])
document.documentElement.dataset.theme = params.get("theme") ?? "light"

declare global {
  interface Window {
    lastUiAction?: { actionId: string; values: UiValues }
    updateUiCard: (card: UiCard) => void
  }
}

function Harness(): ReactNode {
  const [card, setCard] = useState(initial)
  const [state, setState] = useState<CardState>({ status: initial.actions?.length ? "pending" : "info" })
  const [error, setError] = useState<string>()
  useEffect(() => {
    window.updateUiCard = setCard
  }, [])
  return (
    <UiCardContent
      card={card}
      state={state}
      entryId={"ent_test" as never}
      pending={false}
      error={error}
      onAct={(actionId, values) => {
        window.lastUiAction = { actionId, values }
        if (params.has("fail")) setError("This card could not be answered. Try again.")
        else setState({ status: "resolved", answer: { actionId, values, at: Date.now() } })
      }}
    />
  )
}

createRoot(document.getElementById("root")!).render(<Harness />)
