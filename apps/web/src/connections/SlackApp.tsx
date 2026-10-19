// Connect apps › Slack (D3.4): connect the owner's own Slack app. Three steps: create the app from
// OpenBot's manifest (Slack's "Create an app" opens filled in), install it and paste the User OAuth
// Token, and optionally an app-level token for live messages (Socket Mode). Tokens go to the brain
// and are never shown again. Connected: the workspace, live messages and Disconnect.
import { slackStatusAtom } from "@openbot/client"
import { type SlackStatus, slackAppManifest, slackCreateAppUrl } from "@openbot/contracts"
import { CardLink, PillButton, StatusPill, TextField } from "@openbot/ui"
import { ExternalLink } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ConfirmDialog, ErrorLine, LoadingLine, useCommand, useQuery } from "../details/kit.tsx"
import { GroupLabel, RowDivider, SettingsCard, SettingsRow } from "../settings/layout.tsx"

/** The page under the app's header; the window keeps the status fresh while it is open. */
export function SlackApp(): ReactNode {
  const status = useQuery(slackStatusAtom)
  return (
    <div className="flex flex-col">
      {status.loading ? (
        <LoadingLine />
      ) : status.error && !status.value ? (
        <ErrorLine onRetry={status.refresh}>Couldn't check Slack: {status.error}</ErrorLine>
      ) : status.value?.connected ? (
        <Connected status={status.value} />
      ) : (
        <Connect />
      )}
      <GroupLabel>What Bots can do</GroupLabel>
      <SettingsCard>
        <SettingsRow title="Read and search" description="Everything you can see in Slack: channels, DMs and threads." />
        <RowDivider />
        <SettingsRow title="Draft messages" description="A Bot writes the message; you edit it and press Send. It goes out as you. Nothing is sent without you." />
        <RowDivider />
        <SettingsRow title="Start routines" description="When someone DMs you, mentions you, or says a phrase. Add one under a Bot's Details › Routines, or ask the Bot." />
      </SettingsCard>
    </div>
  )
}

function Connect(): ReactNode {
  const connect = useCommand("slack.connect")
  const [userToken, setUserToken] = useState("")
  const [appToken, setAppToken] = useState("")
  const [copied, setCopied] = useState(false)
  const copyManifest = async () => {
    await navigator.clipboard.writeText(JSON.stringify(slackAppManifest(), null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2_000)
  }
  return (
    <>
      <GroupLabel>Connect your Slack</GroupLabel>
      <SettingsCard testId="slack-connect">
        <SettingsRow
          title="1. Create the app"
          description="Opens Slack with OpenBot's app filled in. Pick your workspace, then Next and Create."
          control={
            <PillButton variant="secondary" size="md" trailingIcon={ExternalLink} onClick={() => window.open(slackCreateAppUrl(), "_blank", "noopener")}>
              Create in Slack
            </PillButton>
          }
        >
          <CardLink className="text-sm" onClick={() => void copyManifest()}>
            {copied ? "Copied" : "Or copy the manifest (Create New App › From a manifest)"}
          </CardLink>
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="2. Install it"
          description="In the app, open Install App, click Install to your workspace and Allow. Then copy the User OAuth Token."
          wide
        >
          <TextField
            type="password"
            autoComplete="off"
            placeholder="xoxp-…"
            aria-label="User OAuth Token"
            value={userToken}
            onChange={(e) => setUserToken(e.target.value)}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="3. Live messages (optional)"
          description="So Slack messages can start routines: in Basic Information › App-Level Tokens, click Generate Token and Scopes, add connections:write, and copy the token."
          wide
        >
          <TextField
            type="password"
            autoComplete="off"
            placeholder="xapp-…"
            aria-label="App-level token"
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Connect"
          description="OpenBot checks the tokens with Slack and keeps them on this server."
          control={
            <PillButton
              variant="primary"
              size="md"
              disabled={userToken.trim() === ""}
              loading={connect.pending}
              data-testid="slack-connect-button"
              onClick={() =>
                void connect.run({ userToken: userToken.trim(), ...(appToken.trim() === "" ? {} : { appToken: appToken.trim() }) }).then((r) => {
                  if (r.ok) {
                    setUserToken("")
                    setAppToken("")
                  }
                })}
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

const eventsPill = (status: SlackStatus): ReactNode => {
  switch (status.events) {
    case "live":
      return <StatusPill tone="success" dot>On</StatusPill>
    case "connecting":
      return <StatusPill tone="neutral" spinner>Connecting</StatusPill>
    case "failed":
      return <StatusPill tone="danger" dot>Not working</StatusPill>
    case "off":
      return <StatusPill tone="neutral">Off</StatusPill>
  }
}

function Connected({ status }: { readonly status: SlackStatus }): ReactNode {
  const disconnect = useCommand("slack.disconnect")
  const connect = useCommand("slack.connect", "app-token")
  const [confirming, setConfirming] = useState(false)
  const [appToken, setAppToken] = useState("")
  return (
    <>
      <GroupLabel>Connected</GroupLabel>
      <SettingsCard testId="slack-connected">
        <SettingsRow
          title={status.team ?? "Slack"}
          description={[status.userName === undefined ? undefined : `As ${status.userName}`, status.teamUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "")]
            .filter((part) => part !== undefined)
            .join(" · ")}
          control={
            <PillButton variant="secondary" size="md" loading={disconnect.pending} onClick={() => setConfirming(true)}>
              Disconnect
            </PillButton>
          }
        />
        <RowDivider />
        <SettingsRow
          title="Live messages"
          description={status.events === "live"
            ? "Slack messages can start your Bots' routines."
            : status.events === "connecting"
            ? "Connecting to Slack…"
            : status.events === "failed"
            ? (status.problem ?? "Slack's live messages aren't working.")
            : "Add an app-level token so Slack messages can start routines: in the app's Basic Information › App-Level Tokens, Generate Token and Scopes with connections:write."}
          control={eventsPill(status)}
          wide={status.events === "off" || status.events === "failed"}
        >
          {(status.events === "off" || status.events === "failed") && (
            <div className="flex items-center gap-2">
              <TextField
                type="password"
                autoComplete="off"
                placeholder="xapp-…"
                aria-label="App-level token"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                wrapperClassName="flex-1"
              />
              <PillButton
                variant="primary"
                size="md"
                disabled={appToken.trim() === ""}
                loading={connect.pending}
                onClick={() => void connect.run({ appToken: appToken.trim() }).then((r) => r.ok && setAppToken(""))}
              >
                Turn on
              </PillButton>
            </div>
          )}
          {connect.error && <p className="text-sm text-danger-fg">{connect.error}</p>}
        </SettingsRow>
      </SettingsCard>
      <ConfirmDialog
        open={confirming}
        title="Disconnect Slack?"
        body="Bots can no longer read Slack, Slack routines stop, and drafts can't be sent. OpenBot forgets the tokens; to remove the app from Slack too, uninstall it there."
        confirmLabel="Disconnect"
        danger
        pending={disconnect.pending}
        error={disconnect.error}
        onConfirm={() => void disconnect.run(undefined as never).then((r) => r.ok && setConfirming(false))}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
