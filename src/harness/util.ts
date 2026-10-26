import type { TraceConfig } from '../core/config.js'
import type { GitHub } from './types.js'

type LabelKey = keyof TraceConfig['labels']

const LABEL_STYLE: Record<LabelKey, readonly [string, string]> = {
  hold: ['fbca04', 'trace: do not merge this PR automatically'],
  ci_red: ['b60205', 'trace: the build failed for real; the worker fixes it'],
  agent_fix: ['5319e7', 'trace: work for the worker (fix and push)'],
  deploy: ['0e8a16', 'trace: a deploy request'],
  deploy_held: ['d93f0b', 'trace: a deploy held for a person'],
}

/** Create the label cfg.labels[key] if the repository lacks it. Returns its name. */
export async function ensureLabel(github: GitHub, owner: string, repo: string, cfg: TraceConfig, key: LabelKey): Promise<string> {
  const name = cfg.labels[key]
  const [color, description] = LABEL_STYLE[key]
  try {
    await github.rest.issues.getLabel({ owner, repo, name })
  } catch {
    await github.rest.issues.createLabel({ owner, repo, name, color, description }).catch(() => undefined)
  }
  return name
}

export interface CommentLike { body?: string | null | undefined }

export async function comments(github: GitHub, owner: string, repo: string, issue_number: number): Promise<CommentLike[]> {
  return github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 })
}

/** Comment once: skipped when a comment already carries `marker` (a hidden HTML comment). */
export async function commentOnce(github: GitHub, owner: string, repo: string, n: number, marker: string, body: string): Promise<boolean> {
  if ((await comments(github, owner, repo, n)).some((c) => (c.body ?? '').includes(marker))) return false
  await github.rest.issues.createComment({ owner, repo, issue_number: n, body: `${body}\n${marker}` })
  return true
}

/** Branch filters: `*` within a segment, `**` across segments. */
export function globMatch(glob: string, s: string): boolean {
  const esc = (x: string): string => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const re = '^' + glob.split('**').map((part) => part.split('*').map(esc).join('[^/]*')).join('.*') + '$'
  return new RegExp(re).test(s)
}

/** The head sha of the build workflow's newest successful push/dispatch run on the default branch. */
export async function newestPassing(github: GitHub, owner: string, repo: string, cfg: TraceConfig): Promise<string | undefined> {
  const runs = (await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: cfg.build.workflow, branch: cfg.branch, status: 'success', per_page: 20 })).data.workflow_runs
  return runs.filter((r) => r.event === 'push' || r.event === 'workflow_dispatch')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.head_sha
}
