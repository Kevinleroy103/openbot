import { expect, test } from "bun:test"
import { plainPreview } from "../src/app/format.ts"
test("plainPreview", () => {
  expect(plainPreview("Sent my feedback: about **8/10**, with _care_")).toBe("Sent my feedback: about 8/10, with care")
  expect(plainPreview("I called list_bots and a*b")).toBe("I called list_bots and a*b")
  expect(plainPreview("## Title\n> quoted `code` [link](http://x)")).toBe("Title quoted code link")
})
