/**
 * The prompt for the hourly cloud worker: one Claude scheduled task that looks after every project at once.
 *
 * Each project's own trace-worker workflow reacts within minutes to what breaks; this is the backstop that runs even
 * when a workflow could not start (no runner, a token expired, an event GitHub never sent), and the one place a person
 * hears from when something needs them across all projects. It honours the same claim and attempt markers as the
 * workflows, so the two never work on one item together.
 *
 *   tracectl worker-prompt                    every project in the central registry
 *   tracectl worker-prompt owner/a owner/b    just these
 *
 * Its text is the prompt catalog's (src/prompts/catalog.ts): cloudworker.prompt (editable) and cloudworker.guardrails
 * (locked, last). It spans projects, so only installation overrides apply.
 */
import { type Composed, Composer, type Layers, NO_LAYERS } from '../prompts/resolve.js'

export function composeCloudWorker(repos: readonly string[], layers: Layers = NO_LAYERS): Composed {
  const p = new Composer(layers)
  const listed = repos.length ? repos.map((r) => `- ${r}`) : [p.text('cloudworker.none')]
  return p.add('cloudworker.prompt', { repositories: listed }).add('cloudworker.guardrails').done()
}

/** The prompt text: the catalog's cloudworker.prompt (editable; installation overrides apply) and its guardrails. */
export function workerPrompt(repos: readonly string[], layers: Layers = NO_LAYERS): string {
  return `${composeCloudWorker(repos, layers).text}\n`
}
