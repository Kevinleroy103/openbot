// Connect apps › Hark (D3.5): OpenBot's notifications on the owner's iPhone through Hark until the
// OpenBot iPhone app has its own. Not connected: get Hark on the iPhone, create a service in Hark's
// web dashboard (the app has none), paste its webhook (OpenBot sends a test notification to check
// it). Connected: what to send, a test, Disconnect.
import { harkStatusAtom } from "@openbot/client"
import type { HarkStatus } from "@openbot/contracts"
import { PillButton, TextField } from "@openbot/ui"
import { ExternalLink } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useCommand, useQuery } from "../details/kit.tsx"
import { GroupLabel, RowDivider, SettingsCard, SettingsRow } from "../settings/layout.tsx"
import { PushConnected, PushPage } from "./PushApp.tsx"

export const HARK_SITE = "https://hark.ryan.ceo"
const HARK_APP_STORE = "https://apps.apple.com/us/app/hark-developer-notifications/id6794121509"

export function HarkApp(): ReactNode {
  return (
    <div className="flex flex-col">
      <PushPage name="Hark" status={useQuery(harkStatusAtom)} Connect={Connect} Connected={Connected} />
    </div>
  )
}

function Connected({ status }: { readonly status: HarkStatus }): ReactNode {
  return (
    <PushConnected
      app="hark"
      name="Hark"
      device="iPhone"
      status={status}
      what="webhook"
      leftBehind="The service stays in Hark until you remove it there."
    />
  )
}

function Connect(): ReactNode {
  const connect = useCommand("hark.connect")
  const [webhook, setWebhook] = useState("")
  return (
    <>
      <GroupLabel>Connect Hark</GroupLabel>
      <SettingsCard testId="hark-connect">
        <SettingsRow
          title="1. Get Hark on your iPhone"
          description="Install it, sign in and allow notifications."
          control={
            <PillButton
              variant="secondary"
              size="md"
              trailingIcon={ExternalLink}
              onClick={() => window.open(HARK_APP_STORE, "_blank", "noopener")}
            >
              App Store
            </PillButton>
          }
        />
        <RowDivider />
        <SettingsRow
          title="2. Create a service"
          description="In Hark's web dashboard (signed in with the same account), create a service called OpenBot and copy the webhook URL it shows (…/hooks/whk_…)."
          wide
          control={
            <PillButton
              variant="secondary"
              size="md"
              trailingIcon={ExternalLink}
              onClick={() => window.open(HARK_SITE, "_blank", "noopener")}
            >
              Hark dashboard
            </PillButton>
          }
        >
          <TextField
            type="password"
            autoComplete="off"
            placeholder="https://hark.ryan.ceo/hooks/whk_…"
            aria-label="Hark webhook"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Connect"
          description="OpenBot sends a test notification to your iPhone and keeps the webhook on this server."
          control={
            <PillButton
              variant="primary"
              size="md"
              disabled={webhook.trim() === ""}
              loading={connect.pending}
              data-testid="hark-connect-button"
              onClick={() => void connect.run({ webhook: webhook.trim() }).then((r) => r.ok && setWebhook(""))}
            >
              Connect
            </PillButton>
          }
        >
          {connect.error && <p className="text-sm text-danger-fg">{connect.error}</p>}
        </SettingsRow>
      </SettingsCard>
    </>
  )
}
