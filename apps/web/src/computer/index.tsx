// W2.3 computer module (apps/web/src/contracts.ts): the full-screen live view plus the pieces the
// details pane, settings and cards reuse (screen thumbnail / peek, terminal, desktop setup hints, the
// one-shot initial tab).
export { ComputerView } from "./ComputerView.tsx"
export { ScreenPeek, ScreenThumbnail, type ScreenThumbnailProps } from "./ScreenThumbnail.tsx"
export { TerminalPane } from "./TerminalPane.tsx"
export { DesktopSetupNote } from "./DesktopSetupNote.tsx"
export { computerInitialTabAtom, useComputer, availabilityOf, type ScreenAvailability } from "./useComputer.ts"
