import { describe, expect, test } from "bun:test"
import { prefillOfLink } from "../src/links.ts"

describe("openbot:// links", () => {
  test("send: a page, a title, text and a recipient", () => {
    expect(prefillOfLink("openbot://send?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1&title=A%20post&text=see%20this&to=Chief%20of%20Staff")).toEqual({
      link: { url: "https://x.com/a/status/1", title: "A post" },
      text: "see this",
      to: "Chief of Staff",
    })
  })

  test("the Share menu passes a page as text: a lone URL is the link", () => {
    expect(prefillOfLink("openbot://send?text=https%3A%2F%2Fexample.com%2Fpage")).toEqual({ link: { url: "https://example.com/page" } })
    expect(prefillOfLink("openbot://send?text=hello%20world")).toEqual({ text: "hello world" })
  })

  test("other links fill nothing in", () => {
    expect(prefillOfLink("openbot://connect?origin=https%3A%2F%2Fbox&code=x")).toBeUndefined()
    expect(prefillOfLink("https://send?text=x")).toBeUndefined()
    expect(prefillOfLink("not a link")).toBeUndefined()
  })
})
