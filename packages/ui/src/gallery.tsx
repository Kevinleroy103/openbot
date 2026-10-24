/**
 * @openbot/ui story page. Built with Bun's HTML bundler (scripts/build-gallery.ts) and screenshotted in
 * Chromium (scripts/screenshot.ts, test/gallery.test.ts). Query params: `theme=dark|light`,
 * `scene=all|chat|avatars|overlays|settings`.
 *
 * The sidebar/composer/details layouts here are compositions for visual verification only; the real
 * screens live in apps/web.
 */
import {
  ArrowUp,
  ChartNoAxesColumn,
  Clock,
  CloudDownload,
  Copy,
  Ellipsis,
  EyeOff,
  FolderInput,
  Globe,
  Mic,
  Monitor,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react"
import { type ReactNode, StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { Avatar, AvatarStack } from "./avatar/Avatar.tsx"
import { AvatarPicker } from "./avatar/AvatarPicker.tsx"
import {
  type AvatarColor,
  AvatarColors,
  AvatarExpressions,
  type AvatarShape,
  AvatarShapes,
  botTintStyle,
  defaultBotAvatar,
} from "./avatar/palette.ts"
import { cn } from "./cn.ts"
import { Icon } from "./Icon.tsx"
import { HeaderPill, IconButton, PillButton, Spinner } from "./primitives/buttons.tsx"
import {
  Card,
  CardActions,
  CardBody,
  CardHeader,
  CardLink,
  KeyBadge,
  OptionRow,
  Sheet,
  SheetField,
  StatusPill,
} from "./primitives/card.tsx"
import {
  ActivityRow,
  Bubble,
  BubbleGroup,
  CountBadge,
  EventChip,
  EventLine,
  LabelChip,
  NewDivider,
  ShimmerText,
  Timestamp,
  TypingDots,
  UnreadDot,
  groupPosition,
} from "./primitives/chat.tsx"
import { SegmentedTabs, Switch, TextArea, TextField } from "./primitives/forms.tsx"
import {
  CommandPalette,
  CommandPaletteBody,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  Menu,
  MenuItem,
  MenuLabel,
  MenuPanel,
  MenuSeparator,
  Select,
  Toast,
  Toaster,
  Tooltip,
  TooltipSurface,
  type PaletteItem,
} from "./primitives/overlay.tsx"

const params = new URLSearchParams(location.search)
const theme = params.get("theme") === "light" ? "light" : "dark"
const scene = params.get("scene") ?? "all"
document.documentElement.dataset.theme = theme

// ------------------------------------------------------------------------------------- demo data

interface DemoBot {
  readonly id: string
  readonly name: string
  readonly shape: AvatarShape
  readonly color: AvatarColor
  readonly label?: string
  readonly preview: string
  readonly status?: "working" | "attention" | "unread"
}

const bots: ReadonlyArray<DemoBot> = [
  {
    id: "b1",
    name: "Chief of Staff",
    shape: "blob",
    color: "cyan",
    label: "Ops",
    preview: "Booked: marina house, deposit paid.",
  },
  {
    id: "b2",
    name: "Sales Outbound",
    shape: "cloud",
    color: "orange",
    label: "Sales",
    preview: "Done.",
    status: "unread",
  },
  { id: "b3", name: "Inbox Manager", shape: "teardrop", color: "violet", preview: "Typing…", status: "working" },
  {
    id: "b4",
    name: "Research Scout",
    shape: "hex",
    color: "blue",
    label: "Research",
    preview: "Three competitor launches this week",
    status: "unread",
  },
  {
    id: "b5",
    name: "Expense Clerk",
    shape: "square",
    color: "red",
    preview: "Report filed. 9 receipts, nothing flagged",
  },
  {
    id: "b6",
    name: "Release Engineer",
    shape: "wedge",
    color: "green",
    label: "Infra",
    preview: "Build 2.0.21 is live on TestFlight.",
  },
  {
    id: "b7",
    name: "Data Analyst",
    shape: "clover",
    color: "yellow",
    label: "Data",
    preview: "Waiting on your approval",
    status: "attention",
  },
  { id: "b8", name: "Travel Desk", shape: "sparkle", color: "magenta", preview: "Flights held until Friday noon." },
]
const bot = (id: string) => bots.find((b) => b.id === id)!

// ------------------------------------------------------------------------------------- sidebar

function PinnedTile({ b, current }: { b: DemoBot; current?: boolean }) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      className="flex min-w-0 flex-col items-center gap-1 rounded-xl px-1.5 pt-1.5 pb-1.5 transition-colors hover:bg-hover aria-[current=page]:bg-active"
    >
      <Avatar
        shape={b.shape}
        color={b.color}
        size={56}
        working={b.status === "working"}
        {...(b.status === "unread" ? { status: "unread" } : {})}
      />
      <span className="max-w-full truncate text-xs text-fg">{b.name}</span>
      {b.label ? <LabelChip>{b.label}</LabelChip> : <span className="h-[18px]" />}
    </button>
  )
}

