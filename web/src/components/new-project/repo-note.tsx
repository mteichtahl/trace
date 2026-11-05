/**
 * New project's Repository step, under the repository's name: whether it is free (a new one) or there (an existing
 * one), whose it is when taken (a retired project keeps its repository: test-esp32 log #78), and a free name to use.
 */
import { Button } from '@/components/ui/button'
import type { NewProjectDraft } from '@/lib/types-s1'
import { type RepoCheck, repoOf } from './rules'

export function RepoNote({ d, check, failed, onUse }: { d: NewProjectDraft; check: RepoCheck | undefined; failed?: boolean; onUse: (name: string) => void }) {
  const repo = repoOf(d)
  if (failed) return <p className="-mt-3 text-xs text-muted-foreground">trace could not check {repo} just now; it checks again when you press Create.</p>
  if (!check) return <p className="-mt-3 text-xs text-muted-foreground">Checking {repo} on GitHub…</p>
  const free = check.suggestion?.split('/')[1]
  const use = free && check.suggestion?.split('/')[0]?.toLowerCase() === d.repository.owner.toLowerCase()
    ? <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onUse(free)}>Use {free}</Button>
    : null
  if (check.project?.retired) {
    return (
      <div className="-mt-3 space-y-1 text-xs text-destructive" role="status">
        <p>{check.text} Restore it from Admin, Retired projects to carry on with it, or choose another name.</p>
        {use}
      </div>
    )
  }
  if (d.repository.mode === 'new') {
    if (check.exists === true) {
      return (
        <div className="-mt-3 space-y-1 text-xs text-destructive" role="status">
          <p>{check.text} Choose another name, or choose An existing repository to put this one under trace.</p>
          {use}
        </div>
      )
    }
    if (check.exists === null) return <p className="-mt-3 text-xs text-muted-foreground">GitHub could not say whether {repo} exists; trace checks again when you press Create.</p>
    return <p className="-mt-3 text-xs text-verified">✓ {repo} is free on GitHub</p>
  }
  if (check.exists === false) return <p className="-mt-3 text-xs text-destructive" role="status">trace cannot find {repo} on GitHub. Check the owner and name, and that trace's GitHub access includes it.</p>
  return <p className="-mt-3 text-xs text-verified">✓ {repo} is on GitHub{check.project ? `: it holds the project ${check.project.name ?? repo}` : ''}</p>
}
