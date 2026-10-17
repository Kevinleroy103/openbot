// @openbot/web package entry. The server serves `@openbot/web/index.html` (Bun HTML import); this
// module only re-exports the W2.2 <-> W2.3 prop contracts as types (no React at import time).
export type {
  ComputerViewProps,
  DetailsPaneProps,
  DetailsTab,
  NewBotFormProps,
  NewGroupFormProps,
  OnboardingProps,
  SettingsDialogProps,
  SettingsPage,
} from "./contracts.ts"
