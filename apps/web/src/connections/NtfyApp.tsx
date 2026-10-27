// Connect apps › ntfy (D3.6): OpenBot's notifications on any phone with the ntfy app (Android,
// iPhone), on ntfy.sh or the owner's own ntfy server. Not connected: get ntfy, pick a topic (a long
// random one: on ntfy.sh anyone who knows it can read it), subscribe to it in the app, connect
// (OpenBot sends a test notification to check it). Connected: the topic, then the shared card (PushApp.tsx).
import { ntfyStatusAtom } from "@openbot/client"
import type { NtfyStatus } from "@openbot/contracts"
import { PillButton, TextField } from "@openbot/ui"
import { ExternalLink } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useCommand, useQuery } from "../details/kit.tsx"
import { GroupLabel, RowDivider, SettingsCard, SettingsRow } from "../settings/layout.tsx"
import { PushConnected, PushPage } from "./PushApp.tsx"

export const NTFY_SITE = "https://ntfy.sh"
const NTFY_ANDROID = "https://play.google.com/store/apps/details?id=io.heckel.ntfy"
const NTFY_IOS = "https://apps.apple.com/app/ntfy/id1625396347"

/** A topic nobody guesses: `openbot-` and 20 random letters and digits. */
export const randomTopic = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `openbot-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`
}

export function NtfyApp(): ReactNode {
  return (
    <div className="flex flex-col">
      <PushPage name="ntfy" status={useQuery(ntfyStatusAtom)} Connect={Connect} Connected={Connected} />
    </div>
  )
}

function Connected({ status }: { readonly status: NtfyStatus }): ReactNode {
  return (
    <PushConnected
      app="ntfy"
      name="ntfy"
      device="phone"
      status={status}
      what="topic"
      leftBehind="The subscription stays in the ntfy app until you remove it there."
    >
      <SettingsRow
        title="Topic"
        description={`${status.topic ?? ""} on ${status.server ?? NTFY_SITE}. Subscribe to it in the ntfy app.`}
      />
      <RowDivider />
    </PushConnected>
  )
}

function Connect(): ReactNode {
  const connect = useCommand("ntfy.connect")
  const [topic, setTopic] = useState(randomTopic)
  const [server, setServer] = useState("")
  const [token, setToken] = useState("")
  return (
    <>
      <GroupLabel>Connect ntfy</GroupLabel>
      <SettingsCard testId="ntfy-connect">
        <SettingsRow
          title="1. Get ntfy on your phone"
          description="Install it, and allow notifications."
          control={
            <div className="flex gap-2">
              <PillButton
                variant="secondary"
                size="md"
                trailingIcon={ExternalLink}
                onClick={() => window.open(NTFY_ANDROID, "_blank", "noopener")}
              >
                Android
              </PillButton>
              <PillButton
                variant="secondary"
                size="md"
                trailingIcon={ExternalLink}
                onClick={() => window.open(NTFY_IOS, "_blank", "noopener")}
              >
                iPhone
              </PillButton>
            </div>
          }
        />
        <RowDivider />
        <SettingsRow
          title="2. Subscribe to a topic"
          description="In the ntfy app, add a subscription with this topic name (on ntfy.sh, keep it long and secret: anyone who knows it can read your notifications)."
          wide
          control={
            <PillButton variant="secondary" size="md" onClick={() => setTopic(randomTopic())}>
              New topic
            </PillButton>
          }
        >
          <TextField
            autoComplete="off"
            aria-label="ntfy topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Your own server (optional)"
          description="Leave blank for ntfy.sh. For a server of your own, its address and, if it needs a sign-in, an access token."
          wide
        >
          <div className="flex flex-col gap-2">
            <TextField
              autoComplete="off"
              placeholder="https://ntfy.sh"
              aria-label="ntfy server"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
            <TextField
              type="password"
              autoComplete="off"
              placeholder="Access token (tk_…)"
              aria-label="ntfy access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Connect"
          description="OpenBot sends a test notification to your phone and keeps the topic on this server."
          control={
            <PillButton
              variant="primary"
              size="md"
              disabled={topic.trim() === ""}
              loading={connect.pending}
              data-testid="ntfy-connect-button"
              onClick={() =>
                void connect
                  .run({
                    topic: topic.trim(),
                    ...(server.trim() === "" ? {} : { server: server.trim() }),
                    ...(token.trim() === "" ? {} : { token: token.trim() }),
                  })
                  .then((r) => r.ok && setToken(""))
              }
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
