/**
 * Shared helpers: Schema-encoded JSON payloads (decoded on read; corrupt rows fail loudly with
 * `RepoError`), and the mapping of SQL / file-system failures to the port error `RepoError`.
 */
import { RepoError } from "@openbot/core"
import { Effect, Schema } from "effect"

/** Wraps any failure of `effect` into a `RepoError` tagged with the repository operation. */
export const repoOp =
  (op: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RepoError, R> =>
    Effect.mapError(effect, (cause) =>
      cause instanceof RepoError ? cause : new RepoError({ op, message: describeCause(cause), cause }),
    )

export const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}

/**
 * A JSON codec for one schema: `encode` (type → JSON text) and `decode` (JSON text → type). Both
 * fail with `RepoError` (decode failures name the row so corrupt data is easy to find).
 */
export const jsonCodec = <S extends Schema.Codec<any, any, never, never>>(schema: S, entity: string) => {
  const json = Schema.fromJsonString(schema)
  const encode = Schema.encodeEffect(json)
  const decode = Schema.decodeUnknownEffect(json)
  return {
    encode: (op: string, value: S["Type"]): Effect.Effect<string, RepoError> =>
      Effect.mapError(
        encode(value) as Effect.Effect<string, Schema.SchemaError>,
        (cause) => new RepoError({ op, message: `Cannot encode ${entity}: ${cause.message}`, cause }),
      ),
    decode: (op: string, text: string, key?: string): Effect.Effect<S["Type"], RepoError> =>
      Effect.mapError(
        decode(text) as Effect.Effect<S["Type"], Schema.SchemaError>,
        (cause) =>
          new RepoError({
            op,
            message: `Corrupt ${entity} row${key === undefined ? "" : ` ${key}`}: ${cause.message}`,
            cause,
          }),
      ),
  }
}

/** Plain JSON for free-form values (settings). */
export const encodeRawJson = (op: string, value: unknown): Effect.Effect<string, RepoError> =>
  Effect.try({
    try: () => {
      const text = JSON.stringify(value === undefined ? null : value)
      if (text === undefined) throw new Error("Value is not JSON-serializable")
      return text
    },
    catch: (cause) => new RepoError({ op, message: "Value is not JSON-serializable", cause }),
  })

export const decodeRawJson = (op: string, text: string, key: string): Effect.Effect<unknown, RepoError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new RepoError({ op, message: `Corrupt JSON in ${key}`, cause }),
  })

/** SQLite booleans. */
export const bool = (value: boolean): number => (value ? 1 : 0)
