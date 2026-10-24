// First run (grok-bot-ui.md §4.14, adapted for a self-hosted brain): a centered column on bg-chrome,
// a 240 px primary "Next" with a gray "Back" under it.
//   1. Welcome: the logo avatar + wordmark, "Your team of always-on Bots that you can give real work to".
//   2. Brains: which harnesses (and which of their accounts, e.g. several Claude logins) are installed /
//      signed in on this server (harnesses.status), with the CLI command to fix each one. The offline
//      Demo harness always works.
//   3. Create your first Bot: the New Bot form → onDone (the shell then selects its DM).
import { harnessStatusAtom, sessionInfoAtom } from "@openbot/client"
import type { BotId, HarnessStatus } from "@openbot/contracts"
import { Avatar, Icon, PillButton, cn } from "@openbot/ui"
import { ArrowRight, RefreshCw } from "lucide-react"
import { type ReactNode, useState } from "react"
import type { OnboardingProps } from "../contracts.ts"
import { NewBotFormBody } from "../dialogs/NewBotForm.tsx"
import {
  CommandBlock,
  ErrorLine,
  HarnessStatusPill,
  HarnessTile,
  INSTALL_HINTS,
  LoadingLine,
  accountChoiceLabel,
  groupStatuses,
  harnessName,
  harnessReady,
  signInCommand,
  statusProfileId,
  useQuery,
} from "../details/kit.tsx"

type Step = "welcome" | "brains" | "create"
const STEPS: ReadonlyArray<Step> = ["welcome", "brains", "create"]

export function Onboarding({ onDone }: OnboardingProps): ReactNode {
  const [step, setStep] = useState<Step>("welcome")
  const info = useQuery(sessionInfoAtom)
  const index = STEPS.indexOf(step)
  const back = () => setStep(STEPS[Math.max(0, index - 1)]!)
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]!)

  return (
    <div
      className="relative flex h-full min-h-screen w-full flex-col items-center overflow-y-auto bg-chrome pt-[env(safe-area-inset-top)] text-fg scrollbar-thin"
      data-testid="onboarding"
      data-step={step}
    >
      <div className="flex h-14 w-full shrink-0 items-center justify-center gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={cn(
              "h-1.5 rounded-full transition-all duration-300",
              i === index ? "w-5 bg-fg-secondary" : "w-1.5 bg-fg-quaternary",
            )}
          />
        ))}
      </div>
      <div className="flex w-full flex-1 flex-col items-center justify-center px-6 pb-16">
        {step === "welcome" && (
          <div key="welcome" className="flex animate-blur-in flex-col items-center text-center">
            <div className="flex items-center gap-5">
              <Avatar shape="blob" color="black" size={60} idle label="OpenBot" />
              <span className="text-[64px] leading-none font-light tracking-[-0.02em] text-fg">OpenBot</span>
            </div>
            <p className="mt-12 max-w-[420px] text-2xl text-fg">
              Your team of always-on Bots that you can give real work to
            </p>
            <p className="mt-3 max-w-[440px] text-base text-fg-secondary">
              Bots chat with you and each other, run routines and work on your computers, using the AI subscriptions you
              already have.
            </p>
            <PillButton
              variant="primary"
              size="lg"
              trailingIcon={ArrowRight}
              className="mt-10 h-10 min-w-[180px] px-6 text-lg"
              onClick={next}
              data-testid="onboarding-start"
            >
              Get started
            </PillButton>
          </div>
        )}
        {step === "brains" && <BrainsStep onBack={back} onNext={next} />}
        {step === "create" && (
          <div key="create" className="flex w-full max-w-[560px] animate-blur-in flex-col items-center">
            <h1 className="text-center text-2xl font-medium text-fg">Create your first Bot</h1>
            <p className="mt-2 max-w-[440px] text-center text-base text-fg-secondary">
              Give it a name and a job. You can change everything later, and add more Bots any time.
            </p>
            <div className="mt-8 flex w-full flex-col overflow-hidden rounded-3xl bg-elevated pt-4 hairline border-line-secondary shadow-card">
              <NewBotFormBody
                onCreated={(id: BotId) => onDone(id)}
                onCancel={back}
                hideCancel
                showSetupLinks={false}
                submitLabel="Create Bot"
              />
            </div>
            <PillButton variant="secondary" size="lg" className="mt-4 w-[240px]" onClick={back}>
              Back
            </PillButton>
          </div>
        )}
      </div>
      <p className="px-4 pb-[max(24px,env(safe-area-inset-bottom))] text-center text-xs text-fg-tertiary">
        Self-hosted and open source. Your Bots, files and logins stay on this server.
        {info.value?.dataDir ? (
          <>
            {" "}
            Data folder: <span className="font-mono">{info.value.dataDir}</span>
          </>
        ) : null}
      </p>
      {step !== "welcome" && (
        <button
          type="button"
          onClick={() => onDone()}
          className="absolute top-[calc(16px+env(safe-area-inset-top))] right-5 text-sm text-fg-tertiary transition-colors hover:text-fg-secondary"
        >
          Skip
        </button>
      )}
    </div>
  )
}

