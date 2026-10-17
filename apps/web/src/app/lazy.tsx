// Lazy mounts for the W2.3 components (docs/plan.md W2.3; prop contracts in ../contracts.ts). Each
// module is imported on first use; when a module is missing (W2.3 still in flight) or throws on
// load, the built-in fallback from ./fallbacks.tsx renders instead so the shell keeps working.
import { type ComponentType, lazy } from "react"
import type { ComputerViewProps, DetailsPaneProps, NewBotFormProps, NewGroupFormProps, OnboardingProps, SettingsDialogProps } from "../contracts.ts"
import {
  FallbackComputerView,
  FallbackDetailsPane,
  FallbackNewBotForm,
  FallbackNewGroupForm,
  FallbackOnboarding,
  FallbackSettingsDialog,
} from "./fallbacks.tsx"

const lazyNamed = <P extends object>(load: () => Promise<unknown>, name: string, fallback: ComponentType<P>) =>
  lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try {
      const mod = (await load()) as Record<string, unknown>
      const component = mod[name] as ComponentType<P> | undefined
      if (typeof component !== "function" && typeof component !== "object") throw new Error(`no export ${name}`)
      return { default: component ?? fallback }
    } catch (error) {
      console.warn(`[openbot] ${name} is not available yet; using the built-in fallback.`, error)
      return { default: fallback }
    }
  })

// The W2.3 directories may not exist yet; the ts-ignores keep this file compiling either way.
// prettier-ignore
// @ts-ignore W2.3 module (apps/web/src/details)
export const DetailsPane = lazyNamed<DetailsPaneProps>(() => import("../details"), "DetailsPane", FallbackDetailsPane)
// prettier-ignore
// @ts-ignore W2.3 module (apps/web/src/computer)
export const ComputerView = lazyNamed<ComputerViewProps>(() => import("../computer"), "ComputerView", FallbackComputerView)
// prettier-ignore
// @ts-ignore W2.3 module (apps/web/src/settings)
export const SettingsDialog = lazyNamed<SettingsDialogProps>(() => import("../settings"), "SettingsDialog", FallbackSettingsDialog)
// prettier-ignore
// @ts-ignore W2.3 module (apps/web/src/dialogs)
export const NewBotForm = lazyNamed<NewBotFormProps>(() => import("../dialogs"), "NewBotForm", FallbackNewBotForm)
// prettier-ignore
// @ts-ignore W2.3 module (apps/web/src/dialogs)
export const NewGroupForm = lazyNamed<NewGroupFormProps>(() => import("../dialogs"), "NewGroupForm", FallbackNewGroupForm)
// prettier-ignore
// @ts-ignore W2.3 module (apps/web/src/onboarding)
export const Onboarding = lazyNamed<OnboardingProps>(() => import("../onboarding"), "Onboarding", FallbackOnboarding)
