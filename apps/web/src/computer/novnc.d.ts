// Types for the part of noVNC 1.7.0's RFB client (`@novnc/novnc`, MPL-2.0, ships no types) the desktop
// view uses. See node_modules/@novnc/novnc/docs/API.md.
//
// Bundling: noVNC's core/util/browser.js has a top-level `await` that Bun's dev server (HMR) cannot
// initialize in order; the root `patchedDependencies` (patches/@novnc%2Fnovnc@1.7.0.patch) turns it
// into a promise, so the module works in `bun --hot` / the dev mock and in `Bun.build` bundles alike.
// The same patch re-exports `initLogging` from core/rfb.js (the package exports only that module).
declare module "@novnc/novnc" {
  export function initLogging(level?: "debug" | "info" | "warn" | "error" | "none"): void

  export interface RfbOptions {
    readonly shared?: boolean
    readonly credentials?: { readonly username?: string; readonly password?: string; readonly target?: string }
    readonly repeaterID?: string
    readonly wsProtocols?: ReadonlyArray<string>
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions)
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    dragViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    focusOnClick: boolean
    /** CSS background of the area around the scaled screen. */
    background: string
    qualityLevel: number
    compressionLevel: number
    readonly capabilities: { readonly power: boolean }
    disconnect(): void
    focus(options?: FocusOptions): void
    blur(): void
    /** `down` undefined = press and release. */
    sendKey(keysym: number, code: string | null, down?: boolean): void
    sendCtrlAltDel(): void
    clipboardPasteFrom(text: string): void
  }
}
