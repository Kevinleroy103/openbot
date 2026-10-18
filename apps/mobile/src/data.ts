// Small hooks over the shared client's atoms (the web app's app/data.ts, for React Native).
import { useAtomValue } from "@effect/atom-react"
import { rosterAtom } from "@openbot/client"
import { type Bot, type BotId, emptyRosterState, type RosterState } from "@openbot/contracts"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"

export const valueOr = <A, E>(result: AsyncResult.AsyncResult<A, E>, fallback: A): A => (AsyncResult.isSuccess(result) ? result.value : fallback)

export interface RosterView {
  readonly state: RosterState
  /** the first snapshot arrived */
  readonly loaded: boolean
  readonly botById: (id: BotId | string | undefined) => Bot | undefined
}

/** The live roster: bots, conversations, activities, sections, nodes, settings. */
export const useRoster = (): RosterView => {
  const result = useAtomValue(rosterAtom)
  const state = valueOr(result, emptyRosterState)
  const loaded = AsyncResult.isSuccess(result) && state.cursor !== undefined
  return useMemo(() => ({ state, loaded, botById: (id) => (id === undefined ? undefined : state.bots.get(id as BotId)) }), [state, loaded])
}