function BotRow({ b, current }: { b: DemoBot; current?: boolean }) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      className="relative flex w-full min-w-0 items-center gap-2.5 rounded-xl p-2 text-start transition-colors hover:bg-hover aria-[current=page]:bg-active"
    >
      <Avatar
        shape={b.shape}
        color={b.color}
        size={36}
        working={b.status === "working"}
        expression={b.status === "working" ? "inspecting" : "neutral"}
        {...(b.status === "attention" ? { status: "attention" as const } : {})}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-base font-medium text-fg">{b.name}</span>
          {b.label && <LabelChip>{b.label}</LabelChip>}
        </span>
        <span className={cn("truncate text-sm", b.status === "attention" ? "text-warn-fg" : "text-fg-secondary")}>
          {b.preview}
        </span>
      </span>
      {b.status === "unread" && <UnreadDot className="me-1" />}
    </button>
  )
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex h-[30px] items-center rounded-md px-2 pt-2 pb-1.5 text-xs text-fg-secondary">
      <span className="flex-1 truncate">{title}</span>
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col bg-sidebar">
      <div className="flex h-[60px] items-center justify-end gap-2 px-3">
        <IconButton icon={Search} label="Search" variant="elevated" />
        <IconButton icon={Plus} label="New chat" variant="elevated" />
      </div>
      <div className="flex-1 overflow-y-auto px-2 scrollbar-thin">
        <div className="grid grid-cols-3 gap-x-1 gap-y-3 px-1 pb-3">
          <PinnedTile b={bot("b1")} current />
          <PinnedTile b={bot("b2")} />
          <PinnedTile b={bot("b3")} />
        </div>
        <SectionHeader title="Revenue" />
        <BotRow b={bot("b4")} />
        <BotRow b={bot("b5")} />
        <div className="h-2" />
        <SectionHeader title="Engineering" />
        <BotRow b={bot("b6")} />
        <BotRow b={bot("b7")} />
        <div className="h-2" />
        <SectionHeader title="Unassigned" />
        <BotRow b={bot("b8")} />
        <div className="h-2" />
        <SectionHeader title="Hidden Bots" count={1} />
      </div>
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-elevated text-sm text-fg-secondary hairline border-line-tertiary shadow-control">
          A
        </span>
        <PillButton
          variant="ghost"
          size="lg"
          leadingIcon={Monitor}
          className="flex-1 bg-elevated hairline border-line-tertiary shadow-control hover:bg-elevated-hover"
        >
          Computers
        </PillButton>
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------------------------ composer

