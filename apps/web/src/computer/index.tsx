// W2.3 computer module (apps/web/src/contracts.ts): the full-screen live view plus the pieces the
// details pane reuses (screen thumbnail, terminal, the one-shot initial tab).
export { ComputerView } from "./ComputerView.tsx"
export { ScreenThumbnail, type ScreenThumbnailProps } from "./ScreenThumbnail.tsx"
export { TerminalPane } from "./TerminalPane.tsx"
export { computerInitialTabAtom, useComputer, availabilityOf, type ScreenAvailability } from "./useComputer.ts"
