#!/usr/bin/env bun
// openbot-node entry point (`bun build --compile apps/node/src/main.ts`). SIGINT/SIGTERM interrupt
// the program: the dial-out socket closes, sessions are interrupted (process groups killed) and the
// browser closes gracefully. A requested shutdown exits 0.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Runtime from "effect/Runtime"
import { runScreenHelper } from "@openbot/node-daemon"
import { runCli } from "./cli.ts"

// the Mac screen helper (a child of the node: CoreGraphics events over stdin/stdout)
if (process.argv[2] === "screen-helper") {
  await runScreenHelper()
  process.exit(0)
}

BunRuntime.runMain({
  teardown: (exit, onExit) => {
    if (Exit.isSuccess(exit)) return onExit(typeof exit.value === "number" ? exit.value : 0)
    if (Cause.hasInterruptsOnly(exit.cause)) return onExit(0)
    return Runtime.defaultTeardown(exit, onExit)
  },
})(runCli(process.argv.slice(2)))