function BrainsStep({ onBack, onNext }: { readonly onBack: () => void; readonly onNext: () => void }): ReactNode {
  const statuses = useQuery(harnessStatusAtom)
  const order = ["claude", "codex", "opencode", "fake"]
  const list = [...(statuses.value ?? [])].sort(
    (a, b) =>
      (order.includes(a.kind) ? order.indexOf(a.kind) : 9) - (order.includes(b.kind) ? order.indexOf(b.kind) : 9),
  )
  const readyCount = list.filter((s) => s.kind !== "fake" && harnessReady(s)).length
  return (
    <div key="brains" className="flex w-full max-w-[560px] animate-blur-in flex-col items-center">
      <h1 className="text-center text-2xl font-medium text-fg">Pick your Bots' brains</h1>
      <p className="mt-2 max-w-[460px] text-center text-base text-fg-secondary">
        Each Bot thinks with an AI harness installed on this server, signed in with your own account. Bots can use
        different ones.
      </p>
      <div
        className="mt-8 flex w-full flex-col rounded-3xl bg-elevated py-1 hairline border-line-secondary shadow-card"
        data-testid="onboarding-harnesses"
      >
        {statuses.loading ? (
          <LoadingLine className="py-8">Looking for Claude, Codex and OpenCode…</LoadingLine>
        ) : statuses.error && !statuses.value ? (
          <ErrorLine onRetry={statuses.refresh}>{statuses.error}</ErrorLine>
        ) : (
          groupStatuses(list).map((g, i) =>
            g.accounts.length === 1 ? (
              <HarnessLine key={g.kind} status={g.accounts[0]!} divided={i > 0} />
            ) : (
              <HarnessAccounts key={g.kind} kind={g.kind} accounts={g.accounts} divided={i > 0} />
            ),
          )
        )}
      </div>
      <div className="mt-3 flex w-full items-center gap-2 px-1 text-sm text-fg-secondary">
        <span className="flex-1">
          {statuses.loading
            ? " "
            : readyCount > 0
              ? `${readyCount} ready. You can set up the rest later in Settings › Harnesses.`
              : "None signed in yet. The Demo harness works offline while you set one up."}
        </span>
        <button
          type="button"
          onClick={statuses.refresh}
          className="inline-flex items-center gap-1 text-fg-secondary hover:text-fg"
        >
          <Icon icon={RefreshCw} size="xs" className={cn(statuses.waiting && !statuses.loading && "animate-spin")} />
          Check again
        </button>
      </div>
      <PillButton
        variant="primary"
        size="lg"
        className="mt-10 h-10 w-[240px] text-lg"
        onClick={onNext}
        data-testid="onboarding-next"
      >
        Next
      </PillButton>
      <PillButton variant="secondary" size="lg" className="mt-3 w-[240px]" onClick={onBack}>
        Back
      </PillButton>
    </div>
  )
}

/** A harness with several accounts (e.g. three Claude logins): one header, one line per account. */
function HarnessAccounts({
  kind,
  accounts,
  divided,
}: {
  readonly kind: string
  readonly accounts: ReadonlyArray<HarnessStatus>
  readonly divided: boolean
}): ReactNode {
  const version = accounts.find((s) => s.version)?.version
  const readyCount = accounts.filter(harnessReady).length
  return (
    <div className={cn("flex flex-col gap-2 px-4 py-3", divided && "border-t-[0.5px] border-line-tertiary")}>
      <div className="flex items-center gap-3">
        <HarnessTile kind={kind} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-medium text-fg">{harnessName(kind, accounts[0])}</span>
          <span className="truncate text-sm text-fg-secondary">
            {accounts.length} accounts · {readyCount} signed in{version ? ` · v${version}` : ""}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 ps-11">
        {accounts.map((s) => {
          const hint = !s.installed ? INSTALL_HINTS[s.kind] : !harnessReady(s) ? signInCommand(s) : undefined
          return (
            <div key={statusProfileId(s)} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {harnessReady(s) ? accountChoiceLabel(s) : (s.configDir ?? accountChoiceLabel(s))}
                </span>
                <HarnessStatusPill status={s} />
              </div>
              {hint && <CommandBlock command={hint} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HarnessLine({ status, divided }: { readonly status: HarnessStatus; readonly divided: boolean }): ReactNode {
  const ready = harnessReady(status)
  const hint =
    status.kind === "fake"
      ? undefined
      : !status.installed
        ? INSTALL_HINTS[status.kind]
        : !ready
          ? signInCommand(status)
          : undefined
  return (
    <div className={cn("flex flex-col gap-2 px-4 py-3", divided && "border-t-[0.5px] border-line-tertiary")}>
      <div className="flex items-center gap-3">
        <HarnessTile kind={status.kind} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-medium text-fg">{harnessName(status.kind, status)}</span>
          <span className="truncate text-sm text-fg-secondary">
            {status.kind === "fake"
              ? "Scripted, offline. Good for a first look."
              : ready
                ? status.account || status.auth.label
                  ? accountChoiceLabel(status)
                  : `Signed in${status.version ? ` · v${status.version}` : ""}`
                : !status.installed
                  ? "Not installed"
                  : status.auth.state === "signed-out"
                    ? "Installed, not signed in"
                    : "Installed · sign-in not confirmed"}
          </span>
        </div>
        <HarnessStatusPill status={status} />
      </div>
      {hint && (
        <div className="ps-11">
          <CommandBlock command={hint} />
        </div>
      )}
    </div>
  )
}
