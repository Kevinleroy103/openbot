// Small read hooks over the client atoms. Server state comes from @openbot/client replicas; these
// helpers only unwrap `AsyncResult`s and build lookups the screens share.
import { useMemo } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { Atom } from "effect/reactivity"
import { emptyRosterState, type Bot, type BotId, type RosterState } from "@openbot/contracts"
import { rosterAtom, sessionInfoAtom } from "@openbot/client"

/** The success value of an AsyncResult, or `fallback` while initial/failed. */
export const valueOr = <A, E>(result: AsyncResult.AsyncResult<A, E>, fallback: A): A =>
  AsyncResult.isSuccess(result) ? result.value : fallback

export const useResultValue = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>, fallback: A): A =>
  valueOr(useAtomValue(atom), fallback)

export interface RosterView {
  readonly state: RosterState
  /** True once the first snapshot arrived. */
  readonly loaded: boolean
  readonly bots: ReadonlyArray<Bot>
  readonly botById: (id: BotId | string | undefined) => Bot | undefined
}

/** The whole roster replica (bots, conversations, activities, sections, settings). */
export const useRoster = (): RosterView => {
  const result = useAtomValue(rosterAtom)
  const state = valueOr(result, emptyRosterState)
  const loaded = AsyncResult.isSuccess(result) && state.cursor !== undefined
  return useMemo(() => {
    const bots = [...state.bots.values()].sort((a, b) => a.name.localeCompare(b.name))
    return {
      state,
      loaded,
      bots,
      botById: (id) => (id === undefined ? undefined : state.bots.get(id as BotId)),
    }
  }, [state, loaded])
}

export const useSessionInfo = () => useAtomValue(sessionInfoAtom)
