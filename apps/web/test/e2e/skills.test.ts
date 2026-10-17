// E2E: skills (D5.5) against the real brain, with a fake skills.sh (a local HTTP server the brain is
// pointed at through OPENBOT_SKILLS_SH_URL). Settings › Skills writes a skill and gives it to a Bot;
// the Bot's Library tab shows it, takes it away and adds it back; the import flow searches (and says
// so when skills.sh is down), previews and installs with the Bot preselected; deleting says who loses
// it; on a phone the editor closes back onto the Skills page. Screenshots: e2e-6x-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot, BotId } from "@openbot/contracts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Browser } from "playwright-core"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, shotsDir, startBrain } from "./brain.ts"

const SKILL_MD = "---\nname: release-notes\ndescription: Use when writing release notes for a version.\n---\n# Release notes\n\n1. List merged PRs since the last tag\n2. Group them: Features, Fixes\n"

/** A tiny skills.sh: `/api/search` and `/api/download/<owner>/<repo>/<skill>`; "offline" queries fail. */
const startFakeSkillsSh = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? ""
        if (q.includes("offline")) return new Response("down for maintenance", { status: 503 })
        const all = [
          { id: "acme/skills/release-notes", name: "release-notes", source: "acme/skills", installs: 1_234 },
          { id: "acme/skills/changelog", name: "changelog", source: "acme/skills", installs: 87 },
        ]
        return Response.json({ skills: all.filter((s) => s.id.includes(q)) })
      }
      if (decodeURIComponent(url.pathname) === "/api/download/acme/skills/release-notes") {
        return Response.json({ hash: "abc123", files: [{ path: "SKILL.md", contents: SKILL_MD }, { path: "scripts/changelog.sh", contents: "git log --oneline\n" }] })
      }
      return new Response("not found", { status: 404 })
    },
  })

