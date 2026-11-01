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

## API runtime actions (`src/api/actions-changes.ts`)

Access is checked first, as for every action. `read` = assigned to the project; `write` = the Contributor part.

| Action | Needs | Args | Answer |
| --- | --- | --- | --- |
| `changes.list` | read | `{ repo }` | `{ repo, changes: ChangeSummary[] }`: the open pull requests a trace job of this project opened (the same branch match as `src/api/inbox-review.ts`), oldest first |
| `change.get` | read | `{ repo, number }` | `ChangeDetail` |
| `change.diff` | read | `{ repo, number, path }` | `{ path, kind, patch: string \| null, before: { ref } \| null, after: { ref } \| null, binary: boolean }` |
| `change.accept` | write | `{ repo, number, note? }` | `{ merged: true, sha, stage, next: string }`: merges it (the repository's allowed method, squash first), removes the hold label, records decision `change.accepted` |
| `change.ask` | write | `{ repo, number, note }` (1–4000 chars) | `{ job_id }`: comments on the pull request ("Asked by <name>: …"), starts a revision job with the same agent on the same branch, records `change.asked` |
| `change.discard` | write | `{ repo, number, reason }` (1–2000 chars) | `{ closed: true }`: comments the reason, closes it, records `change.discarded` |

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
  may_accept: boolean     // this person, now: Contributor part, open, checks not failing or running, no conflict
  blockers: string[]      // plain words, when may_accept is false
  base: { ref: string; sha: string }; head: { ref: string; sha: string }
}
```

The recommendation is worked out from facts, never a model: all checks passed and it can merge → accept, naming the
checks and the requirements; a check failing → ask, naming it; checks running → wait; a conflict → none, "trace will
bring it up to date". `change.accept` re-reads the status first and refuses when it is not `may_accept`.

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

## Live updates (`src/web/`, `src/infra/`, `src/installer/`)

- A GitHub webhook on each project repository (pull_request, check_run, check_suite, status) posts to
  `POST /api/hooks/github` on the web backend. Its HMAC (`X-Hub-Signature-256`) is checked against a secret kept in
  Secrets Manager; anything unsigned or for a repository that is not a project is dropped with 204.
- A good event publishes `record.changed` (with `{ repo, kind: 'change', number }`) to the project's members on their
  user channels. The API runtime still decides who the members are.
- The installer creates the secret and registers the webhook on every project repository (onboarding and upgrade),
  idempotently. A repository it cannot register on (token lacks admin) is a warning, never a failed install.
- The app keeps polling as a fallback, slower (60 s) when live events are connected, and every polled line says when
  it next looks ("next look in 40 s").

### How it is built (Live updates, built 2 November 2026)

```
GitHub ──POST, signed──▶ CloudFront /api/hooks/* ──▶ <prefix>-web-hooks (function URL, no IAM; src/web/hooks-lambda.ts)
                          (WAF: body rules skip it,     │ 1 size, event, X-Hub-Signature-256 (HMAC SHA-256, constant time)
                           HooksRate limits it)         │   against <prefix>/web/github-hooks (Secrets Manager, cached 5 min)
                                                        │ 2 hook.members { repo } ──▶ API runtime, as the backend's own client
                                                        │   (client credentials, scope trace-internal/members)
                                                        │ 3 debounce per repository (DynamoDB <prefix>-web-hooks)
                                                        └─▶ AppSync Events: record.changed { repo, kind: 'change', number? }
                                                            to each member's /trace/users/<sub>
```

- **Route** (`src/web/hooks.ts`). Dropped with 204 and one log line (why, the event, the delivery id; never the body):
  live updates off, a body over 1 MB, no signature, an event other than the four, a secret that cannot be read, a bad
  signature, a body with no repository, a repository that is not a project. A good delivery is 202. A signature that
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
  at once; deliveries inside it only note their number; when the window ends the holder takes what was noted and
  publishes once more (naming the change when one was noted, else none), and holds another window while they keep
  coming (at most six). When DynamoDB cannot be reached a delivery publishes on its own (fail open: one more refetch,
  nothing lost).
- **Infra** (`src/infra/web.ts`, `web.hooks`, on by default in the nested layout; off, or a flat installation: none of
  it, and the app polls. A flat parent of 20 projects has no room for the client and its resource server). The hooks function
  is the backend's code (`hooks.mjs`) with a role of its own: its settings parameter, `GetSecretValue` on the hooks
  secret, `UpdateItem` on its table, `appsync:EventPublish`, its logs. Nothing of Cognito, the access store or a
  project; the backend's role gains nothing. CloudFront sends `/api/hooks/*` (ahead of `/api/*`) to its function URL
  as a plain HTTPS origin, with every viewer header and the body as sent and no viewer function. It cannot sit behind
  the backend's origin access control: CloudFront signs the request, and Lambda refuses a signed POST that lacks
  `x-amz-content-sha256`, which GitHub never sends. The function serves that one path and checks every signature, so
  its open URL is no wider than the CloudFront path. The WAF's body rules (KnownBadInputs, Common) and `ApiRate` skip
  `/api/hooks/*` (pull request text may look like an attack, and one push is a burst from a few GitHub addresses); a
  `HooksRate` rule limits it on its own (5,000 per address in 5 minutes); BodyTooLarge and IpReputation still apply.
  The web settings parameter gains `hooks` (the secret's name, the token address, the client id and scope, the table),
  the stack outputs `WebHooksAddress` (CloudFront's own address + `/api/hooks/github`, reachable whatever a custom
  domain's DNS says) and `WebHooksClientId`. No new references between the web stack and the parent.
- **Installer** (`src/installer/hooks.ts`, the web step of `apply`, so `tracectl install` and `tracectl upgrade`).
  `<prefix>/web/github-hooks` (JSON `{ webhookSecret, clientSecret }`) is made when missing with a random webhook
  secret, which is then kept; the backend's client secret, read from Cognito, is written into it each run (a client
  the stack made again is picked up). Every project repository gets one webhook to `WebHooksAddress`, JSON, the four
  events, active: found by its exact URL and updated in place, else created, so a second run never adds a second one.
  A repository that refuses (no admin, no "Webhooks: read and write") is a warning in the summary and the preflight's
  access note, never a failure. The self-update registers the projects it adds with the secret, which its role may
  read and never write. `tracectl uninstall --delete-data` removes the secret. The answer `webHooks` (Optional › Web
  app › "Live updates from GitHub") turns it all off. It is a switch, not a typed value, so there is no check for it to
  run; the token's webhook permission is already among the checks the token's validation runs.
- **App** (`web/src/lib/live.ts`): `record.changed` with `kind: 'change'` refetches `pull.status`, `changes.list`,
  `change.get`, the inbox and the journey for that repository. `pollEvery` slows a polled query to 60 s while the
  connection is live; `useNextLook` gives the line's "next look in 40 s" (`pull-status.tsx`, `project/github-waits.tsx`).
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
