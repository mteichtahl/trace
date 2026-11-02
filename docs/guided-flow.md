# Guided flow: changes in the app, and always knowing where you are

The build contract for the guided-flow work (proposal approved 2 November 2026). It fixes the interfaces so the three
pieces (API, live events, web) can be built side by side. Where this file and [ui-design.md](ui-design.md) disagree on
what a person sees, this file wins for the screens it names; where it disagrees with [web-build.md](web-build.md) on
wiring, this file wins for what it adds.

## Why

1. A finished job's work reaches the record only when its pull request is merged, and people had to go to GitHub to
   do that. The app showed "Waiting on GitHub · Open on GitHub".
2. The stage rail named nine stages but not what the current one is for, what is left in it, or who must do it.
3. The next-step card named one action without the recommendation's reason or what happens after.

## Decisions (Marc, 2 November 2026)

- **Who accepts a change:** anyone with the Contributor part on the project (admins are contributors everywhere).
  Reviewers can read changes but not accept, ask or discard. Connected systems can only read.
- **GitHub's review rule:** the repository requires passing checks only. trace records who accepted in the decisions
  log. trace never approves a pull request on GitHub (its account opened it and GitHub refuses self-approval). If a
  repository still requires a review, accepting fails with plain words saying so and how to change the rule.
- **Words:** a pull request a trace job opened is a **change** everywhere people read. "Pull request" appears only in
  the small "View on GitHub" link and in error text about GitHub's own rules.

### Decisions from the security review (2 November 2026)

