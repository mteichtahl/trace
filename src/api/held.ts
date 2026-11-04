/** The refusal a paused or retired project gives (src/core/lifecycle.ts), shared by the actions that check it. */
import { type Lifecycle, held, lifecycleOf } from '../core/lifecycle.js'
import { ActionError } from './action-kit.js'

/** The words a person reads when a held project refuses something. */
export function heldWords(l: Lifecycle): string {
  if (l.retired) return `This project is retired (by ${l.retired.by}), so nothing about it can change. An admin can restore it.`
  const p = l.paused
  return `This project is paused (by ${p?.by ?? 'someone'}${p?.reason ? `: ${p.reason}` : ''}), so nothing can change and no work starts. Resume it to carry on.`
}

/** For need 'job' actions, whose project comes from the job id: refuse ops that start or change work when held. */
export async function assertNotHeld(repo: string): Promise<void> {
  const l = await lifecycleOf(repo)
  if (held(l)) throw new ActionError(heldWords(l))
}

