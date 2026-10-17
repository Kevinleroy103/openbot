import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { chromiumPath, screenshotDir, takeScreenshots } from "../scripts/screenshot.ts"

// Builds the gallery with Bun's HTML bundler + Tailwind and screenshots it in Chromium (dark + light).
// Skipped when no Chromium is available (set OPENBOT_CHROMIUM to point at one).
test.skipIf(!existsSync(chromiumPath))(
  "gallery renders in Chromium (dark and light screenshots)",
  async () => {
    const { files, errors } = await takeScreenshots({ only: ["all", "chat"] })
    expect(errors).toEqual([])
    expect(files.map((f) => f.slice(screenshotDir.length + 1)).sort()).toEqual(["all-dark.png", "all-light.png", "chat-dark.png", "chat-light.png"])
    for (const f of files) expect(statSync(f).size).toBeGreaterThan(20_000)
  },
  60_000,
)
