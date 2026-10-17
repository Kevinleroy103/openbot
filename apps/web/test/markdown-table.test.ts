import { expect, test } from "bun:test"
import { parseBlocks, splitRow } from "../src/chat/Markdown.tsx"
test("table", () => {
  const b = parseBlocks("I created:\n\n| Bot | Harness / model | Role |\n|---|:---:|---:|\n| **Claude** | Claude / Opus | code \\| tests |\n| Codex | `gpt` | same |\n\nafter")
  expect(b.map((x) => x.kind)).toEqual(["paragraph", "table", "paragraph"])
  const t = b[1] as any
  expect(t.header).toEqual(["Bot", "Harness / model", "Role"])
  expect(t.align).toEqual([undefined, "center", "right"])
  expect(t.rows[0]).toEqual(["**Claude**", "Claude / Opus", "code | tests"])
  expect(splitRow("a | b")).toEqual(["a", "b"])
})
