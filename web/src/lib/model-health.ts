/**
 * Whether the agents' model answers, from how their newest jobs ended (potroller-carrier-m20: every job failed in
 * eight seconds on the model call while Admin › Installation showed every line healthy). The runtime puts plain words
 * in front of such an error (src/core/model-errors.ts explainModelError: "trace could not reach its model: …"); this
 * reads them back. No call to AWS: the jobs are the evidence.
 *
 *   failing   the newest ended jobs (at least one, at most LOOK) all stopped on the model, and none succeeded since
 *   verified  a job succeeded more recently than any model failure
 *   idle      no job has ended yet
 */
import type { RunSummary } from './types'

export const MODEL_FAILED = /^trace could not reach its model: ([\s\S]*?)(?: \(The model said: [\s\S]*\))?$/
/** How many of the newest ended jobs are looked at. */
const LOOK = 5

export interface ModelHealth { status: 'verified' | 'failing' | 'idle'; word: string; detail?: string; todo?: string }


/** The agents' model's health from every project's jobs (jobs.list `jobs`). Pure. */
export function modelHealth(jobs: readonly RunSummary[]): ModelHealth {
  const ended = jobs.filter((j) => (j.state === 'done' || j.state === 'failed') && j.endedAt).sort((a, b) => Date.parse(b.endedAt as string) - Date.parse(a.endedAt as string)).slice(0, LOOK)
  if (!ended.length) return { status: 'idle', word: 'No jobs yet', detail: 'Nothing has run yet, so nothing says whether the model answers.' }
  const said = ended.map((j) => (j.state === 'failed' ? MODEL_FAILED.exec(j.error ?? '') : null))
  if (!said[0]) return { status: 'verified', word: 'Answering', detail: 'The newest job reached the model.' }
  const n = said.findIndex((m) => !m)
  const count = n < 0 ? said.length : n
  // "the AWS account's … does not allow the model. An admin runs the installer again …."
  const [what, ...todo] = (said[0][1] ?? '').split(/(?<=\.)\s+/)
  return {
    status: 'failing', word: 'Not answering',
    detail: `The last ${count === 1 ? 'job' : `${count} jobs`} stopped at once: ${(what ?? '').replace(/\.$/, '')}. No agent can work, and trace cannot reply in chat, until this is mended.`,
    todo: todo.join(' ') || 'Run the installer again: its checks say what the model needs.',
  }
}
