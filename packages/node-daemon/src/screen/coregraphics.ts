// CoreGraphics through bun:ffi, for the Mac screen helper (./helper.ts; macOS only). Only this
// module touches native code; it runs in the helper process, never in the node itself.
//
// `CGPoint` arguments are passed as two doubles: a struct of two doubles travels in two floating-
// point registers on both arm64 (an HFA) and x86-64 (SysV), exactly like two double arguments,
// while the integer arguments keep their own registers.
import { dlopen, FFIType, ptr } from "bun:ffi"
import type { CoreGraphics } from "./helper.ts"

const FRAMEWORKS = "/System/Library/Frameworks"
const CG = `${FRAMEWORKS}/CoreGraphics.framework/CoreGraphics`
const CF = `${FRAMEWORKS}/CoreFoundation.framework/CoreFoundation`
const AS = `${FRAMEWORKS}/ApplicationServices.framework/ApplicationServices`

const HID_EVENT_TAP = 0
const HID_SYSTEM_STATE = 1
const ANY_INPUT_EVENT = 0xffffffff
const FIELD_CLICK_STATE = 1

export const loadCoreGraphics = (): CoreGraphics => {
  const cg = dlopen(CG, {
    CGEventCreateMouseEvent: {
      args: [FFIType.ptr, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32],
      returns: FFIType.ptr,
    },
    CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
    CGEventKeyboardSetUnicodeString: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    CGEventSetFlags: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
    CGEventSetIntegerValueField: { args: [FFIType.ptr, FFIType.u32, FFIType.i64], returns: FFIType.void },
    CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
    CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
    CGMainDisplayID: { args: [], returns: FFIType.u32 },
    CGDisplayCopyDisplayMode: { args: [FFIType.u32], returns: FFIType.ptr },
    CGDisplayModeGetWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
    CGDisplayModeGetHeight: { args: [FFIType.ptr], returns: FFIType.u64 },
    CGDisplayModeRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
    CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
  }).symbols
  // macOS 13+ (the variadic CGEventCreateScrollWheelEvent cannot be called through FFI)
  const wheel = (() => {
    try {
      return dlopen(CG, {
        CGEventCreateScrollWheelEvent2: {
          args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32],
          returns: FFIType.ptr,
        },
      }).symbols
    } catch {
      return undefined
    }
  })()
  const cf = dlopen(CF, { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } }).symbols
  const ax = dlopen(AS, { AXIsProcessTrusted: { args: [], returns: FFIType.bool } }).symbols

  const post = (event: unknown, flags: number) => {
    if (event === null || event === undefined) throw new Error("could not create the event")
    cg.CGEventSetFlags(event as never, BigInt(flags) as never)
    cg.CGEventPost(HID_EVENT_TAP, event as never)
    cf.CFRelease(event as never)
  }

  return {
    mouse: (type, x, y, button, clickState, flags) => {
      const e = cg.CGEventCreateMouseEvent(null, type, x, y, button)
      if (e !== null && clickState > 0)
        cg.CGEventSetIntegerValueField(e, FIELD_CLICK_STATE, BigInt(clickState) as never)
      post(e, flags)
    },
    key: (keyCode, down, flags) => post(cg.CGEventCreateKeyboardEvent(null, keyCode, down), flags),
    unicode: (text, down, flags) => {
      const units = new Uint16Array(text.length)
      for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i)
      const e = cg.CGEventCreateKeyboardEvent(null, 0, down)
      if (e !== null) cg.CGEventKeyboardSetUnicodeString(e, BigInt(units.length) as never, ptr(units))
      post(e, flags)
    },
    scroll: (unit, dy, dx, flags) => {
      if (wheel === undefined) throw new Error("scrolling needs macOS 13 or later")
      post(wheel.CGEventCreateScrollWheelEvent2(null, unit, 2, dy, dx, 0), flags)
    },
    secondsSinceInput: () => cg.CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT),
    displaySize: () => {
      const mode = cg.CGDisplayCopyDisplayMode(cg.CGMainDisplayID())
      if (mode === null) throw new Error("no main display")
      // points (the HiDPI mode's logical size), the space mouse events use
      const size = { width: Number(cg.CGDisplayModeGetWidth(mode)), height: Number(cg.CGDisplayModeGetHeight(mode)) }
      cg.CGDisplayModeRelease(mode)
      return size
    },
    screenRecordingAllowed: () => cg.CGPreflightScreenCaptureAccess(),
    requestScreenRecording: () => cg.CGRequestScreenCaptureAccess(),
    accessibilityAllowed: () => ax.AXIsProcessTrusted(),
  }
}
