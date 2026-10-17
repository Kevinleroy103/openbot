// The right details pane (grok-bot-ui.md §4.7, grok-bot-ui-activity.md F.9 / F.10.1-B / F.10.4).
// Bots: 64 px avatar (avatar editor), name, label, Details | Tasks | Library | Computer (Tasks: the
// bot's background work, D5.7). Groups: members + lead.
// The shell owns the 320 px column, border and resize handle; this fills it (height 100 %, own scroll).
// Phone: a full-screen page pushed over the chat, with a back button; tablet: a sheet over the chat.
import { useAtomValue } from "@effect/atom-react"
import { activityAtom, botAtom, conversationSummaryAtom } from "@openbot/client"
import type { Bot, BotActivity, BotId, ConversationSummary } from "@openbot/contracts"
import { IconButton, SegmentedTabs, botTintStyle, cn } from "@openbot/ui"
import { ChevronLeft, X } from "lucide-react"
import { type ReactNode, useEffect } from "react"
import { useLayoutMode } from "../app/layout.ts"
import { type DetailsPaneProps, type DetailsTab, useDetailsPane } from "../contracts.ts"
import { BotHeader } from "./BotHeader.tsx"
import { BrainSection } from "./BrainSection.tsx"
import { ComputerTab } from "./ComputerTab.tsx"
import { GroupDetails } from "./GroupDetails.tsx"
import { InstructionsSection } from "./InstructionsSection.tsx"
import { EmptyNote, LoadingLine, useRosterValue } from "./kit.tsx"
import { LibraryTab } from "./LibraryTab.tsx"
import { TasksTab } from "./TasksTab.tsx"
import { MemorySection } from "./MemorySection.tsx"
import { RoutinesSection } from "./RoutinesSection.tsx"
import { DangerSection, NotificationsSection, SessionSection } from "./SessionSection.tsx"
import { AsyncResult } from "effect/reactivity"

export function DetailsPane({ botId, conversationId, tab: tabProp, onClose }: DetailsPaneProps): ReactNode {
  const pane = useDetailsPane()
  const summary = useRosterValue<ConversationSummary | undefined>(conversationSummaryAtom(conversationId ?? ("" as never)), undefined)
  const isGroup = summary?.kind === "group"
  const targetBotId: BotId | undefined = botId ?? (summary && summary.kind !== "group" ? summary.botIds[0] : undefined)
  const mode = useLayoutMode()

  // a tab passed by the shell wins once, then the shared pane state drives it
  useEffect(() => {
    if (tabProp && tabProp !== pane.tab) pane.setTab(tabProp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabProp])

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-chrome" aria-label="Details" data-testid="details-pane">
      <div className={cn("flex shrink-0 items-center px-3", mode === "phone" ? "justify-start" : "justify-end", mode === "desktop" ? "h-[60px]" : "h-[calc(60px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]")}>
        {mode === "phone" ? (
          <IconButton icon={ChevronLeft} label="Back" size={44} variant="elevated" onClick={onClose} data-testid="close-details" />
        ) : (
          <IconButton icon={X} label="Close details" variant="elevated" onClick={onClose} data-testid="close-details" />
        )}
      </div>
      {isGroup && conversationId && !botId ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 scrollbar-thin">
          <GroupDetails conversationId={conversationId} />
        </div>
      ) : targetBotId ? (
        <BotDetails botId={targetBotId} tab={pane.tab} setTab={pane.setTab} onClose={onClose} />
      ) : (
        <EmptyNote className="pt-16">Pick a Bot or a chat to see its details.</EmptyNote>
      )}
    </aside>
  )
}

function BotDetails({ botId, tab, setTab, onClose }: { readonly botId: BotId; readonly tab: DetailsTab; readonly setTab: (t: DetailsTab) => void; readonly onClose: () => void }): ReactNode {
  const result = useAtomValue(botAtom(botId))
  const activity = useRosterValue<BotActivity | undefined>(activityAtom(botId), undefined)
  const bot: Bot | undefined = AsyncResult.isSuccess(result) ? result.value : undefined
  if (!bot) {
    return AsyncResult.isSuccess(result) ? <EmptyNote className="pt-16">This Bot no longer exists.</EmptyNote> : <LoadingLine className="pt-16" />
  }
  const working = activity !== undefined && (activity.state === "thinking" || activity.state === "working")
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={botTintStyle(bot.avatar.color)}>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10 scrollbar-thin">
        <BotHeader bot={bot} working={working} />
        <div className="sticky top-0 z-10 flex justify-center bg-chrome pt-4 pb-3">
          <SegmentedTabs<DetailsTab>
            label="Details sections"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "details", label: "Details" },
              { value: "tasks", label: "Tasks" },
              { value: "library", label: "Library" },
              { value: "computer", label: "Computer" },
            ]}
          />
        </div>
        <div className="flex flex-col gap-6 px-4 pt-3" data-testid={`details-tab-${tab}`}>
          {tab === "details" && (
            <>
              <BrainSection bot={bot} />
              <InstructionsSection bot={bot} />
              <RoutinesSection bot={bot} />
              <MemorySection bot={bot} />
              <NotificationsSection bot={bot} />
              <SessionSection bot={bot} />
              <DangerSection bot={bot} onDeleted={onClose} />
            </>
          )}
          {tab === "tasks" && <TasksTab bot={bot} />}
          {tab === "library" && <LibraryTab bot={bot} />}
          {tab === "computer" && <ComputerTab bot={bot} />}
        </div>
      </div>
    </div>
  )
}
