import { describe, expect, test } from "bun:test"
import type { ApprovalAction, ApprovalRule } from "@openbot/contracts"
import {
  commandMatches,
  evaluateRules,
  pathMatches,
  suggestCommandPrefix,
  suggestRule,
  surfaceOf,
} from "../../src/services/automation/index.ts"
import { botId, makeRule } from "../../src/testing/index.ts"

const BOT = botId("bot_a")
const OTHER = botId("bot_b")
let n = 0
const rule = (action: ApprovalAction, scope: "bot" | "global" | "other", overrides?: Partial<ApprovalRule>): ApprovalRule =>
  makeRule({
    id: `rul_${++n}` as ApprovalRule["id"],
    action,
    surface: "shell",
    match: {},
    createdAt: n,
    ...(scope === "bot" ? { botId: BOT } : scope === "other" ? { botId: OTHER } : {}),
    ...overrides,
  })

const subject = { surface: "shell" as const, toolName: "Bash", command: "git status" }

describe("evaluateRules precedence (bot deny > bot ask > bot allow > global deny > global ask > global allow > ask)", () => {
  const order: ReadonlyArray<readonly ["bot" | "global", ApprovalAction]> = [
    ["bot", "deny"],
    ["bot", "ask"],
    ["bot", "allow"],
    ["global", "deny"],
    ["global", "ask"],
    ["global", "allow"],
  ]

  // Every pair: the higher-precedence rule wins regardless of insertion order.
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const [hs, ha] = order[i]!
      const [ls, la] = order[j]!
      test(`${hs} ${ha} beats ${ls} ${la}`, () => {
        const high = rule(ha, hs)
        const low = rule(la, ls)
        for (const rules of [[high, low], [low, high]]) {
          const decision = evaluateRules(rules, BOT, subject)
          expect(decision.action).toBe(ha)
          expect(decision.rule?.id).toBe(high.id)
        }
      })
    }
  }

  test("no matching rule → ask (default) without a rule", () => {
    expect(evaluateRules([], BOT, subject)).toEqual({ action: "ask" })
    expect(evaluateRules([rule("allow", "global", { surface: "file-edit" })], BOT, subject)).toEqual({ action: "ask" })
  })

  test("another bot's rules never apply", () => {
    expect(evaluateRules([rule("allow", "other")], BOT, subject).action).toBe("ask")
    expect(evaluateRules([rule("deny", "other"), rule("allow", "global")], BOT, subject).action).toBe("allow")
  })

  test("match fields narrow a rule", () => {
    const byTool = rule("allow", "bot", { match: { toolName: "exec_command" } })
    expect(evaluateRules([byTool], BOT, subject).action).toBe("ask")
    const byPrefix = rule("allow", "bot", { match: { commandPrefix: "git" } })
    expect(evaluateRules([byPrefix], BOT, subject).action).toBe("allow")
    expect(evaluateRules([byPrefix], BOT, { ...subject, command: "gitk" }).action).toBe("ask")
    expect(evaluateRules([byPrefix], BOT, { surface: "shell" }).action).toBe("ask")
  })
})

