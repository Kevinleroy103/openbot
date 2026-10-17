import { describe, expect, test } from "bun:test"
import { NotFound } from "@openbot/contracts"
import { Effect, Exit, Stream } from "effect"
import { decodeBase64, edge, edgeStream } from "../src/rpc.ts"

describe("RPC edge", () => {
  test("typed failures pass unchanged; defects become Internal; interrupts propagate", async () => {
    const notFound = await Effect.runPromise(Effect.flip(edge("t", Effect.fail(new NotFound({ entity: "bot", id: "b" })))))
    expect(notFound).toMatchObject({ _tag: "NotFound", entity: "bot" })
    const internal = await Effect.runPromise(Effect.flip(edge("t", Effect.die(new Error("db is gone")))))
    expect(internal._tag).toBe("Internal")
    expect(internal.message).not.toContain("db is gone")
    const interrupted = await Effect.runPromiseExit(edge("t", Effect.interrupt))
    expect(Exit.isFailure(interrupted) && Exit.hasInterrupts(interrupted)).toBe(true)
    const streamed = await Effect.runPromise(Effect.flip(Stream.runCollect(edgeStream("t", Stream.die("boom")))))
    expect(streamed._tag).toBe("Internal")
  })

  test("base64 payloads", () => {
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8="))).toBe("hello")
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8"))).toBe("hello")
    expect(new TextDecoder().decode(decodeBase64("aGV s\nbG8="))).toBe("hello")
    expect(decodeBase64("%%%")).toBeUndefined()
    expect(decodeBase64("a")).toBeUndefined()
  })
})
