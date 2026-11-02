import { Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { checkGithub } from '../actions.js'
import { ghCurrent, githubTokenError, githubTokenNote } from '../model.js'
import { Code, CopyButton, Ext, Help, Note, Steps, TextField } from '../parts.js'
import { update, useStore } from '../store.js'

/** What a fine-grained token needs (README "The GitHub token"); Metadata: read comes with any of them. */
const FINE_GRAINED = [
  ['Actions', 'Read and write'], ['Administration', 'Read and write'], ['Commit statuses', 'Read and write'], ['Contents', 'Read and write'],
  ['Issues', 'Read and write'], ['Pull requests', 'Read and write'], ['Secrets', 'Read and write'], ['Variables', 'Read and write'],
  ['Webhooks', 'Read and write'], ['Workflows', 'Read and write'], ['Checks', 'Read-only'], ['Deployments', 'Read-only'],
] as const

export function GithubStep() {
  const s = useStore()
  const typed = githubTokenError(s.github.token)
  const fresh = ghCurrent(s)
  const gh = fresh ? s.gh : null
  const note = githubTokenNote(s.github.token)
  const own = gh?.self
  return (
    <>
      <div className="grid gap-3">
        <TextField id="github.token" label="GitHub token" secret mono autoFocus value={s.github.token} placeholder="github_pat_… or ghp_…"
          error={s.touched.has('github.token') || s.tried.has('github') ? typed : ''}
          hint={note || 'Paste it: it is checked with GitHub as soon as it is complete. It is held in memory only.'}
          onChange={(v) => update((x) => { x.github.token = v; x.ghError = '' })} />
        {typed ? null : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {s.ghBusy || !fresh && !s.ghError ? <><Loader2 className="size-3.5 animate-spin text-primary" />Checking with GitHub…</> : null}
            {!s.ghBusy && (fresh || s.ghError) ? <Button variant="ghost" size="xs" onClick={() => void checkGithub()}><RefreshCw />Check again</Button> : null}
          </div>
        )}
      </div>

      {s.ghError ? <Note tone="fail" title="GitHub refused the token">{s.ghError}</Note> : null}
      {gh ? (
        <Note tone="ok" title={<>Signed in to GitHub as <span className="font-mono">{gh.login}</span>{gh.name ? ` (${gh.name})` : ''}</>}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{gh.kind} token</Badge>
            <Badge variant="secondary">{gh.repos.length} repositor{gh.repos.length === 1 ? 'y' : 'ies'} visible</Badge>
            {gh.scopes.length ? <Badge variant="outline">scopes: {gh.scopes.join(', ')}</Badge> : null}
          </div>
          {gh.repos.length === 0 ? <p>It sees no repositories: give it access to the repositories trace should look after (or create new ones on the Projects step).</p> : null}
          {own ? <p>{own.ok ? `It can configure trace's own repository (${own.repo}), so trace's own build can run on AWS too.` : `It can't configure trace's own repository (${own.repo}); trace's own build stays on GitHub's runners. That is fine.`}</p> : null}
        </Note>
      ) : null}
      {gh?.warnings.map((w) => <Note key={w} tone="warn">{w}</Note>)}

      <Help title="How to make the token" defaultOpen={!s.github.token}>
        <p><strong>Fine-grained token (recommended).</strong> It can be limited to the repositories trace looks after.</p>
        <Steps>
          {[
            <>Open <Ext href="https://github.com/settings/personal-access-tokens/new">New fine-grained token</Ext> on GitHub, signed in as the owner of your repositories.</>,
            <>Name it <Code>trace</Code>, choose an expiry (trace needs it for as long as it runs), and set <strong>Resource owner</strong> to the account or organisation that owns the repositories.</>,
            <><strong>Repository access:</strong> all repositories, or only the ones trace looks after (include any you will create here: choose all if unsure).</>,
            <>
              <strong>Repository permissions</strong>, each <strong>Read and write</strong>:
              <div className="mt-1.5 flex flex-wrap gap-1">{FINE_GRAINED.map(([n]) => <Badge key={n} variant="outline" className="font-normal">{n}</Badge>)}</div>
              <div className="mt-1.5"><CopyButton label="Copy the list" text={FINE_GRAINED.map(([n, a]) => `${n}: ${a}`).join('\n')} /></div>
            </>,
            <><strong>Account permissions:</strong> Email addresses, <strong>Read-only</strong> (your email becomes the first administrator's sign-in).</>,
            <>Generate the token, copy it (GitHub shows it once) and paste it above.</>,
          ]}
        </Steps>
        <p><strong>Classic token.</strong> Simpler but reaches everything you can: <Ext href="https://github.com/settings/tokens/new?scopes=repo,workflow,user:email&description=trace">New classic token with repo, workflow and user:email</Ext>.</p>
        <p><strong>Organisation with single sign-on?</strong> After making the token, choose <strong>Configure SSO</strong> next to it and authorise the organisation.</p>
      </Help>
    </>
  )
}