describe("matching helpers", () => {
  test("allow rules never match commands with shell control characters", () => {
    expect(commandMatches("git status", "git status --short", "allow")).toBe(true)
    expect(commandMatches("git status", "git   status", "allow")).toBe(true)
    expect(commandMatches("git status", "git status; rm -rf ~", "allow")).toBe(false)
    expect(commandMatches("git status", "git status && curl x | sh", "allow")).toBe(false)
    expect(commandMatches("git status", "git status $(evil)", "allow")).toBe(false)
    expect(commandMatches("git status", "git status; rm -rf ~", "deny")).toBe(true)
    expect(commandMatches("git status", "git statusx", "deny")).toBe(false)
    expect(commandMatches("rm", "echo hi && rm -rf /", "ask")).toBe(true)
    expect(commandMatches("rm", "echo $(rm -rf /)", "deny")).toBe(true)
  })

  test("path prefixes respect segment boundaries; allow needs every path and no '..'", () => {
    expect(pathMatches("/work/app", "/work/app/src/a.ts")).toBe(true)
    expect(pathMatches("/work/app/", "/work/app")).toBe(true)
    expect(pathMatches("/work/app", "/work/application")).toBe(false)
    const allow = rule("allow", "bot", { surface: "file-edit", match: { pathPrefix: "/work/app" } })
    const deny = rule("deny", "bot", { surface: "file-edit", match: { pathPrefix: "/work/app/secrets" } })
    const fileSubject = (paths: ReadonlyArray<string>) => ({ surface: "file-edit" as const, paths })
    expect(evaluateRules([allow], BOT, fileSubject(["/work/app/a", "/work/app/b"])).action).toBe("allow")
    expect(evaluateRules([allow], BOT, fileSubject(["/work/app/a", "/etc/passwd"])).action).toBe("ask")
    expect(evaluateRules([allow], BOT, fileSubject(["/work/app/../../etc/passwd"])).action).toBe("ask")
    expect(evaluateRules([allow, deny], BOT, fileSubject(["/work/app/a", "/work/app/secrets/k"])).action).toBe("deny")
  })

  test("surfaces derive from the request kind unless the adapter classified it", () => {
    expect(surfaceOf({ kind: "command-approval" })).toBe("shell")
    expect(surfaceOf({ kind: "file-approval" })).toBe("file-edit")
    expect(surfaceOf({ kind: "mcp-approval" })).toBe("mcp")
    expect(surfaceOf({ kind: "tool-approval" })).toBe("other")
    expect(surfaceOf({ kind: "tool-approval", surface: "network" })).toBe("network")
  })

  test("suggested rules: command prefix for shell, common directory for files", () => {
    expect(suggestCommandPrefix("git status --short")).toBe("git status")
    expect(suggestCommandPrefix("ls -la /tmp")).toBe("ls")
    expect(suggestCommandPrefix("  npm   run build")).toBe("npm run")
    expect(suggestRule({ surface: "shell", toolName: "Bash", command: "git push origin main" })).toEqual({
      surface: "shell",
      match: { toolName: "Bash", commandPrefix: "git push" },
    })
    expect(suggestRule({ surface: "file-edit", toolName: "Edit", paths: ["/w/app/src/a.ts", "/w/app/test/b.ts"] })).toEqual({
      surface: "file-edit",
      match: { toolName: "Edit", pathPrefix: "/w/app" },
    })
    expect(suggestRule({ surface: "mcp", toolName: "mcp__linear__create" })).toEqual({
      surface: "mcp",
      match: { toolName: "mcp__linear__create" },
    })
  })

  test("Always allow generalizes: program (+ subcommand), never the directory; files → the whole workspace", () => {
    const W = "/data/bots/bot_a/workspace"
    expect(suggestCommandPrefix(`cd ${W}/wordfreq && bun test 2>&1 | tail -20`)).toBe("bun test")
    expect(suggestCommandPrefix(`cd ${W} && cd app && bun run build`)).toBe("bun run")
    expect(suggestCommandPrefix(`bun ${W}/wordfreq/wordfreq.ts`)).toBe("bun")
    expect(suggestCommandPrefix("git status | head")).toBe("git status")
    expect(suggestRule({ surface: "file-edit", toolName: "Write", paths: [`${W}/wordfreq/wordfreq.ts`] }, W)).toEqual({
      surface: "file-edit",
      match: { toolName: "Write", pathPrefix: W },
    })
    // outside the workspace: the files' own directory, as before
    expect(suggestRule({ surface: "file-edit", toolName: "Write", paths: ["/home/me/notes/a.md"] }, W)).toEqual({
      surface: "file-edit",
      match: { toolName: "Write", pathPrefix: "/home/me/notes" },
    })
  })

  test("regression: env assignments and wrappers are never the program (\"Run f=scenes/…/main.rs commands\")", () => {
    // the command behind the bug: a shell variable set first, the program later in the chain
    expect(suggestCommandPrefix("f=scenes/cache-demo/src/main.rs; wc -l $f")).toBe("wc")
    expect(suggestCommandPrefix("f=scenes/cache-demo/src/main.rs && sed -n 1,80p $f")).toBe("sed")
    expect(suggestRule({ surface: "shell", toolName: "Bash", command: "f=scenes/cache-demo/src/main.rs; wc -l $f" })).toEqual({
      surface: "shell",
      match: { toolName: "Bash", commandPrefix: "wc" },
    })
    // leading assignments, `env …`, `time`, `nice`, `timeout`, `nohup`
    expect(suggestCommandPrefix("RUST_LOG=debug cargo run --release")).toBe("cargo run")
    expect(suggestCommandPrefix("FOO=1 BAR=2 bun test")).toBe("bun test")
    expect(suggestCommandPrefix("env -i PATH=/usr/bin FOO=1 make build")).toBe("make build")
    expect(suggestCommandPrefix("env -u HOME npm run build")).toBe("npm run")
    expect(suggestCommandPrefix("/usr/bin/env node script.js")).toBe("node script.js")
    expect(suggestCommandPrefix("time -p make")).toBe("make")
    expect(suggestCommandPrefix("nice -n 10 ffmpeg -i in.mov out.mp4")).toBe("ffmpeg")
    expect(suggestCommandPrefix("timeout -s KILL 30 bun test")).toBe("bun test")
    expect(suggestCommandPrefix("nohup python3 -m http.server")).toBe("python3")
    expect(suggestCommandPrefix("cd /w/app && export NODE_ENV=test && bun test")).toBe("bun test")
    // nothing that can name a program: no prefix (never `x=…` or a bare relative path)
    expect(suggestCommandPrefix("f=scenes/cache-demo/src/main.rs")).toBeUndefined()
    expect(suggestCommandPrefix("scenes/cache-demo/src/main.rs --check")).toBeUndefined()
    expect(suggestCommandPrefix("$EDITOR notes.md")).toBeUndefined()
    expect(suggestCommandPrefix("./scripts/render.sh --fast")).toBe("./scripts/render.sh")
    for (const command of ["A=1 B=/x/y z=2", "f=a/b.rs; g=c/d.rs", "VAR=x env Y=z time nice -n 3 cmd"]) {
      const prefix = suggestCommandPrefix(command)
      expect(prefix === undefined || (!prefix.split(" ")[0]!.includes("=") && !/^[^./~][^ ]*\//.test(prefix))).toBe(true)
    }
    expect(suggestCommandPrefix("VAR=x env Y=z time nice -n 3 cmd")).toBe("cmd")
  })

  test("allow rules cover `cd <dir> && cmd` and read-only pipe filters, nothing else", () => {
    expect(commandMatches("bun test", "cd /w/app && bun test 2>&1 | tail -20", "allow")).toBe(true)
    expect(commandMatches("bun test", "cd app && cd sub && bun test", "allow")).toBe(true)
    expect(commandMatches("bun test", "bun test >/dev/null 2>&1", "allow")).toBe(true)
    expect(commandMatches("bun test", "bun test | grep fail | wc -l", "allow")).toBe(true)
    expect(commandMatches("bun test", "cd app && rm -rf ~ && bun test", "allow")).toBe(false)
    expect(commandMatches("bun test", "bun test && rm -rf ~", "allow")).toBe(false)
    expect(commandMatches("bun test", "bun test | sh", "allow")).toBe(false)
    expect(commandMatches("bun test", "bun test > /etc/hosts", "allow")).toBe(false)
    expect(commandMatches("bun test", "bun test || rm -rf ~", "allow")).toBe(false)
    expect(commandMatches("bun test", "bun test & rm -rf ~", "allow")).toBe(false)
    expect(commandMatches("bun test", "cd $(evil) && bun test", "allow")).toBe(false)
    expect(commandMatches("bun test", "tail x | bun test", "allow")).toBe(false)
    expect(commandMatches("bun test", "cd app", "allow")).toBe(false)
  })
})