- **Which pull requests are trace's (the trace-change rule).** A branch name proves nothing (anyone who can push can
  name a branch `claude/…`, and accepting merges it). A pull request is a change only when all of these hold
  (`src/api/changes.ts` traceJob): its head branch lives in the project's repository itself, not a fork; the branch
  starts with the project's `worker.own_branch_prefix` (default `claude/`) and is not the default branch; the newest
  job of the project's index on that branch is a task (hand-offs are tasks) or a work item on that branch of trace's
  own (a ci-red work item that fixed a person's branch made no change); and, when the login trace's agents act as is
  known (the API runtime's `TRACE_AGENT_LOGIN`, else the repository's `TRACE_AGENT_LOGIN` variable the installer sets),
  the pull request was opened by that login. The default branch is never indexed. The rule (default branch, prefix,
  login, hold label) is read once per repository and kept five minutes. `change.ask` also holds the branch to the task
  action's rule (`TaskBranch`, `claude/…`) before it starts a revision job.
- **Accept what was looked at.** `change.accept` takes `head_sha`, the head commit the person was shown (change.get's
  `head.sha`). A change whose head has moved since is refused: "It changed since you looked at it. Look again before
  accepting." GitHub is asked to merge that commit only. Checks trace could not read, or none run at all, are never
  `ready` and never accepted ("trace could not read its checks", "No checks have run on it yet"): a repository without
  a required check calls anything mergeable. (Reading branch protection for required checks would need admin on the
  token; refusing when nothing ran covers it without that.)
- **What is posted as trace's account.** Comments quote the person's note or reason as a Markdown quote, with `<!--`
  and `-->` written as HTML entities (trace's workflows read markers in comments by its account) and a zero-width
  joiner after every `@` (it pings nobody). They name the person by their name in the user pool, else "a person on the
  project (AL)" with their initials: never their email. The decisions log still records the email, as every decision.
- **A revision request's data.** The revision job's request is the person's note; the change's title and what the job
  reported last time follow it, fenced (`<change-title>`, `<earlier-summary>`) as data, not instructions.
- **GitHub's allowance.** Every project shares one token. The API runtime keeps answers 20 s in each container
  (`src/api/github-cache.ts`): the open pull requests per repository; a pull request's status and a commit's check runs
  per head commit; a pull request's files and commits per head commit. A push makes a new head, so the next look
  misses at once. Accepting, asking and discarding forget the repository's answers in that container; accepting reads
  status and checks fresh. `journey.get` and the inbox use the same kept open pull requests. Each principal may make at
  most 60 GitHub-touching change actions a minute (a separate budget from the request limit), with a plain-words
  error saying when to try again. The app's changes list polls no faster than every 60 s while live events are
  connected.

## API runtime actions (`src/api/actions-changes.ts`)

Access is checked first, as for every action. `read` = assigned to the project; `write` = the Contributor part.

| Action | Needs | Args | Answer |
| --- | --- | --- | --- |
| `changes.list` | read | `{ repo }` | `{ repo, changes: ChangeSummary[] }`: the open pull requests a trace job of this project opened (the same branch match as `src/api/inbox-review.ts`), oldest first |
| `change.get` | read | `{ repo, number }` | `ChangeDetail` |
| `change.diff` | read | `{ repo, number, path }` | `{ path, kind, patch: string \| null, before: { ref } \| null, after: { ref } \| null, binary: boolean }` |
| `change.accept` | write | `{ repo, number, head_sha, note? }` (`head_sha`: 40 hex, the head the person was shown) | `{ merged: true, sha, stage, next: string, warning? }`: refuses a head that moved since; merges that commit (the repository's allowed method, squash first), removes the hold label, comments the note as a quote, records decision `change.accepted` (a record that fails after the merge is `warning`, logged: the merge stands) |
| `change.ask` | write | `{ repo, number, note }` (1–4000 chars) | `{ job_id }`: holds the branch to the task action's rule, starts a revision job with the same agent on the same branch, comments the note as a quote ("Asked for changes by <name>: …"), records `change.asked` |
| `change.discard` | write | `{ repo, number, reason }` (1–2000 chars) | `{ closed: true }`: closes it, then comments the reason as a quote (a comment that fails still answers closed, logged), records `change.discarded` |

```ts
interface ChangeSummary {
  number: number; title: string; url: string; draft: boolean; held: boolean
  from: string            // "the schematic specialist" (AGENT_WORDS), or "a trace job"
  job_id: string | null; stage: StageId | null; opened_at: string; updated_at: string
  state: 'open' | 'merged' | 'closed'
  mergeable: string       // GitHub's mergeable_state
  checks: { total; passed; failed; running; skipped; failing: string[] } | null
  verdict: 'ready' | 'checking' | 'failing' | 'conflict' | 'blocked'   // one word for the list's pill
}
interface ChangeDetail extends ChangeSummary {
  summary: string[]       // what trace did, plain bullets: the job's result summary, else the pull request body's
                          // first list, else its commit subjects
  files: { path: string; status: 'added' | 'modified' | 'removed' | 'renamed'; additions: number; deletions: number
           kind: 'schematic' | 'board' | 'parts' | 'text' | 'image' | 'binary' }[]
  checks_list: { name: string; state: 'passed' | 'failed' | 'running' | 'skipped'; summary: string | null }[]
  requirements: string[]  // requirement ids the change names (title, body, commit messages): ["R4", "R7"]
  recommendation: { verdict: 'accept' | 'ask' | 'wait' | 'none'; why: string }
  may_accept: boolean     // this person, now: Contributor part, open, checks read, at least one run, none failing or
                          // running, no conflict
  blockers: string[]      // plain words, when may_accept is false
  base: { ref: string; sha: string }; head: { ref: string; sha: string }
}
```

The recommendation is worked out from facts, never a model: all checks passed and it can merge → accept, naming the
checks and the requirements; a check failing → ask, naming it; checks running, unreadable or none yet → wait; a
conflict → none, "trace will bring it up to date". `change.accept` re-reads the status from GitHub (never a kept copy)
and refuses when the head moved or it is not `may_accept`.

`service-policy.ts`: `changes.list`, `change.get`, `change.diff` are `read`; the other three are not open to
connected systems.

## Journey view additions (`src/core/journey.ts`, `src/core/stage-guides.ts`)

`StageView` gains:

```ts
guide: { purpose: string; you_do: string; trace_does: string; you_get: string; typical_time: string; next: string | null }
steps: { id: string; text: string; owner: 'you' | 'trace' | 'admins' | 'contributors' | 'person'
         state: 'done' | 'now' | 'next' | 'later' | 'waived'; ref: { kind: 'criterion' | 'gate' | 'question' | 'change'; id: string } | null }[]
```

Guides are written per stage, with per-template wording where a stage differs (Prove for firmware is builds and unit
tests, not simulation). Steps come from the stage's gate criteria (owner person → `you` when the viewer may do it,
else `contributors`; trace → `trace`), then one step per gate: "Sign <gate title>", owner `admins` (or `you` for an
admin). `now` is the step the next step points at; `next` is the one after it; done and waived are what they say.

`NextStep` gains `step: { index: number; total: number } | null` (the now-step's place in its stage) and
`after: string | null` (one sentence: what happens once this is done).

`journey.get` adds open changes: each open change becomes a step (owner `you`/`contributors`, ref `change`) placed
before the criteria it would satisfy, else first among the not-done steps. When the next step would be `task` or
`working` and a change is open and ready, the next step becomes kind `review`: "trace finished <title>. Review it and
accept it into the design.", with the change's recommendation and `ref: { kind: 'change', id: String(number) }`. The
inbox `review` item's action becomes "Review the change" with an in-app link (`/p/<id>/changes/<number>`).

### As built (API): additions to the shapes above

All additive; nothing above changed meaning.

- `change.diff`: `before` also carries `path` when the file was renamed (`{ ref, path }`: read the old name at `ref`).
- `journey.get` adds `changes_unavailable: string` when GitHub could not be reached; the changes are then left out
  and the next step is worked out without them. Status is read for the oldest five open changes only; the rest have
  verdict `checking` and are never the `review` next step.
- `NextStep.ref.kind` may be `'change'` (with `kind: 'review'`); its `button` is "Review the change" (or "Read the
  change" for a reviewer), and `recommendation` starts "trace recommends accepting it." followed by the reason.
- The inbox `review` item's `ref` is `{ kind: 'pull', id, url, to }`: `to` is the in-app link
  (`/p/<owner~name>/changes/<number>`), `url` stays GitHub's for "View on GitHub".
- A pull request that is not trace's (the trace-change rule above: a fork's, the default branch's, a person's branch, a
  job that makes no change, another login's) is "no such change" to every `change.*` action, and is not in the inbox.
- Connected systems' MCP tool list describes `changes.list`, `change.get` and `change.diff`.

## Live updates (`src/web/`, `src/infra/`, `src/installer/`)

- A GitHub webhook on each project repository (pull_request, check_run, check_suite, status) posts to
  `POST /api/hooks/github` on the web backend, through CloudFront, which adds a random origin header the function
  checks before anything else. Its HMAC (`X-Hub-Signature-256`, over the bytes as sent) is checked against a secret
  kept in Secrets Manager; anything not through CloudFront, unsigned, a delivery id seen in the last day, or for a
  repository that is not a project is dropped with 204.
- A good event publishes `record.changed` (with `{ repo, kind: 'change', number }`) to the project's members on their
  user channels. The API runtime still decides who the members are.
- The installer creates the secret and registers the webhook on every project repository (onboarding and upgrade),
  idempotently. A repository it cannot register on (token lacks admin) is a warning, never a failed install.
- The app keeps polling as a fallback, slower (60 s) when live events are connected, and every polled line says when
  it next looks ("next look in 40 s").

### How it is built (Live updates, built 2 November 2026)

```
GitHub ──POST, signed──▶ CloudFront /api/hooks/* ──▶ <prefix>-web-hooks (function URL, no IAM, at most 10 at once)
                          (WAF: body rules skip it,     │ 0 x-trace-origin: CloudFront's random value (constant time)
                           HooksRate limits it; adds    │ 1 size, event, X-Hub-Signature-256 (HMAC SHA-256 of the raw bytes,
                           x-trace-origin)              │   constant time) against <prefix>/web/github-hooks (cached 5 min);
                                                        │   X-GitHub-Delivery not seen in the last day
                                                        │ 2 hook.members { repo } ──▶ API runtime, as the backend's own client
                                                        │   (client credentials, scope trace-internal/members; its secret
                                                        │   <prefix>/web/hooks-client)
                                                        │ 3 debounce per repository (DynamoDB <prefix>-web-hooks)
                                                        └─▶ AppSync Events: record.changed { repo, kind: 'change', number? }
                                                            to each member's /trace/users/<sub>
```

- **Route** (`src/web/hooks.ts`). Dropped with 204 and one log line (why, the event, the delivery id; never the body):
  no origin header or the wrong one (checked first, before the settings, the body or a secret are read), live updates
  off, a body over 1 MB, no signature, an event other than the four, a secret that cannot be read, a bad signature, a
  body with no repository, no delivery id or one seen in the last day (remembered in the debounce table with a TTL,
  only once signed), a repository that is not a project. A good delivery is 202. The signature is over the body's bytes
  as the function URL event gives them, not a re-encoded string. A signature that
  does not match a cached copy older than 30 s reads the secret again once, so a secret the installer replaced is
  picked up at once without reading it for every forged delivery.
- **Who is told: the API runtime decides, with the backend's own identity.** `hook.members { repo }`
  (`src/api/actions-hooks.ts`) answers `{ repo, project, subs }`: whether the repository is in the projects registry,
  and the Cognito subs of the people assigned to it (any part; connected systems left out) and every admin. It is
  called with a token of the backend's own Cognito app client, `<prefix>-web-hooks` (client credentials, a secret, one
  scope `trace-internal/members` of a resource server of its own), which the API runtime's authorizer lists beside the
  CLI's and the web app's (`TRACE_COGNITO_HOOKS_CLIENT_ID`). `src/api/backend-auth.ts` turns that token (its client,
  no `username`, the scope) into a principal of kind `backend`: no class, never an admin, on no project. `perform`
  lets it call `hook.members` and nothing else, and `hook.members` (need `backend`) refuses everyone else, admins and
  connected systems included. Members are cached 60 s per repository in the function, the token for its hour.
- **Why that, over the alternatives.** The rule is that the API runtime is the one place that decides access and the
  backend never reads the access store, and a webhook has no person whose token could ask `project.members`.
  (1) *Reading the access store in the hooks function*, as `<prefix>-journey-events` does: simplest, but it is the
  rule broken by the one function that faces the internet without a sign-in. (2) *Signing as the backend's IAM role
  to the API runtime*: AgentCore's runtime takes a JWT authorizer or IAM, not both, and the people's runtime is JWT;
  a second runtime for one action is a lot of machinery. (3) *A connected system* (docs/external-access.md): the
  machinery fits (a client-credentials app client verified against a store), but a connected system is an outside
  system an admin manages, goes through the external runtime (off unless External access is on), and is assigned to
  projects; the backend is part of trace and must see every project's members. So the choice is the connected
  systems' shape (client credentials, a verified client, an allow-list of one) on the people's runtime, with its own
  resource server and principal kind, made by the stack: no admin step, nothing assigned, and if its secret leaked it
  tells who is on which project by sub, and nothing else (no emails, no content, no writes).
- **Debounce.** One push sends dozens of check_run and status deliveries, each its own invocation and often its own
  container, so the window is shared: `<prefix>-web-hooks` in DynamoDB (`src/web/hooks-store.ts`), one item per
  repository, conditional UpdateItems only. The first delivery of a quiet repository claims a 5 s window and publishes
  at once; deliveries inside it only note their number; when the window ends the holder takes what was noted (only if
  the window is still the one it claimed: its `until` is the condition) and publishes once more (naming the change when one was noted, else none), and holds another window while they keep
  coming (at most six). When DynamoDB cannot be reached a delivery publishes on its own (fail open: one more refetch,
  nothing lost).
- **Infra** (`src/infra/web.ts`, `web.hooks`, on by default in the nested layout; off, or a flat installation: none of
  it, and the app polls. A flat parent of 20 projects has no room for the client and its resource server). The hooks function
  is the backend's code (`hooks.mjs`) with a role of its own: its settings parameter, `GetSecretValue` on the webhook
  secret and the backend's client secret, `UpdateItem` on its table (TTL on `ttl`), `appsync:EventPublish`, its logs.
  Nothing of Cognito, the access store or a project; the backend's role gains nothing. CloudFront sends `/api/hooks/*`
  (ahead of `/api/*`) to its function URL as a plain HTTPS origin, with every viewer header and the body as sent and no
  viewer function. It cannot sit behind the backend's origin access control: CloudFront signs the request, and Lambda
  refuses a signed POST that lacks `x-amz-content-sha256`, which GitHub never sends. So its URL takes requests from
  anyone who finds it, around the WAF: CloudFront adds `x-trace-origin` with a random value the stack makes
  (`<prefix>/web/hooks-origin`, resolved into the origin's custom header and the function's `TRACE_HOOKS_ORIGIN` at
  deploy), and the function drops anything without it (constant-time compare) before reading the body, its settings or
  a secret. Its reserved concurrency is 10, so a flood is throttled by Lambda rather than costing money or the
  account's concurrency. The backend's app client allows no sign-in flow of a person's (`ExplicitAuthFlows` is
  `ALLOW_REFRESH_TOKEN_AUTH` only; client credentials is OAuth's). The WAF's body rules (KnownBadInputs, Common) and `ApiRate` skip
  `/api/hooks/*` (pull request text may look like an attack, and one push is a burst from a few GitHub addresses); a
  `HooksRate` rule limits it on its own (5,000 per address in 5 minutes); BodyTooLarge and IpReputation still apply.
  The web settings parameter gains `hooks` (the secret's name, the token address, the client id and scope, the table),
  the stack outputs `WebHooksAddress` (CloudFront's own address + `/api/hooks/github`, reachable whatever a custom
  domain's DNS says) and `WebHooksClientId`. No new references between the web stack and the parent.
- **Installer** (`src/installer/hooks.ts`, the web step of `apply`, so `tracectl install` and `tracectl upgrade`). Two
  secrets, apart because different roles read them: `<prefix>/web/github-hooks` (JSON `{ webhookSecret }`) is made
  when missing with a random webhook secret, which is then kept (the hooks function and the self-update read it);
  `<prefix>/web/hooks-client` (JSON `{ clientSecret }`) gets the backend's client secret, read from Cognito, each run (a
  client the stack made again is picked up; only the hooks function reads it). An older installation's combined secret
  has its client secret taken out (the hooks function reads the old place until the new one exists). Every project repository gets one webhook to `WebHooksAddress`, JSON, the four
  events, active: found by its exact URL and updated in place, else created, so a second run never adds a second one.
  A repository that refuses (no admin, no "Webhooks: read and write") is a warning in the summary and the preflight's
  access note, never a failure. The self-update registers the projects it adds with the webhook secret, which its role
  may read and never write, and never the client secret (a webhook secret that is not JSON is logged as a fixed
  message, never its text). `tracectl uninstall --delete-data` removes both. The answer `webHooks` (Optional › Web
  app › "Live updates from GitHub") turns it all off. It is a switch, not a typed value, so there is no check for it to
  run; the token's webhook permission is already among the checks the token's validation runs.
- **App** (`web/src/lib/live.ts`): `record.changed` with `kind: 'change'` refetches `pull.status`, `changes.list`,
  `change.get`, the inbox and the journey for that repository. `pollEvery` slows a polled query to 60 s while the
  connection is live (the changes list too: 30 s offline); `useNextLook` gives the line's "next look in 40 s"
  (`pull-status.tsx`, `project/github-waits.tsx`). A refetch after an event reaches the API runtime's 20 s cache: a
  push is a new head commit, which misses it at once; a check finishing on the same head shows within 20 s.
- **Accept in the app** sends the head it showed: the review page and the next-step card send change.get's
  `head.sha`; Home's and the inbox's Needs you card reads change.get first and sends that. A change's pictures are
  fetched only from https or the app's own origin.
- **Not tested here** (nothing is deployed from this branch): a real GitHub delivery through CloudFront and the WAF, the
  client-credentials token from a real pool, and the API runtime's authorizer taking the third client.

## Screens (`web/`)

- **Overview:** under the stage rail, the current stage opens into a guide: stage N of M, its purpose, its steps with
  owners (yours highlighted), and the gate's criteria with a meter. "What happens in <Stage>" opens the stage sheet.
  The next-step card shows "Step 3 of 5 in Capture", trace's recommendation with its reason, the primary action, and
  an "After you …" line. "Changes from trace" replaces "Waiting on GitHub".
- **Changes tab** (`/p/$id/changes`): the open changes as a TanStack table. **Review page**
  (`/p/$id/changes/$number`): what trace did, files (schematic and board files in the KiCanvas viewer with
  Before/After, text files as a diff, images side by side), checks, requirements covered, recommendation, a note box,
  and a decision bar: Discard, Ask for changes, Accept into the design. Reviewers see it read-only. "View on GitHub"
  stays as a small link.
- **Stage sheet:** opened from any stage on the rail: purpose, you do, trace does, you get, typical time, comes next,
  steps (each linking to its guided skill), and "Ask trace why this stage is taking long".
- **Home "Needs you"** lists changes beside gates and questions, with Review and (when `may_accept`) Accept.
- **Confirmations:** after accept, ask or discard, a toast that says what moved and what trace starts next. Finishing a
  stage shows a short celebration (none with reduced motion).
- **Phone:** the stage as a segmented bar with "step 3 of 5".
- The mock data (`VITE_MOCK`) covers every new screen, so screenshots can be made without AWS.
