/**
 * Build jobs and their steps by a name a person can read (potroller-carrier-m20). The checks of a change and the
 * installation update's progress showed the workflow's own names: "check", "automerge", "open-pr",
 * "python-bridge › Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "typescript › step 8". The names
 * still identify the job everywhere they are matched; only what is drawn changes. Pure.
 */

/** The jobs of a project's workflows and of trace's own, as words. */
const JOBS: Readonly<Record<string, string>> = {
  check: 'The design\'s checks',
  automerge: 'Applying it once the checks pass',
  'open-pr': 'Opening the change',
  'tests pass': 'Every check passed',
  typescript: 'trace\'s own tests',
  'python-bridge': 'The design tools\' tests',
  'web-and-build': 'The web app builds',
  smoke: 'The screens load',
  'smoke-live': 'The live installation answers',
  'update-installation': 'Updating the installation',
}

/** A job's name as words: its own when it is one trace knows, else as it is. */
export function jobLabel(name: string): string {
  const key = name.trim().toLowerCase()
  return JOBS[key] ?? JOBS[key.split(' / ').pop() ?? ''] ?? name
}

/** A step that only gets the job ready: fetching the code, setting up a language, a cache, credentials or an upload. */
const SETUP = /^(run |set up |post |pre )?(actions\/(checkout|setup-[a-z]+|cache|upload-artifact|download-artifact)|aws-actions\/configure-aws-credentials)\b/i

/** A step's name as words: "Getting ready" for a setup step, "Step 8" for one with no name, else as its author wrote it. */
export function stepLabel(step: string): string {
  const s = step.trim()
  if (SETUP.test(s) || /@[0-9a-f]{40}$/i.test(s)) return 'Getting ready'
  const n = /^step (\d+)$/i.exec(s)
  if (n) return `Step ${n[1]}`
  return s.replace(/^Run /, '')
}

/** "python-bridge › Run actions/checkout@3d3c…" as "The design tools' tests › Getting ready". */
export function progressLabel(name: string): string {
  const [job, ...step] = name.split(' › ')
  return step.length ? `${jobLabel(job ?? '')} › ${stepLabel(step.join(' › '))}` : jobLabel(name)
}
