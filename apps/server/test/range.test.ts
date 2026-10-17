import { describe, expect, test } from "bun:test"
import { parseByteRange } from "../src/routes.ts"

describe("parseByteRange (RFC 9110 single byte ranges)", () => {
  test("a-b, a-, -n; clamps the end; ignores what it cannot serve as one range", () => {
    expect(parseByteRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 })
    expect(parseByteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 })
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange("bytes=90-1000", 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange(" Bytes = 5 - 9 ", 100)).toEqual({ start: 5, end: 9 })
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=-0", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=0-", 0)).toBe("unsatisfiable")
    for (const ignored of [undefined, "bytes=0-1,5-9", "bytes=9-5", "items=0-1", "bytes=-", "bytes=a-b", ""]) {
      expect(parseByteRange(ignored, 100)).toBeUndefined()
    }
  })
})