describe.skipIf(!hasChromium)("e2e: skills", () => {
  let skillsSh: ReturnType<typeof startFakeSkillsSh>
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let mira: Bot
  let otto: Bot
  const skillsOf = async (botId: BotId) => [...(await rpc.call((c) => c["bots.get"]({ botId }))).skills].map(String).sort()

  beforeAll(async () => {
    skillsSh = startFakeSkillsSh()
    brain = await startBrain({ env: { OPENBOT_SKILLS_SH_URL: `http://127.0.0.1:${skillsSh.port}` } })
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    otto = await rpc.call((c) => c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-skills-otto", introduce: false }))
    mira = await rpc.call((c) => c["bots.create"]({ name: "Mira", harness: { kind: "fake" }, clientNonce: "e2e-skills-mira", introduce: false }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${mira.directConversationId}` })
    await app.page.getByRole("textbox", { name: "Message Mira" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
    await skillsSh?.stop(true)
  })

  test("Settings › Skills: write a skill and give it to Mira", async () => {
    const { page } = app
    await page.getByRole("button", { name: "Computers" }).click()
    await page.getByTestId("settings-nav-skills").click()
    const library = page.getByTestId("skills-library")
    await library.getByText("No skills yet", { exact: false }).waitFor()
    await page.getByTestId("new-skill").click()
    const dialog = page.getByRole("dialog", { name: "New skill" })
    await dialog.getByTestId("skill-name").fill("Standup Notes")
    await dialog.getByText("Saved as standup-notes").waitFor()
    await dialog.getByTestId("skill-description").fill("Use when asked for standup notes")
    await dialog.getByTestId("skill-body").fill("1. Yesterday\n2. Today\n3. Blockers")
    await dialog.getByRole("checkbox", { name: /Mira/ }).click()
    await app.shot("e2e-60-skill-new")
    await dialog.getByTestId("save-skill").click()
    await dialog.waitFor({ state: "detached" })
    const row = library.getByTestId("skill-row").filter({ hasText: "standup-notes" })
    await row.waitFor()
    await eventually(() => row.getByTestId("skill-bots").getAttribute("title"), (t) => t === "Mira", { label: "Mira on the row" })
    const [skill] = await rpc.call((c) => c["skills.list"]())
    expect(skill).toMatchObject({ name: "standup-notes", description: "Use when asked for standup notes", body: "1. Yesterday\n2. Today\n3. Blockers" })
    expect(await skillsOf(mira.id)).toEqual(["standup-notes"])
    expect(await skillsOf(otto.id)).toEqual([])
    // a second skill with the same name is refused before saving
    await page.getByTestId("new-skill").click()
    await dialog.getByTestId("skill-name").fill("standup notes")
    await dialog.getByText("There's already a skill named “standup-notes”.").waitFor()
    expect(await dialog.getByTestId("save-skill").isDisabled()).toBe(true)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await app.shot("e2e-61-skills-page")
    await page.getByRole("button", { name: "Close settings" }).click()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("Details › Library: Mira's skills; take one away, add it back from the library", async () => {
    const { page } = app
    await page.getByRole("button", { name: "View conversation details" }).click()
    const pane = page.getByTestId("details-pane")
    await pane.getByRole("tab", { name: "Library" }).click()
    const tab = pane.getByTestId("details-tab-library")
    const row = tab.getByTestId("skill-row").filter({ hasText: "standup-notes" })
    await row.waitFor()
    await app.shot("e2e-62-library")
    await row.hover()
    await row.getByTestId("remove-skill").click()
    await row.waitFor({ state: "detached" })
    await tab.getByText("Mira has no skills yet. Add one from the library, or ask Mira to save one.").waitFor()
    await eventually(() => skillsOf(mira.id), (s) => s.length === 0, { label: "standup-notes taken from Mira" })
    // the library keeps it
    expect((await rpc.call((c) => c["skills.list"]())).map((s) => String(s.name))).toEqual(["standup-notes"])

    await tab.getByTestId("add-skill").click()
    await page.getByRole("menuitem", { name: "standup-notes" }).click()
    await row.waitFor()
    expect(await skillsOf(mira.id)).toEqual(["standup-notes"])
    expect(app.errors).toEqual([])
  }, 60_000)

  test("import from skills.sh: search (and its outage), preview, install for Mira", async () => {
    const { page } = app
    const tab = page.getByTestId("details-tab-library")
    await tab.getByTestId("add-skill").click()
    await page.getByRole("menuitem", { name: "Browse skills.sh…" }).click()
    const dialog = page.getByRole("dialog", { name: "Import from skills.sh" })
    const search = dialog.getByTestId("skills-sh-search")
    await search.fill("offline")
    await dialog.getByText("skills.sh didn't answer — try again.").waitFor()
    await search.fill("release")
    const result = dialog.getByTestId("skills-sh-result").filter({ hasText: "release-notes" })
    await result.waitFor()
    expect(await result.innerText()).toContain("1.2K installs")
    expect(await dialog.getByTestId("skills-sh-result").count()).toBe(1)
    await result.click()
    await dialog.getByTestId("skill-preview-body").getByText("List merged PRs since the last tag").waitFor()
    await dialog.getByTestId("skill-preview-files").getByText("scripts/changelog.sh").waitFor()
    expect(await dialog.getByRole("link", { name: /View on skills.sh/ }).getAttribute("href")).toBe("https://skills.sh/acme/skills/release-notes")
    expect(await dialog.getByRole("link", { name: /View on skills.sh/ }).getAttribute("target")).toBe("_blank")
    expect(await dialog.getByRole("checkbox", { name: /Mira/ }).getAttribute("aria-checked")).toBe("true")
    expect(await dialog.getByTestId("skill-replaces").count()).toBe(0)
    await app.shot("e2e-63-skills-preview")
    await dialog.getByTestId("install-skill").click()
    await dialog.waitFor({ state: "detached" })
    await tab.getByTestId("skill-row").filter({ hasText: "release-notes" }).getByText("skills.sh", { exact: true }).waitFor()
    const installed = (await rpc.call((c) => c["skills.list"]())).find((s) => s.name === "release-notes")
    expect(installed).toMatchObject({ description: "Use when writing release notes for a version.", source: { kind: "skills.sh", id: "acme/skills/release-notes" }, files: ["scripts/changelog.sh"] })
    expect(await skillsOf(mira.id)).toEqual(["release-notes", "standup-notes"])
    expect(existsSync(join(brain.dataDir, "skills-lib", "skills", "release-notes", "scripts", "changelog.sh"))).toBe(true)
    await app.shot("e2e-64-library-imported")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("Manage the library → an imported skill shows its source; deleting says who loses it", async () => {
    const { page } = app
    await page.getByTestId("details-tab-library").getByTestId("manage-library").click()
    const library = page.getByTestId("settings-page-skills").getByTestId("skills-library")
    await library.getByTestId("skill-row").filter({ hasText: "release-notes" }).click()
    const imported = page.getByRole("dialog", { name: "Skill release-notes" })
    await imported.getByTestId("skill-source").getByText("acme/skills/release-notes").waitFor()
    await imported.getByTestId("skill-files").getByText("scripts/changelog.sh").waitFor()
    await imported.getByRole("button", { name: "Cancel" }).click()
    await imported.waitFor({ state: "detached" })

    await library.getByTestId("skill-row").filter({ hasText: "standup-notes" }).click()
    const editor = page.getByRole("dialog", { name: "Skill standup-notes" })
    await editor.getByTestId("delete-skill").click()
    const confirm = page.getByRole("dialog", { name: "Delete “standup-notes”?" })
    await confirm.getByText("Mira will lose it.").waitFor()
    await app.shot("e2e-65-skill-delete")
    await confirm.getByRole("button", { name: "Delete" }).click()
    await editor.waitFor({ state: "detached" })
    await library.getByTestId("skill-row").filter({ hasText: "standup-notes" }).waitFor({ state: "detached" })
    await eventually(() => skillsOf(mira.id), (s) => s.join() === "release-notes", { label: "standup-notes gone from Mira" })
    await page.getByRole("button", { name: "Close settings" }).click()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("re-importing replaces: the Bots that have it start checked, unchecking one takes it away", async () => {
    const { page } = app
    await page.getByRole("button", { name: "Computers" }).click()
    await page.getByTestId("settings-nav-skills").click()
    await page.getByTestId("import-skill").click()
    const dialog = page.getByRole("dialog", { name: "Import from skills.sh" })
    await dialog.getByTestId("skills-sh-search").fill("release")
    const result = dialog.getByTestId("skills-sh-result").filter({ hasText: "release-notes" })
    await result.getByText("In your library").waitFor()
    await result.click()
    await dialog.getByTestId("skill-replaces").waitFor()
    const miraBox = dialog.getByRole("checkbox", { name: /Mira/ })
    await eventually(() => miraBox.getAttribute("aria-checked"), (v) => v === "true", { label: "Mira checked" })
    expect(await dialog.getByRole("checkbox", { name: /Otto/ }).getAttribute("aria-checked")).toBe("false")
    await miraBox.click()
    await dialog.getByTestId("install-skill").getByText("Replace").waitFor()
    await dialog.getByTestId("install-skill").click()
    await dialog.waitFor({ state: "detached" })
    await eventually(() => skillsOf(mira.id), (s) => s.length === 0, { label: "release-notes taken from Mira" })
    expect((await rpc.call((c) => c["skills.list"]())).map((s) => String(s.name))).toEqual(["release-notes"])
    await page.getByTestId("skills-library").getByTestId("skill-row").filter({ hasText: "release-notes" }).getByText("No Bots").waitFor()
    await page.getByRole("button", { name: "Close settings" }).click()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("phone: Settings › Skills fits the screen; the editor closes back onto the page, Back to the list", async () => {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const errors: Array<string> = []
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
      await page.goto(brain.loginUrl)
      await page.getByRole("button", { name: "Account" }).tap()
      await page.getByRole("menuitem", { name: /Settings/ }).tap()
      await page.getByTestId("settings-nav-skills").tap()
      const skillsPage = page.getByTestId("settings-page-skills")
      await skillsPage.getByTestId("skill-row").filter({ hasText: "release-notes" }).waitFor()
      // no horizontal scrolling
      expect(await skillsPage.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.waitForTimeout(500) // the page slides in
      await page.screenshot({ path: `${shotsDir}/e2e-66-mobile-skills.png` })
      await skillsPage.getByTestId("skill-row").filter({ hasText: "release-notes" }).tap()
      const editor = page.getByRole("dialog", { name: "Skill release-notes" })
      await editor.getByTestId("skill-files").waitFor()
      await editor.getByRole("button", { name: "Cancel" }).tap()
      await editor.waitFor({ state: "detached" })
      // still on the Skills page (the editor's history entry is popped, not Settings')
      await page.waitForTimeout(300)
      await skillsPage.waitFor()
      await page.goBack()
      await page.getByTestId("settings-nav-skills").waitFor()
      expect(await page.getByTestId("settings-dialog").count()).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  }, 60_000)
})