function Composer({ name, value = "" }: { name: string; value?: string }) {
  const [text, setText] = useState(value)
  return (
    <div className="flex min-h-11 w-full items-center gap-2 rounded-composer bg-elevated p-2 hairline border-line-secondary shadow-composer transition-[border-color] hover:border-line focus-within:border-line">
      <IconButton icon={Plus} label="Composer actions" size={28} variant="secondary" />
      <textarea
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Message ${name}`}
        className="min-w-0 flex-1 resize-none bg-transparent text-lg leading-5 text-fg outline-none placeholder:text-fg-quaternary focus-visible:outline-none"
      />
      {text ? (
        <>
          <IconButton icon={Mic} label="Start voice input" size={28} variant="secondary" />
          <IconButton icon={ArrowUp} label="Send" size={28} variant="accent" />
        </>
      ) : (
        <IconButton icon={Mic} label="Start voice input" size={28} variant="accent" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------- chat

function QuestionCard() {
  return (
    <Card>
      <CardHeader title="Which venue should I hold?" onClose={() => {}} />
      <Sheet>
        <OptionRow optionKey="A">Marina House</OptionRow>
        <OptionRow optionKey="B">Hillside Lodge</OptionRow>
        <OptionRow optionKey="C">Hold all three</OptionRow>
      </Sheet>
      <TextField placeholder="Type your own answer" aria-label="Type your own answer" className="h-9 text-lg" />
    </Card>
  )
}

function ApprovalCard({ state = "pending" }: { state?: "pending" | "always" | "denied" | "expired" | "approved" }) {
  const pill =
    state === "pending" ? (
      <StatusPill tone="warn">Needs approval</StatusPill>
    ) : state === "always" ? (
      <StatusPill tone="success" dot>
        Always allowed
      </StatusPill>
    ) : state === "denied" ? (
      <StatusPill tone="danger" dot>
        Denied
      </StatusPill>
    ) : state === "expired" ? (
      <StatusPill dot>Expired</StatusPill>
    ) : (
      <StatusPill>Allowed once</StatusPill>
    )
  return (
    <Card>
      <CardHeader title="Allow Chief of Staff to run a command?" status={pill} />
      <CardBody>Delete 14 folders under ~/builds.</CardBody>
      <CardLink>View the full request</CardLink>
      {state === "pending" && (
        <CardActions>
          <PillButton variant="primary" size="card">
            Allow once
          </PillButton>
          <PillButton variant="secondary" size="card">
            Always allow
          </PillButton>
          <PillButton variant="tertiary" size="card" className="ms-auto">
            Deny
          </PillButton>
        </CardActions>
      )}
      {state === "always" && (
        <Sheet>
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <Icon icon={ShieldCheck} size="lg" className="text-success-fg" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg">Added to your Allow rules</div>
              <div className="truncate text-sm text-fg-secondary">“Delete build folders under ~/builds”</div>
            </div>
            <PillButton size="card">Edit rule</PillButton>
          </div>
        </Sheet>
      )}
      {state === "denied" && <p className="text-sm text-fg-secondary">Chief of Staff won't do this</p>}
      {state === "expired" && (
        <div>
          <PillButton size="xs">Always allow next time</PillButton>
        </div>
      )}
    </Card>
  )
}

function Transcript({ working = true }: { working?: boolean }) {
  const chief = bot("b1")
  const scout = bot("b4")
  const botRun = [
    "Two things: the deck review at 2pm, and a yes/no on the offsite venue. Everything else is handled.",
    "Deck → numbers checked against the finance sheet · 2 stale slides flagged",
  ]
  return (
    <div className="flex flex-col">
      <BubbleGroup side="user">
        <Bubble side="user">Morning. What needs me today?</Bubble>
      </BubbleGroup>
      <NewDivider className="my-2" />
      <BubbleGroup side="bot">
        {botRun.map((t, i) => (
          <Bubble key={i} side="bot" position={groupPosition(i, botRun.length)}>
            {t}
          </Bubble>
        ))}
      </BubbleGroup>
      <EventLine>
        2 messages with
        <EventChip leading={<Avatar shape={scout.shape} color={scout.color} size={16} />}>{scout.name}</EventChip>
      </EventLine>
      <div className="mt-1 flex flex-col items-start">
        <QuestionCard />
      </div>
      <Timestamp className="mt-3">Today 4:32 AM</Timestamp>
      <BubbleGroup side="user" className="mt-2">
        <Bubble side="user" position="first">
          Marina House. Book it,
        </Bubble>
        <Bubble side="user" position="last">
          and send me this summary every weekday morning.
        </Bubble>
      </BubbleGroup>
      <BubbleGroup side="bot" className="mt-3">
        <Bubble side="bot">Booked: marina house, deposit paid. Invites updated for all 40.</Bubble>
      </BubbleGroup>
      <EventLine className="mt-1">
        Created routine
        <EventChip leading={<Icon icon={Clock} size="sm" />}>Morning briefing</EventChip>
      </EventLine>
      <div className="mt-1 flex flex-col items-start gap-1">
        <ApprovalCard />
      </div>
      {working && (
        <ActivityRow
          className="mt-1"
          avatar={
            <Avatar
              shape={chief.shape}
              color={chief.color}
              size={28}
              working
              expression="inspecting"
              eyeColor="var(--ob-chrome)"
            />
          }
          label="Running a few commands…"
        />
      )}
    </div>
  )
}

function DetailsPane({ editor = false }: { editor?: boolean }) {
  const chief = bot("b1")
  const [tab, setTab] = useState<"details" | "library" | "computer">("details")
  const [avatar, setAvatar] = useState<{ shape: AvatarShape; color: AvatarColor }>({
    shape: chief.shape,
    color: chief.color,
  })
  const [edTab, setEdTab] = useState<"bot" | "generate" | "upload">("bot")
  return (
    <aside className="relative flex w-[320px] shrink-0 flex-col border-s-[0.5px] border-line-tertiary bg-chrome">
      <div className="flex h-[60px] items-center justify-end px-3">
        <IconButton icon={X} label="Close details" variant="elevated" />
      </div>
      <div className="flex flex-col items-center gap-1 px-4">
        <Avatar shape={avatar.shape} color={avatar.color} size={64} />
        <div className="mt-2 text-xl font-medium text-fg">{chief.name}</div>
        <div className="text-xs text-fg-secondary">{chief.label}</div>
        <SegmentedTabs
          className="mt-4"
          label="Details sections"
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "details", label: "Details" },
            { value: "library", label: "Library" },
            { value: "computer", label: "Computer" },
          ]}
        />
      </div>
      <div className="flex flex-col gap-3 px-4 pt-6">
        <div className="text-xs text-fg-secondary">Brain</div>
        <Sheet>
          <SheetField label="Harness">Claude</SheetField>
          <SheetField label="Model">opus</SheetField>
          <SheetField label="Node">This computer</SheetField>
        </Sheet>
        <p className="px-4 pt-4 text-center text-sm text-fg-secondary">
          Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.
        </p>
      </div>
      {editor && (
        <div className="absolute top-[150px] right-3 left-3 z-10 flex flex-col gap-4 rounded-2xl bg-elevated p-2 pb-5 hairline border-line-secondary shadow-popover">
          <SegmentedTabs
            label="Avatar source"
            value={edTab}
            onValueChange={setEdTab}
            tabs={[
              { value: "bot", label: "Bot" },
              { value: "generate", label: "Generate" },
              { value: "upload", label: "Upload" },
            ]}
            trailing={<button className="px-2 text-sm text-fg-secondary hover:text-fg">Reset</button>}
          />
          <div className="h-0 border-t-[0.5px] border-line-secondary" />
          <AvatarPicker shape={avatar.shape} color={avatar.color} onChange={setAvatar} className="px-2" />
        </div>
      )}
    </aside>
  )
}

function ChatScene({
  details = false,
  editor = false,
  children,
}: {
  details?: boolean
  editor?: boolean
  children?: ReactNode
}) {
  const chief = bot("b1")
  return (
    <div className="flex h-screen bg-chrome">
      <Sidebar />
      <main className="relative flex min-w-[424px] flex-1 flex-col bg-pane" style={botTintStyle(chief.color)}>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2.5">
          <HeaderPill
            className="pointer-events-auto"
            avatar={<Avatar shape={chief.shape} color={chief.color} size={24} />}
          >
            {chief.name}
          </HeaderPill>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-[960px] px-4 pt-14 pb-4">
            <Transcript />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[960px] px-4 pb-4">
          <Composer name={chief.name} />
        </div>
        {children}
      </main>
      {details && <DetailsPane editor={editor} />}
    </div>
  )
}

// -------------------------------------------------------------------------------------- overlays

const paletteItems: ReadonlyArray<PaletteItem> = [
  ...bots.map((b) => ({
    id: b.id,
    label: b.name,
    group: "Bots",
    leading: <Avatar shape={b.shape} color={b.color} size={22} />,
    ...(b.label ? { chip: <LabelChip>{b.label}</LabelChip> } : {}),
    ...(b.status === "unread" ? { trailing: <UnreadDot /> } : {}),
  })),
  {
    id: "s1",
    label: "Settings › Computers",
    group: "Settings",
    leading: <Icon icon={Monitor} size="xl" className="text-icon-secondary" />,
  },
  {
    id: "a1",
    label: "New chat",
    group: "Actions",
    leading: <Icon icon={Plus} size="xl" className="text-icon-secondary" />,
    trailing: <KeyBadge>⌘N</KeyBadge>,
  },
]

function OverlaysScene() {
  return (
    <ChatScene>
      <CommandPalette open onOpenChange={() => {}} items={paletteItems} />
    </ChatScene>
  )
}

function SettingsScene() {
  const [nav, setNav] = useState("general")
  const [themeValue, setThemeValue] = useState<"light" | "dark" | "system">(theme)
  const [accent, setAccent] = useState<"bot" | "black">("bot")
  const [steps, setSteps] = useState(true)
  const [messaging, setMessaging] = useState(true)
  const navItems = [
    { id: "general", label: "General", icon: Settings },
    { id: "harnesses", label: "Harnesses", icon: Pencil },
    { id: "computers", label: "Computers", icon: Monitor },
    { id: "permissions", label: "Permissions", icon: ShieldCheck },
    { id: "usage", label: "Usage", icon: ChartNoAxesColumn },
    { id: "updates", label: "Updates", icon: CloudDownload },
  ]
  const row = (title: string, desc: string | undefined, control: ReactNode) => (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-base text-fg">{title}</div>
        {desc && <div className="text-sm text-fg-secondary">{desc}</div>}
      </div>
      {control}
    </div>
  )
  return (
    <ChatScene>
      <Dialog open onOpenChange={() => {}} width={900} height={702} label="Settings" className="bg-chrome">
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-e-[0.5px] border-line-tertiary p-3 sm:w-[192px]">
            {navItems.map((n) => (
              <button
                key={n.id}
                onClick={() => setNav(n.id)}
                aria-current={nav === n.id ? "page" : undefined}
                className="flex h-8 items-center gap-2 rounded-lg px-2 text-base text-fg transition-colors hover:bg-hover aria-[current=page]:bg-active"
              >
                <Icon icon={n.icon} size="lg" className="text-icon-secondary" />
                {n.label}
              </button>
            ))}
          </nav>
          <div className="relative min-w-0 flex-1 overflow-y-auto px-10 pt-6 pb-10 scrollbar-thin">
            <IconButton icon={X} label="Close settings" size={28} className="absolute top-4 right-4" />
            <h2 className="text-xl font-medium text-fg">General</h2>
            <div className="mt-8 mb-2 text-sm text-fg-secondary">Appearance</div>
            <div className="flex flex-col rounded-3xl bg-elevated hairline border-line-tertiary">
              {row(
                "Theme",
                undefined,
                <Select
                  label="Theme"
                  value={themeValue}
                  onValueChange={setThemeValue}
                  options={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                    { value: "system", label: "Follow System" },
                  ]}
                />,
              )}
              {row(
                "Accent",
                "Tint your messages and the send button with the Bot's color.",
                <Select
                  label="Accent"
                  value={accent}
                  onValueChange={setAccent}
                  options={[
                    { value: "bot", label: "Bot color" },
                    { value: "black", label: "Black" },
                  ]}
                />,
              )}
              {row(
                "Show steps",
                "Show a collapsed “N steps” row under finished turns.",
                <Switch checked={steps} onCheckedChange={setSteps} label="Show steps" />,
              )}
            </div>
            <div className="mt-8 mb-2 text-sm text-fg-secondary">Bots</div>
            <div className="flex flex-col rounded-3xl bg-elevated hairline border-line-tertiary">
              {row(
                "Bot messaging",
                "Let Bots message each other and hand off work.",
                <Switch checked={messaging} onCheckedChange={setMessaging} label="Bot messaging" />,
              )}
              {row("Reset onboarding", "Show the first-run guide again.", <PillButton>Reset</PillButton>)}
            </div>
          </div>
        </div>
      </Dialog>
    </ChatScene>
  )
}

// ----------------------------------------------------------------------------------- story page

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium tracking-wide text-fg-tertiary uppercase">{title}</h2>
      <div className={cn("flex flex-wrap items-start gap-3", className)}>{children}</div>
    </section>
  )
}

const swatches = [
  "pane",
  "chrome",
  "sidebar",
  "elevated",
  "hover",
  "active",
  "primary",
  "secondary",
  "bubble-agent",
  "bubble-user",
  "fg",
  "fg-secondary",
  "fg-tertiary",
  "fg-quaternary",
  "line",
  "line-secondary",
  "accent",
  "danger",
  "success",
  "warn",
  "accent-soft",
  "danger-soft",
  "success-soft",
  "warn-soft",
]

function StoryPage() {
  const [tab, setTab] = useState<"details" | "library" | "computer">("details")
  const [on, setOn] = useState(true)
  const [sel, setSel] = useState("light")
  const [dialog, setDialog] = useState(false)
  const [palette, setPalette] = useState(false)
  return (
    <div className="min-h-screen bg-pane">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-10 px-8 py-10">
        <header className="flex items-center gap-3">
          <Avatar shape="blob" color="black" size={40} expression="happy" />
          <div>
            <h1 className="text-3xl font-medium text-fg">@openbot/ui</h1>
            <p className="text-sm text-fg-secondary">Tokens, primitives and avatars · {theme} theme</p>
          </div>
        </header>

        <Section title="Surfaces & roles" className="gap-2">
          {swatches.map((s) => (
            <div key={s} className="flex w-[104px] flex-col gap-1">
              <div
                className="h-12 rounded-xl hairline border-line-secondary"
                style={{ background: `var(--ob-${s})` }}
              />
              <span className="truncate text-2xs text-fg-secondary">{s}</span>
            </div>
          ))}
        </Section>

        <Section title="Type scale" className="flex-col gap-1">
          <div className="text-3xl font-medium">Heading 1 · 26/32</div>
          <div className="text-2xl font-medium">Heading 2 · 22/28</div>
          <div className="text-xl font-medium">Heading 3 · 17/24</div>
          <div className="text-lg">Chat prose · 15/22 — the quick brown fox jumps over the lazy dog</div>
          <div className="text-base">Body 1 · 14/20 — buttons, rows, composer</div>
          <div className="text-sm text-fg-secondary">Body 2 · 13/18 — previews, menus, settings</div>
          <div className="text-xs text-fg-tertiary">Label · 12/16 — timestamps, section headers</div>
          <div className="font-mono text-sm">Geist Mono · ops/offsite.md · 0123456789</div>
        </Section>

        <Section title="Pill buttons">
          <PillButton variant="primary">Primary</PillButton>
          <PillButton variant="secondary">Secondary</PillButton>
          <PillButton variant="ghost">Ghost</PillButton>
          <PillButton variant="outline">Outline</PillButton>
          <PillButton variant="accent">Accent</PillButton>
          <PillButton variant="accent-soft">Accent soft</PillButton>
          <PillButton variant="danger">Danger</PillButton>
          <PillButton variant="danger-soft" leadingIcon={Trash2}>
            Delete
          </PillButton>
          <PillButton variant="primary" size="card">
            Allow once
          </PillButton>
          <PillButton size="card" loading>
            Compacting…
          </PillButton>
          <PillButton size="xs">Always allow next time</PillButton>
          <PillButton variant="primary" disabled>
            Disabled
          </PillButton>
        </Section>

        <Section title="Icon buttons" className="items-center">
          <IconButton icon={Search} label="Search" variant="elevated" />
          <IconButton icon={Plus} label="New" variant="elevated" />
          <IconButton icon={X} label="Close" />
          <IconButton icon={Plus} label="Composer actions" size={28} variant="secondary" />
          <IconButton icon={ArrowUp} label="Send" size={28} variant="primary" />
          <IconButton icon={Mic} label="Voice" size={28} variant="accent" />
          <IconButton icon={Ellipsis} label="More" size={24} />
          <IconButton icon={Copy} label="Copy" size={20} shape="square" />
          <HeaderPill avatar={<Avatar shape="blob" color="cyan" size={24} />}>Chief of Staff</HeaderPill>
        </Section>

        <Section title="Badges & status" className="items-center">
          <StatusPill tone="warn">Needs approval</StatusPill>
          <StatusPill tone="success" dot>
            Always allowed
          </StatusPill>
          <StatusPill tone="danger" dot>
            Denied
          </StatusPill>
          <StatusPill dot>Expired</StatusPill>
          <StatusPill tone="accent" spinner>
            Running
          </StatusPill>
          <LabelChip>Research</LabelChip>
          <CountBadge count={3} />
          <UnreadDot />
          <KeyBadge>⌘K</KeyBadge>
          <KeyBadge>Tab</KeyBadge>
          <KeyBadge variant="option">A</KeyBadge>
          <Spinner />
          <TypingDots />
          <ShimmerText className="text-base">Digging around…</ShimmerText>
        </Section>

        <Section title="Bubbles (grouped corners) & transcript parts" className="block">
          <div
            className="w-full max-w-[760px] rounded-3xl bg-pane p-4 hairline border-line-tertiary"
            style={botTintStyle("orange")}
          >
            <BubbleGroup side="bot">
              {["First in a run", "Middle bubble with a little more text", "Last in the run"].map((t, i) => (
                <Bubble key={t} side="bot" position={groupPosition(i, 3)}>
                  {t}
                </Bubble>
              ))}
            </BubbleGroup>
            <Timestamp>Yesterday 11:56 AM</Timestamp>
            <BubbleGroup side="user">
              {["Clean up the old build folders.", "Keep the last three.", "Thanks!"].map((t, i) => (
                <Bubble key={t} side="user" position={groupPosition(i, 3)}>
                  {t}
                </Bubble>
              ))}
            </BubbleGroup>
            <NewDivider className="my-2" />
            <Bubble side="bot" emojiOnly>
              👍
            </Bubble>
            <EventLine>
              Updated memory for
              <EventChip leading={<Avatar shape="star" color="violet" size={16} />}>Account Manager</EventChip>
            </EventLine>
            <ActivityRow
              avatar={<Avatar shape="cloud" color="orange" size={28} working eyeColor="var(--ob-pane)" />}
              label="Typing…"
            />
          </div>
        </Section>

        <Section title="Cards">
          <QuestionCard />
          <ApprovalCard />
          <ApprovalCard state="always" />
          <ApprovalCard state="denied" />
          <ApprovalCard state="expired" />
        </Section>

        <Section title="Forms" className="items-end gap-6">
          <TextField label="Name" defaultValue="Chief of Staff" wrapperClassName="w-60" />
          <TextField
            label="Label"
            placeholder="Add a label"
            description="Shown next to the name"
            wrapperClassName="w-60"
          />
          <TextField label="Webhook" defaultValue="not a url" error="Enter a valid URL" wrapperClassName="w-60" />
          <TextArea
            label="Instructions"
            defaultValue={"You are the chief of staff.\nKeep the calendar sane."}
            wrapperClassName="w-72"
            rows={3}
          />
          <div className="flex items-center gap-3">
            <Switch checked={on} onCheckedChange={setOn} label="Notifications" />
            <Switch checked={false} label="Off" />
          </div>
          <Select
            label="Theme"
            value={sel}
            onValueChange={setSel}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Follow System" },
            ]}
          />
          <SegmentedTabs
            label="Details sections"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "details", label: "Details" },
              { value: "library", label: "Library" },
              { value: "computer", label: "Computer" },
            ]}
          />
          <SegmentedTabs
            variant="track"
            label="Mode"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "details", label: "Watching" },
              { value: "library", label: "Take control" },
              { value: "computer", label: "Stop" },
            ]}
          />
        </Section>

        <Section title="Menus, tooltip, toast, dialog, palette">
          <MenuPanel label="Bot actions">
            <MenuItem icon={Pin}>Pin</MenuItem>
            <MenuItem icon={FolderInput} trailing="›">
              Move to
            </MenuItem>
            <MenuItem icon={EyeOff}>Hide from sidebar</MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger>
              Delete Bot
            </MenuItem>
          </MenuPanel>
          <MenuPanel label="Mention" className="w-[300px]">
            <MenuLabel>Bots</MenuLabel>
            {bots.slice(0, 5).map((b, i) => (
              <MenuItem
                key={b.id}
                active={i === 0}
                leading={<Avatar shape={b.shape} color={b.color} size={20} />}
                trailing="Bot"
              >
                {b.name}
              </MenuItem>
            ))}
          </MenuPanel>
          <MenuPanel label="Composer actions">
            <MenuItem icon={Paperclip}>Attach files</MenuItem>
            <MenuItem icon={Globe}>Share link</MenuItem>
          </MenuPanel>
          <div className="flex flex-col items-start gap-3">
            <TooltipSurface>Context 62 % · 124k / 200k</TooltipSurface>
            <Toast title="Routine saved" icon={ShieldCheck} tone="success" />
            <Toast
              title="Couldn't reach Build Box"
              icon={X}
              tone="danger"
              action={{ label: "Retry", onClick: () => {} }}
            />
            <Tooltip content="Opens the search palette">
              <PillButton onClick={() => setPalette(true)} leadingIcon={Search}>
                Open palette
              </PillButton>
            </Tooltip>
            <PillButton onClick={() => setDialog(true)}>Open dialog</PillButton>
            <Menu
              label="Demo menu"
              trigger={(p) => <IconButton {...p} icon={Ellipsis} label="More" variant="secondary" size={28} />}
            >
              <MenuItem icon={Pencil}>Rename</MenuItem>
              <MenuItem icon={Trash2} danger>
                Delete
              </MenuItem>
            </Menu>
          </div>
          <DialogPanel width={400} label="Delete Bot">
            <DialogHeader
              title="Delete Chief of Staff?"
              description="This removes the Bot, its routines and its memory."
              onClose={() => {}}
            />
            <DialogFooter>
              <PillButton>Cancel</PillButton>
              <PillButton variant="danger">Delete</PillButton>
            </DialogFooter>
          </DialogPanel>
          <DialogPanel width={560} height={360} label="Search">
            <CommandPaletteBody open onOpenChange={() => {}} items={paletteItems.slice(0, 5)} />
          </DialogPanel>
        </Section>

        <Section title="Avatars · 13 shapes × 11 colors" className="flex-col gap-2">
          {AvatarColors.map((c) => (
            <div key={c} className="flex gap-2">
              {AvatarShapes.map((s) => (
                <Avatar key={s} shape={s} color={c} size={44} label={`${c} ${s}`} />
              ))}
            </div>
          ))}
        </Section>

        <Section title="Expressions, gaze, working, status, sizes" className="items-end gap-5">
          {AvatarExpressions.map((e) => (
            <div key={e} className="flex flex-col items-center gap-1">
              <Avatar shape="blob" color="cyan" size={64} expression={e} />
              <span className="text-2xs text-fg-tertiary">{e}</span>
            </div>
          ))}
          {(["left", "right", "up"] as const).map((g) => (
            <div key={g} className="flex flex-col items-center gap-1">
              <Avatar shape="hex" color="blue" size={64} gaze={g} />
              <span className="text-2xs text-fg-tertiary">gaze {g}</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-1">
            <Avatar shape="flower" color="magenta" size={64} working />
            <span className="text-2xs text-fg-tertiary">working</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Avatar shape="house" color="gray" size={64} ghost />
            <span className="text-2xs text-fg-tertiary">ghost</span>
          </div>
          <div className="flex items-end gap-3 rounded-2xl bg-sidebar p-3">
            {(["working", "attention", "offline", "error", "unread"] as const).map((s) => (
              <Avatar key={s} shape="square" color="green" size={36} status={s} />
            ))}
            <Avatar shape="tablet" color="brown" size={60} status="unread" />
            <AvatarStack avatars={[bot("b1"), bot("b2"), bot("b4")]} size={36} />
            <AvatarStack avatars={[bot("b5"), bot("b6")]} size={36} />
          </div>
          <div className="flex items-end gap-3">
            {[16, 20, 22, 28, 36, 56, 64, 72].map((s) => {
              const d = defaultBotAvatar(`bot_${s}`)
              return <Avatar key={s} shape={d.shape} color={d.color} size={s} />
            })}
          </div>
        </Section>

        <Section title="Avatar picker">
          <div className="w-[300px] rounded-2xl bg-elevated p-3 hairline border-line-secondary shadow-popover">
            <AvatarPicker shape="blob" color="cyan" />
          </div>
        </Section>

        <Dialog open={dialog} onOpenChange={setDialog} label="Example dialog">
          <DialogHeader
            title="New session?"
            description="The Bot's memory and files stay."
            onClose={() => setDialog(false)}
          />
          <DialogBody>Starting a new session ends the native harness session; the next turn starts fresh.</DialogBody>
          <DialogFooter>
            <PillButton onClick={() => setDialog(false)}>Cancel</PillButton>
            <PillButton variant="primary" onClick={() => setDialog(false)}>
              New session
            </PillButton>
          </DialogFooter>
        </Dialog>
        <CommandPalette open={palette} onOpenChange={setPalette} items={paletteItems} />
      </div>
    </div>
  )
}

function AvatarsScene() {
  return (
    <div className="flex flex-col gap-5 bg-pane p-6">
      {AvatarColors.map((c) => (
        <div key={c} className="flex gap-4">
          {AvatarShapes.map((s) => (
            <Avatar key={s} shape={s} color={c} size={64} />
          ))}
        </div>
      ))}
      <div className="flex gap-4">
        {AvatarExpressions.map((e) => (
          <Avatar key={e} shape="blob" color="cyan" size={72} expression={e} />
        ))}
      </div>
      <div className="flex items-end gap-4">
        {[16, 20, 22, 28, 36, 60, 64, 72].map((s) => (
          <Avatar key={s} shape="cloud" color="orange" size={s} />
        ))}
      </div>
    </div>
  )
}

function App() {
  switch (scene) {
    case "chat":
      return <ChatScene />
    case "details":
      return <ChatScene details />
    case "editor":
      return <ChatScene details editor />
    case "overlays":
      return <OverlaysScene />
    case "settings":
      return <SettingsScene />
    case "avatars":
      return <AvatarsScene />
    default:
      return <StoryPage />
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toaster>
      <App />
    </Toaster>
  </StrictMode>,
)
document.fonts.ready.then(() => requestAnimationFrame(() => document.body.setAttribute("data-gallery-ready", "")))
