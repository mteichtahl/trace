# Stay in trace: nothing a person does needs GitHub

The build contract for the "stay in trace" work (proposal approved 3 November 2026). It fixes the interfaces so the
pieces can be built side by side. Where this file and [guided-flow.md](guided-flow.md) disagree, this file wins for
what it adds; everything guided-flow.md decided (the trace-change rule, accept what was looked at, what is posted as
trace's account, GitHub's allowance) still holds.

## Why

The guided flow moved a specialist's change into the app. Six things still sent a person to GitHub:

1. **Their own edits.** settings.set, prompts.set (project), journey.snapshot (a release's copy of the record),
   projects.create (the onboarding and workflow-refresh pull requests) each make a pull request that "waits for a
   person" because it touches `.trace/**` or `.github/**`. The app never showed them.
2. **Deploys.** `/approve <sha>` and `/reject` are comments on a GitHub issue; a rollback is a workflow button.
3. **A broken build and stuck work.** ci-doctor explains a failed build in a GitHub issue; work trace gave up on is
   handed to `worker.escalate_to` on GitHub; asking the agents for a fix means opening an `agent-fix` issue.
4. **Finishing a schematic.** The person edits trace's draft in KiCad and pushes with git.
5. **A repository rule.** A repository that requires an approving review makes Accept fail with "change the rule on
   GitHub".
6. **Links and notes.** "View on GitHub" on a change and the prompts screen, "Change it in the repository" for
   CLAUDE.md, "The update on GitHub" for the installation update, "use View on GitHub to download" for a binary file,
   "Waiting on GitHub before it can be accepted".

## Decisions (Marc, 3 November 2026)

- **A. An admin's own edit in the app applies once its checks pass.** It is recorded in the decisions log with their
  name. An edit by someone who is not an admin (a Contributor's setting or project prompt) waits for an admin, who is
  not its author, to accept it in the app. An agent's change to a protected path stays held, as before: the hold is
  there for agents.
- **B. A deploy is approved in trace, and the deploy workflow checks that approval.** The approval is a record only
  the API can write (`projects/<slug>/journey/deploys/`, inside the journey's folder: denied to the agents' and the workflows' roles), naming
  the person, the exact commit and an expiry. trace starts the deploy workflow with the record's key; the workflow reads
  the record with its own AWS role before deploying. An agent can never approve: it cannot write the record, and a key
  that names no record deploys nothing.
- **C. "View on GitHub" is for admins only, inside a "More" menu.** Nobody else is ever shown a GitHub link. Error text
  about GitHub's own rules may still name GitHub.

## 1. App edits (`src/core/app-edits.ts`, `src/api/actions-edits.ts`)

### The record

Every edit the API commits on a branch of its own is recorded in the central bucket, at
`projects/<slug>/journey/edits/<branch with / as ~>.json`: inside the journey's folder, which the API already writes
with conditional puts and the agents' and workflows' roles may only read (`PEOPLE_RECORDS`, src/infra/project.ts). No
IAM changes: a new prefix would push the roles' inline policies over their size.

```ts
type EditKind = 'setting' | 'prompt' | 'release' | 'join' | 'workflows' | 'handin'
interface AppEdit {
  repo: string; branch: string; kind: EditKind
  title: string            // "Boards per build: 5 → 10", "Review prompt, version 4", "Hand in: power.kicad_sch"
  by: string               // label(principal): the email, for the decisions log
  by_sub: string           // who made it, matched (never shown)
  by_name: string          // their name in the user pool, else their initials: what the app shows
  applies: 'auto' | 'review'   // auto: an admin's own edit, a join/workflows edit, a hand-in; review: waits for an admin
  commit: string           // the head commit trace wrote: the change is this edit only while the branch's head is it
  number: number | null    // its pull request, once opened (the API opens it at once: GitHubApi.openPull)
  at: string               // ISO time made
  redo: RedoSpec | null    // how to make it again on a newer default branch (behind or in conflict); null: cannot
}
type RedoSpec =
  | { op: 'setting'; key: string; value?: unknown; unset?: boolean }
  | { op: 'prompt'; write: PromptWrite }
  | { op: 'release'; why: string }
```

`AppEditStore` (over `storeAt(ctx, PROJECTS_PREFIX)`): `put(edit)`, `get(repo, branch)`, `list(repo)`,
`remove(repo, branch)`. Plain JSON objects; a lost race is harmless (the newest put wins, and each branch is one
person's edit).

### Which pull requests are edits

A pull request is an edit only when all hold (`src/api/changes.ts editOf`): its head branch lives in the project's
repository (not a fork); an edit is recorded for that branch; and its head commit **is** the recorded `commit`. Anyone
who can push may push to a `trace/…` branch; a pushed commit makes it no longer trace's edit, so it is not listed, never
applied and never accepted (it shows nowhere in the app; trace's own redo rewrites `commit`). The branch prefix and the
author are not checked: the commit is.

### Where they show

`changes.list` and `change.get` list edits beside the specialists' changes. `ChangeSummary` gains:

```ts
kind: 'work' | EditKind              // 'work': a specialist's change (everything guided-flow.md built)
by_name?: string                     // edits: who made it
applies?: 'auto' | 'review'          // edits
```

`from` for an edit reads "a setting change by Alex L.", "a hand-in by you" (the viewer's own). The verdict and
recommendation rules are the same, with: an `auto` edit whose checks pass is `applying` (a new verdict word, pill
"Applying"); a `join` or `workflows` edit may apply with no checks at all when GitHub says it can merge (its content is
trace's own scaffold, fixed by the commit, and a repository joining has no build yet). `change.ask` refuses an edit
("Ask Alex L. to change it, or discard it."); `change.discard` is open to its author and to admins and also removes the
record.

`may_accept` for a `review` edit: the viewer is an admin and is not its author ("You made this change: another admin
accepts it."). An `auto` edit never needs Accept; its page says "trace applies it once its checks pass".

The inbox gains review items for `review` edits (kind `review`, to the change's page), shown to admins only.

### Applying (`applyEdits(ctx, repo)`)

For each recorded edit with an open pull request: read its status fresh. Then:

- merged or closed on GitHub → remove the record;
- head moved (not `commit`) → leave it (it is not trace's edit any more);
- `auto` and ready (or a join/workflows edit that can merge) → merge it with the head sha, take the hold label off,
  record decision `change.applied` ("trace applied the setting change Alex L. made: Boards per build 5 → 10"), remove the
  record;
- `behind` or `dirty`, with a `redo` → make it again: reset the branch to the default branch's head
  (`GitHubApi.resetBranch`, force), commit the edit again from that default branch, update `commit`; the pull request
  stays the same number;
- otherwise wait.

What calls it: `hook.apply { repo }` (backend only, src/api/actions-hooks.ts), which the hooks function calls after
`hook.members` for every accepted delivery of a project (debounced with the live event: once per window); and
`changes.list`, at most once every 30 s per repository per container (a fallback when hooks are not set up). Never a
timer.

### Writers

settings.set, prompts.set (project), journey.snapshot and the release cut (snapshotJourney), projects.create's
onboarding of an existing repository (`join`, branch `trace/onboard`) and workflow refresh (`workflows`, branch
`trace/refresh`), and design.handin (`handin`) each: commit, open the pull request (`openPull`; one already open for the
branch is reused), put the record, and answer `{ …, change: number }` so the app can open it. `applies` is `auto` when
the person is an admin, or the kind is `join`, `workflows` or `handin`; else `review`.

## 2. Deploys (`src/api/actions-deploys.ts`, `src/harness/deploy.ts`, `templates/workflows/trace-deploy.yml`)

### API

| Action | Needs | Args | Answer |
| --- | --- | --- | --- |
| `deploys.get` | read | `{ repo }` | `DeploysView` |
| `deploy.approve` | write + allowed | `{ repo, sha }` (40 hex, the commit the person was shown) | `{ started: true, approval: string, next: string }` |
| `deploy.skip` | write + allowed | `{ repo, reason }` | `{ skipped: true }` |
| `deploy.rollback` | write + allowed | `{ repo, to }` (40 hex: a commit that ran before) | `{ started: true, approval }` |

"Allowed": a trace admin, or a person whose email is in the project setting `deploy.people` (a list of emails, default
empty). Connected systems: none of the three writes.

```ts
interface DeploysView {
  enabled: boolean; environment: string; url: string | null; auto: boolean
  may_approve: boolean                       // this person, now
  running: { sha: string; at: string | null } | null          // what the environment runs (the newest deployed record)
  request: {                                 // the open deploy request, or null
    sha: string; opened_at: string; held: boolean; held_reasons: string[]
    commits: { sha: string; subject: string }[]                 // since the running one, newest first, at most 30
    build_passed: boolean
  } | null
  in_progress: { sha: string; started_at: string; by: string; step: string | null } | null
  recent: { sha: string; result: 'deployed' | 'failed' | 'rolled_back' | 'skipped'; at: string; by: string }[]  // last 10
  recommendation: { verdict: 'deploy' | 'wait' | 'none'; why: string }
}
```

The request and results are read from GitHub (the deploy issues the workflow opened, `github-actions[bot]` only, as
`guard` trusts them) and from the decisions log; the app never sees an issue.

`deploy.approve`: refuses a sha that is not the open request's, whose build has not passed, or that is not the newest
passing commit (the same rules as `approve` in the harness). Writes the approval:

```ts
// projects/<slug>/journey/deploys/<sha>-<base36 time>.json, conditional put (If-None-Match)
interface DeployApproval { repo: string; sha: string; action: 'deploy' | 'rollback'; by: string; by_sub: string
  by_name: string; at: string; expires: string /* at + 2 h */; issue: number | null }
```

records decision `deploy.approved` (or `deploy.rollback`), then starts `trace-deploy.yml` on the default branch with
`workflow_dispatch` inputs `{ approval: <key>, sha }` (`GitHubApi.dispatchWorkflow` gains `inputs`).
`deploy.skip` closes the request issue as not planned with the reason quoted (neutralised) and records `deploy.skipped`.

### Workflow

`workflow_dispatch` gains inputs `approval` and `sha` (both optional: a dispatch without them is today's "Run
workflow"). The `approve` job, when `inputs.approval` is set: takes AWS credentials with `TRACE_AWS_ROLE` (OIDC,
`id-token: write`), and the harness task `deploy-approve` reads the record (`TRACE_HOME`'s bucket,
`projects/<slug>/journey/deploys/<key>`) instead of judging a GitHub login. It deploys only when: the record exists, its `repo`
is this repository, its `sha` equals `inputs.sha`, it has not expired, and the build/branch/newest checks of today pass.
`by` is the record's `by_name`. Reports name the person (`Deployed a41c9e2 to bench, approved in trace by Alex L.`).
The GitHub-login path (`/approve` comments) still works for people who use it.

The record lives under the journey's folder: the API role already writes there with conditional puts only, and the
agents' and workflows' roles are denied writing it. No IAM change.

## 3. A broken build, stuck work, asking for a fix (`src/api/actions-health.ts`)

| Action | Needs | Args | Answer |
| --- | --- | --- | --- |
| `health.get` | read | `{ repo }` | `HealthView` |
| `health.log` | read | `{ repo, job_id }` | `{ name, text, truncated }`: one failing job's log, its last 200 KB |

```ts
interface HealthView {
  build: { state: 'passing' | 'failing' | 'running' | 'none'; sha: string | null; at: string | null
    failing: { job_id: number; name: string; step: string | null; tail: string /* last 40 lines */ }[]
    why: string | null              // plain words: ci-doctor's judgement when there is one, else the failing step
    fixing: { job_id: string | null; attempt: number; of: number } | null }   // trace's work item on it
  asks: { number: number; title: string; state: 'waiting' | 'working' | 'stuck'; job_id: string | null; opened_at: string }[]
}
```

`asks`: the open `agent-fix` items, from any source, each with the job working on it. "Ask trace to fix something" is
the existing `task` action (a free-form task); nothing opens an issue.

Stuck work: where the worker hands an item to `worker.escalate_to` (src/harness/worker.ts, after
`worker.max_attempts`), it also records a stuck note in the agents' facts (`src/core/agent-facts.ts`, as a specialist
does), so it is a "Needs you" item (inbox kind `stuck`) with what was tried and the recommendation. The GitHub mention
stays for people who read GitHub.

### Conflicts (`src/api/conflicts.ts`, 3 November 2026)

Merge conflicts used to stall: every accepted change moves the default branch, GitHub sends nothing when that leaves
other open changes in conflict, and for a few seconds after the push it reads every pull request as `unknown`. The
pick and update queue started by that push read `unknown`, skipped the change, and the conflict sat until the hourly
safety net (or until the worker gave up), looking as if it needed a person. Now:

- **Settled before judged** (`src/harness/mergeable.ts`): `worker-pick` and `update-queue` read every candidate once
  (which starts GitHub's work), then read again only the ones still `unknown`, 3 s apart, up to 5 rounds.
- **The app is told** (`src/web/hooks.ts`): the webhook takes `push` too (`HOOK_EVENTS`; `tracectl update` re-registers
  it). A push to the project's default branch makes the hooks function ask the API `hook.conflicts { repo }` (backend
  only) beside the usual debounce. People on the project get `record.changed { kind: 'change', conflicts, remade,
  resolving }` (numbers only) and the app says, wherever they are, which changes trace is bringing up to date and which
  need them (`conflictNotice`, web/src/lib/live.ts).
- **The app resolves** (`resolveConflicts`): it waits for GitHub to settle (4 rounds, 2.5 s apart), remakes each edit
  made in trace on the newest design (`applyEdits`, its one-run-per-repository lock), merges the record itself into
  each change of trace's own whose only conflict is the record (below), and starts the worker once
  (`trace-worker.yml`, `workflow_dispatch`) for every other change in conflict. The worker merges the default branch in,
  never a rebase or a force-push. An edit that cannot be made again is left: the person discards it.
- **The record merged in seconds** (`src/api/record-merge.ts`, 7 November 2026, test-esp32 log #191, #213). Every
  specialist's change records its runs in `.trace/project.db`, so a change cut before the one accepted just before it
  always conflicted there, and "Bring it up to date" started an agent job of minutes to merge rows that never
  overlapped. Now, when the files both sides changed since their common ancestor are the record alone, the API merges
  it row by row (`mergeRows`, src/core/dbmerge.ts: a row is named by its primary key; a row both sides changed to
  different results, a table one side removed or whose columns differ, or a row a cascade would take with it, is a
  conflict and nothing is merged) and writes a merge commit through the Git Data API: the change's own files on the
  default branch's tree with the merged record, parents the change and the default branch, the branch moved only if
  it is still where it was read (never forced). Only trace's own branches (`worker.own_branch_prefix`, or `trace/`)
  in the repository itself. Anything else goes to the worker as before. A change opened already in conflict (a
  `pull_request` delivery, opened or reopened) asks `hook.conflicts` too: no push to the default branch follows it.
- **Bring it up to date**: `change.resolve { repo, number }` (write). A change in conflict's decision bar leads with
  "Bring it up to date" instead of Accept. It does the same for that one change and passes the workflow input `retry`:
  the pick leaves a `trace-retry` marker, the attempts before it no longer count (so work the worker gave up on goes
  again), and a person's branch is worked on without the idle wait (asking from trace is the go-ahead). A project whose
  workflow predates the input is started without it (GitHub refuses unknown inputs with 422), and the answer says an
  admin refreshes the workflows. Recorded as decision `change.resolve`.

## 4. Getting and handing in design files (`design.handin`)

- **Get the design files**: the web app zips the project's KiCad files itself (`files.list` for the paths under the
  KiCad project's folder, `files.url` per file) with JSZip, and saves the zip. No new action.
- **Hand in my edits**: `design.handin { repo, files: { path, base64 }[], note }`, write. Paths: inside the repository,
  existing KiCad files or new ones beside them (`.kicad_sch`, `.kicad_pcb`, `.kicad_pro`, `.kicad_sym`, `.kicad_mod`,
  `.kicad_dru`, `fp-lib-table`, `sym-lib-table`), never `.trace/**`, `.github/**` or another protected path. At most
  20 files, 3 MB each and 4 MB together (the backend's request limit); a file the same as the default branch's is left
  out ("Same as the design"). Commits them as one commit (`GitHubApi.commitFiles`: blobs, a tree, a commit, a branch
  `trace/handin-<slug>-<time>`), opens the pull request and records the edit (`handin`, applies `auto`). Answers
  `{ change, changed: string[], same: string[] }`. Every push is re-checked as before, and the change page shows what
  the person changed from the draft (the existing schematic diff).

## 5. Fixing the repository rule (`repo.rules.fix`)

`repo.rules.fix { repo }`, admin: puts the default branch's rules back to what the guided flow expects. The "trace"
ruleset is created if missing or updated to `required_approving_review_count: 0` and `require_code_owner_review: false`
(src/installer/onboard-api.ts shares the rule with it: `traceRuleset`). Classic branch protection's required reviews
on the default branch are removed. Another ruleset that requires a review is reported by name, not changed ("The
'release' ruleset also requires a review: an admin of the repository changes it, or removes it."). Records decision
`repo.rules.fixed`. Answers `{ done: string[], left: string[] }`.

`ChangeDetail` gains `rule_blocks: boolean`: GitHub says blocked with every check passed (the review rule). The change
page then shows "This repository asks for a review trace cannot give" with "Fix the rule and accept" (admins), which
calls `repo.rules.fix` and then `change.accept`. `mergeRefusal`'s words drop "on GitHub (Settings, …)" for "an admin can
fix the rule from this change's page".

## 6. Small links and words

- **Installation update**: `project.agent`'s `update` gains `steps: { name, state: 'done' | 'running' | 'waiting' |
  'failed' }[]` and `failed_log: string | null` (the failing step's last 40 lines), read from the run's jobs. The app
  shows the steps and, on failure, the log. `url` stays, for admins' "More" menu only.
- **Prompts**: a pending project override links to its change in the app (`/p/<id>/changes/<number>`, from the edit
  record: `prompts.get` answers `pending.change`). CLAUDE.md: "Change it" opens the file in the app's editor, and saving
  is `files.edit { repo, path: 'CLAUDE.md', text, note }` (write; text files only, at most 1 MB; protected paths refused
  except CLAUDE.md; recorded as a `setting`-like edit of kind `prompt`).
- **A change's binary or picture file**: "Download before" and "Download after" through `files.url` at the change's
  base and head refs (it already takes `commit`).
- **Words**: "Waiting on GitHub before it can be accepted" → what it waits for ("Its checks are still running",
  "GitHub is still working out whether it can be merged").
- **Links**: every "View on GitHub", "Open on GitHub", "The update on GitHub" moves into a "More" menu shown to admins
  only (`MoreForAdmins` in web/src/components/more-for-admins.tsx).
- **Unused**: web/src/components/project/github-waits.tsx (and its test) is removed.

## Tests

Each piece adds tests beside its files, in the repository's style (vitest, fakes of `GitHubApi` and the stores):
the edit rule (a pushed commit is not an edit; a fork is not), applying (merge, redo, record removed), the deploy
approval (expired, wrong sha, wrong repo, missing record all deploy nothing), handin's path and size rules, the rule fix
(trace's ruleset updated, another ruleset reported not changed), and the web screens with the mock API (web/src/mock).

## After the security review (3 November 2026)

- **An edit changes only its own files.** Each edit records the files it may change (`paths`; a setting, a project
  prompt and a release copy: `.trace/project.db` only). A pull request that changes anything else is never applied or
  accepted (`editStray`): someone pushed a commit to the branch between trace making it and trace committing on it.
  An edit whose files cannot be read is not accepted either.
- **A review edit is held** (the hold label) when it is opened, so the harness's automerge never merges it on passing
  checks alone, whatever its path.
- **Joining trace records only the commit onboarding pushed** (`ApiOnboardResult.commit`); a branch that moved since is
  not recorded, so it is never applied without checks.
- **A deploy approval is used once, and only the newest deploys.** The workflow marks it used
  (`projects/<slug>/journey-agent/deploy-used/<name>`, If-None-Match, which the workflows' role may write) after every
  other check passed; an older approval, or one already used, deploys nothing. Approvals last 30 minutes.
- **Code owners' review stays.** When `worker.escalate_to` is set, trace's rule keeps requiring code owners' review: it is
  what GitHub itself enforces against an agent merging a change to the paths that steer trace past the hold label.
  `repo.rules.fix` removes approving reviews only, never that one. Open decision: such projects' edits to `.trace/**`
  still need that review on GitHub, until the agents get a token without merge rights.
- **The 6 MB body is for `design.handin` only**, judged by the action the parsed body names.
- Not changed: trace applies an admin's own edit even though the hold label is on it (every edit to `.trace/**` carries
  the label from the harness, so honouring it would stop every one); a repository's own ruleset named "trace" is taken
  to be trace's.
