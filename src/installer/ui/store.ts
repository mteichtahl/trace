/**
 * The page's one store: the model's state (model.ts), changed only through update(), which redraws whatever reads it.
 * The state is a plain mutable object (it holds Maps and Sets); the version number is what React watches.
 */
import { useSyncExternalStore } from 'react'
import { type State, initialState } from './model.js'

const state: State = initialState()
let version = 0
const listeners = new Set<() => void>()

export const get = (): State => state

export function update(fn: (s: State) => void): void {
  fn(state)
  version++
  for (const l of listeners) l()
}

/** Hear every change (the page's automatic checks: actions.ts startAutoChecks). */
export const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** The state, redrawing the caller whenever it changes. */
export function useStore(): State {
  useSyncExternalStore(subscribe, () => version)
  return state
}
