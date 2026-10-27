import { describe, expect, test } from "bun:test"
import { skillCommandLength } from "../src/chat/skillCommand.ts"

describe("skill command highlighting", () => {
  test("accepts leading whitespace and stops before the arguments", () => {
    for (const whitespace of ["", "  ", "\t", "\n", "\r\n", "\u00a0", "\uFEFF"]) {
      for (const rest of ["", " my plan", "\nmy plan"]) {
        expect(skillCommandLength(`${whitespace}/grill-me${rest}`, [{ name: "grill-me" }])).toBe(
          whitespace.length + "/grill-me".length,
        )
      }
    }
  })

  test("only highlights a granted skill with a valid SkillName token", () => {
    for (const name of ["grill-me", "research_2", "0day", "a".repeat(64)]) {
      expect(skillCommandLength(`/${name} plan`, [{ name }])).toBe(name.length + 1)
    }
    for (const name of ["", "_a", "-a", "Grill", "grill.me", "grill/me", "a".repeat(65)]) {
      expect(skillCommandLength(`/${name} plan`, [{ name }])).toBe(0)
    }
    expect(skillCommandLength("/grill-me", undefined)).toBe(0)
    expect(skillCommandLength("/grill-me", [])).toBe(0)
    expect(skillCommandLength("/grill-me-more", [{ name: "grill-me" }])).toBe(0)
    expect(skillCommandLength("please /grill-me", [{ name: "grill-me" }])).toBe(0)
  })
})
