// What the phone-push apps' pages share (Hark, ntfy): loading and errors, and the Connected card
// (what to send, not while at the computer, a test, Disconnect).
import type { HarkStatus, NtfyStatus } from "@openbot/contracts"
import { PillButton, Select, Switch } from "@openbot/ui"
import { type ComponentType, type ReactNode, useState } from "react"
import { ConfirmDialog, ErrorLine, formatWhen, LoadingLine, type QueryState, useCommand } from "../details/kit.tsx"
import { GroupLabel, RowDivider, SettingsCard, SettingsRow } from "../settings/layout.tsx"

export function PushPage<S extends HarkStatus | NtfyStatus>({
  name,
  status,
  Connect,
  Connected,
}: {
  readonly name: string
  readonly status: QueryState<S>
  readonly Connect: ComponentType
  readonly Connected: ComponentType<{ readonly status: S }>
}): ReactNode {
  if (status.loading) return <LoadingLine />
  if (status.error && !status.value) {
    return (
      <ErrorLine onRetry={status.refresh}>
        Couldn't check {name}: {status.error}
      </ErrorLine>
    )
  }
  if (status.value?.connected) return <Connected status={status.value} />
  return <Connect />
}

const SENDS: ReadonlyArray<{ readonly value: HarkStatus["sends"]; readonly label: string }> = [
  { value: "all", label: "Everything" },
  { value: "needs-you", label: "When a Bot needs you" },
]

const lastSent = (status: HarkStatus | NtfyStatus) => {
  if (status.problem !== undefined) return status.problem
  if (status.lastSentAt === undefined) return "Nothing sent yet."
  return `Last notification sent ${formatWhen(status.lastSentAt)}.`
}

export function PushConnected({
  app,
  name,
  device,
  status,
  what,
  leftBehind,
  children,
}: {
  readonly app: "hark" | "ntfy"
  readonly name: string
  /** "iPhone", "phone". */
  readonly device: string
  readonly status: HarkStatus | NtfyStatus
  /** What Disconnect forgets: "webhook", "topic". */
  readonly what: string
  /** What stays in the app after Disconnect. */
  readonly leftBehind: string
  /** Rows above the shared ones. */
  readonly children?: ReactNode
}): ReactNode {
  const setSends = useCommand(`${app}.setSends`)
  const setQuiet = useCommand(`${app}.setQuietAtComputer`)
  const test = useCommand(`${app}.test`)
  const disconnect = useCommand(`${app}.disconnect`)
  const [confirming, setConfirming] = useState(false)
  const quiet = status.quietAtComputer !== false
  return (
    <>
      <GroupLabel>Connected</GroupLabel>
      <SettingsCard testId={`${app}-connected`}>
        {children}
        <SettingsRow
          title={`Send to your ${device}`}
          description={
            status.sends === "all"
              ? "Every notification: a Bot finished, wrote, needs you, a routine ran, something failed."
              : "Only when a Bot is waiting for you (a question, an approval, your screen), a sign-in, or something failed."
          }
          control={
            <Select<HarkStatus["sends"]>
              label="Send"
              value={status.sends}
              onValueChange={(sends) => void setSends.run({ sends })}
              options={SENDS}
            />
          }
        >
          {setSends.error && <p className="text-sm text-danger-fg">{setSends.error}</p>}
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Not while I'm at my computer"
          description={
            quiet && status.atComputer === true
              ? "Paused now: you're using a computer with the OpenBot desktop app, so notifications show there."
              : `While you're using a computer with the OpenBot desktop app, notifications show there and not on your ${device} too. They come back a couple of minutes after you step away.`
          }
          control={
            <Switch
              checked={quiet}
              onCheckedChange={(on) => void setQuiet.run({ quiet: on })}
              label="Not while I'm at my computer"
            />
          }
        >
          {setQuiet.error && <p className="text-sm text-danger-fg">{setQuiet.error}</p>}
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Test"
          description={lastSent(status)}
          control={
            <PillButton
              variant="secondary"
              size="md"
              loading={test.pending}
              onClick={() => void test.run(undefined as never)}
            >
              Send a test
            </PillButton>
          }
        >
          {test.error && <p className="text-sm text-danger-fg">{test.error}</p>}
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Disconnect"
          description={`OpenBot stops sending to ${name} and forgets the ${what}.`}
          control={
            <PillButton variant="secondary" size="md" onClick={() => setConfirming(true)}>
              Disconnect
            </PillButton>
          }
        />
      </SettingsCard>
      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${name}?`}
        body={`Your ${device} stops getting OpenBot's notifications. ${leftBehind}`}
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
