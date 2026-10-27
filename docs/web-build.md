# Trace web app: how it is built

This is the build contract for the web app designed in [ui-design.md](ui-design.md). It fixes the pieces and the
interfaces between them so they can be built side by side. Where this file and the design disagree on *what a person
sees*, the design wins; where they disagree on *how it is wired*, this file wins.

## The pieces

```
browser ──https──▶ CloudFront (one address)
                    ├── /*        S3 bucket: the static app (web/dist), private, reached through origin access control
                    └── /api/*    Lambda function URL (response streaming), reached through origin access control
                                   src/web/  ── the web backend
                                     ├── /api/auth/*    our own sign-in: Cognito's user-pool API, refresh token in an
                                     │                  HTTP-only cookie
                                     ├── /api/call      { action, ...args } → the API runtime (AgentCore, the person's
                                     │                  bearer token), exactly as `tracectl` CLI calls it
                                     ├── /api/agui      the "trace" chat agent: AG-UI events over SSE; Claude on Bedrock
                                     │                  (ConverseStream); its tools are API actions called as the person
                                     ├── /api/voice/*   Polly speech (cached in S3) and signed Transcribe streaming URLs
                                     ├── /api/ops       CloudWatch dashboards and metric data, filtered by access
                                     └── /api/config    what the app needs to start (no secrets)
browser ──wss──▶ AppSync Events (the id token, checked by a Lambda authorizer): the one live connection, channel /trace/users/<sub>
```

Rules every piece keeps:

- **The API runtime stays the one place that decides access.** The web backend never reads the access store or a
  project's database itself. Anything per project goes through `/api/call` (or the chat agent's tools, which call the
  same thing with the person's token). The backend's own AWS reach is Polly, Transcribe, CloudWatch read, its voice
  cache prefix, AppSync publish, the configured chat model and one SSM parameter. Every authenticated endpoint but the
  person's own sign-in settings needs an account class (403 "no access" otherwise).
- **No circular references in the stack.** The backend reads its settings (user pool and client ids, the API runtime's
  ARN, the AppSync endpoints, the voice bucket) from one SSM parameter, `/<prefix>/web/config`, whose name is fixed.
  CloudFront → Lambda URL; the user pool → CloudFront's domain (the passkey relying party); nothing points back. The
  live events API lives in the web stack with a Lambda authorizer (it names nothing of the pool), so the content
  security policy names its exact hosts.
- **Tokens never in browser storage.** Access and id tokens live in memory; the refresh token is an HTTP-only,
  Secure, SameSite=Strict cookie `__Secure-trace_rt` scoped to `/api/auth` (a name sent twice is ignored; the old name
  `trace_rt` is read once and moved).
- **People are their Cognito sub.** Every match (opened evidence, questions asked of a person, chat authorship, memory
  marks, person memory) is on the hash of the sub; the email is for display. Records made before carry the email's
  hash and are accepted on read. The pool keeps an email change pending until it is verified.
- **Nothing a model reads starts work.** The chat agent's `start_task` is shown to the person as a confirm card with
  the exact request; only their Confirm calls `task`. Tool results and other people's messages reach the model fenced
  as data.
- **Every mutating `/api/call` publishes a live event** to the people on that project (from `project.members`), so
  screens update without asking again.

## Web backend endpoints (`src/web/`)

All bodies are JSON unless noted. Errors: `{ ok: false, error, code? }` with a fitting status (400, 401, 403, 404, 429,
500). Authenticated endpoints take `Authorization: Bearer <access token>`.

| Endpoint | Body / query | Answer |
| --- | --- | --- |
| `GET /api/config` | – | `{ region, prefix, userPoolId, clientId, events: { http, realtime }, features: { passkeys, email, voice, ops } }` |
| `POST /api/auth/start` | `{ email }` | `{ session, choices: ('passkey'\|'email_code'\|'password')[] }`: `InitiateAuth` USER_AUTH without a preferred factor; `choices` are the pool's, the same for every address (a choice the account lacks fails at respond with `choice_unavailable`) |
| `POST /api/auth/respond` | `{ email, session, kind: 'password'\|'email_code'\|'passkey'\|'totp'\|'new_password', answer }` (`answer` for passkey: the WebAuthn assertion JSON) | signed in: `{ signedIn: true, accessToken, idToken, expiresIn, user: { sub, email, class } }` and the cookie; or the next step: `{ signedIn: false, next: 'email_code'\|'totp'\|'new_password'\|'passkey', session, options? }` |
| `POST /api/auth/refresh` | – (cookie) | `{ accessToken, idToken, expiresIn, user }` or 401 |
| `POST /api/auth/sign-out` | – | revokes the refresh token, clears the cookie |
| `POST /api/auth/forgot` | `{ email }` | `{ sent: true }` always (no user enumeration) |
| `POST /api/auth/reset` | `{ email, code, password }` | `{ ok: true }` |
| `POST /api/auth/passkeys/start` | bearer | `{ options }` (`StartWebAuthnRegistration`) |
| `POST /api/auth/passkeys/finish` | bearer, `{ credential }` | `{ ok: true }` |
| `GET /api/auth/passkeys` / `DELETE /api/auth/passkeys/:id` | bearer | list / delete |
| `POST /api/auth/totp/start` / `POST /api/auth/totp/verify` | bearer, `{ code }` on verify | `{ secret, uri }` / `{ ok }` |
| `POST /api/call` | bearer, `{ action, ...args }` | the API runtime's answer, as is |
| `POST /api/agui` | bearer, AG-UI `RunAgentInput` | `text/event-stream` of AG-UI events |
| `GET /api/voice/voices?language=en-AU` | bearer | `{ voices: [{ id, name, gender, engines }] }` |
| `POST /api/voice/speak` | bearer, `{ text, voice, engine?, rate? }` | `{ url, marks }` (signed S3 URL of the MP3, and word speech marks) |
| `POST /api/voice/listen` | bearer, `{ language, repo? }` | `{ url, vocabulary? }`: signed Transcribe streaming WebSocket URL, 5 minutes; with `repo`, the project's custom vocabulary (`voice.vocabulary`, asked as the person) is named in it when READY, and `vocabulary: { state, used, note }` says whether |
| `GET /api/ops?range=24h&repo=` | bearer | `{ status, tiles, alarms, sections: [{ id, title, widgets: [{ id, title, kind, unit, series: [{ label, repo?, points: [[t, v]] }] }] }], updatedAt, nextAt }` filtered by access |

## Live events (AppSync Events)

- One API, namespace `trace`, in the web stack. Connect and subscribe auth: a Lambda authorizer
  (`src/web/events-auth.ts`) that checks the app's id token (the web client's) and allows `/trace/users/<its sub>`
  only. Publish auth: IAM (the web backend's role only).
- Channel per person: `/trace/users/<sub>`. The namespace's `onSubscribe` handler refuses any channel whose `<sub>` is
  not the subscriber's own.
- Event: `{ type, repo?, at, ...detail }` with `type` one of `record.changed` (`{ repo, what: 'journey'|'settings'|
  'memory'|'chats'|'people'|'prompts'|'kb' }`), `job.updated` (`{ repo, jobId, state }`; both null when more than ten
  of the project's jobs changed at once), `notification`
  (`{ id, kind, repo, summary }`). The app treats each as "invalidate these queries" and refetches; payloads never
  carry project content.
- Who publishes: the web backend, after an ok answer to a mutating `/api/call` (`src/web/events.ts` lists them, with
  `stuck.dismiss`, `order.update`, `board.record` and `board.check` among the journey's), to the project's members and the caller; and `<prefix>-journey-events`
  (`src/web/journey-events.ts`, in the web stack beside the events API) for what agents write. Agents write their facts
  (`projects/<slug>/journey-agent/facts.db`) and each project's worker its job index (`journey-agent/jobs.db`) straight
  to the central bucket, which no backend sees. The bucket sends its object events to EventBridge (its own
  `NotificationConfiguration`, no custom resource), and a rule on "Object Created" of `projects/*/journey-agent/facts.db`
  or `projects/*/journey-agent/jobs.db` in that bucket invokes the function. For a job index it publishes `job.updated`
  for each job the write changed to everyone on the project, and reads only that object (role statement
  `JobIndexRead`). It takes the project from the
  key, the people on it from the access store (admins, and the people assigned, by part), and publishes
  `record.changed { repo, what: 'journey' }` to each, plus `notification { id, kind: 'question'|'stuck', repo,
  summary }` (a fixed line, no project content) for a question or stuck report written in that change, to the people
  it is for. It reads the facts file that changed only to tell a new question from a check. The same rule matches the bench's live
  copy, `projects/*/journey-agent/bench.db` (a bring-up reading was taken, `src/core/bench.ts`): that publishes
  `record.changed { what: 'journey' }` only, notifies no one and is never read. The journey record
  (`projects/<slug>/journey/journey.db`) is not matched: only the API writes it, and the backend publishes those
  writes already, so matching it would send every event twice. One publish per S3 event, unbatched: an agent writes
  its facts a few times a job. Its role: `s3:GetObject` on `access/*` (and `s3:ListBucket` under it) and on
  `projects/*/journey-agent/facts.db`, `appsync:EventPublish` on the namespace, its log group.

## New and changed API runtime actions (`src/api/`)

New actions live in their own files (`src/api/actions-<area>.ts`) and are spread into `ACTIONS`, so `actions.ts`
changes by a line each.

**Per-project parts** (decided 27 Oct). `assignments` gain `part TEXT CHECK (part IN ('contributor','reviewer'))`
(migrated: existing rows take their class's old right, users → contributor, guests → reviewer). A guest can only be a
reviewer. `require_(p, repo, 'write')` needs the contributor part (or admin). `projects` answers
`{ repo, role, part }`. `assign` takes `part` (default from class). `users.list` shows each person's parts.

| Action | Need | Does |
| --- | --- | --- |
| `project.members` | read | `[{ sub, email, name?, class, part }]` for the project, admins included and marked |
| `projects.create` | admin | onboard a repository (new or existing; reuses `src/installer/onboard-api.ts`), register it, assign people with parts, write the journey record's first state from the template; returns what was done and what waits (the project's own cloud resources come with the next stack update, shown as a wait: the request is recorded at `installation/pending-projects/<owner>/<repo>.json`, which the self-update job adds to the deployed repositories and marks added, and the installer takes into its answers; `src/installer/pending.ts`. The wait says which comes next: with the self-update on (`TRACE_SELF_UPDATE`), its ci workflow at the next change to trace's main branch, or run by hand there; otherwise the next installer run. In a flat installation (`TRACE_LAYOUT`) it also says the project gets no knowledge base and that the update adds it only below 15 projects) |
| `journey.get` | read | the project's journey: template, revision, stages (state, criteria met/total, reopened), gates (state, criteria, evidence, waivers, signature), next step, questions, waivers, decisions log |
| `journey.criterion.open` | read | records that this person opened a criterion's evidence (the Sign button needs it) |
| `gate.sign` / `gate.return` | admin / write | sign (every criterion met or waived, evidence opened, waivers acknowledged) or return with a reason; a signature that cuts a release also copies the record into the repository |
| `journey.snapshot` | admin | copy the journey record into the repository's `.trace/project.db` on a `trace/release-…` branch and log the commit |
| `question.answer` | write | answer an agent's question (the recommended option or another with a reason) |
| `waiver.add` | write | a waiver with reason, risk, severity, where it is caught instead |
| `stuck.dismiss` | write | `{ job, reason }`: dismiss a stuck agent's report (`job`: the agent's job id, or the stuck item's own id) with a reason in one line; it leaves the views and the inbox, the decisions log keeps it, and the agent reads it in `journey.status` |
| `inbox` | signed-in | the four kinds that earn a notification across the person's projects, oldest and most blocking first |
| `chats.list` / `chats.get` / `chats.append` / `chats.rename` / `chats.recall` | read | threads per project (visible to everyone on it), messages (each marked `yours`), the person's own sent messages newest first. `chats.append` keeps the caller's own words only (role user, by them); at most 500 threads per person per project |
| `chats.reply` | read | trace's reply and tool rows after the caller's own latest turn, by "trace": called by the chat agent only (`/api/call` refuses it) |
| `me.get` / `me.set` | signed-in | the person's preferences (one JSON document, `key` paths), and per-table views |
| `graph.neighbourhood` | read | `{ nodes, links }` around a focus item, depth 1–3, from the project record, memory and the knowledge base |
| `files.list` / `files.url` | read | the project's files by kind, and a short-lived signed URL (or bytes) for one |
| `jobs.list` | read | `{ repo, jobs, agents, batch, updatedAt }`: the project's job index (`projects/<slug>/journey-agent/jobs.db`, `src/core/job-index.ts`, written by its worker from its jobs' own events, with a heartbeat): running, paused, queued (in each agent's queue order, with why it waits) and the last day's finished jobs, each with its agent, who started it, current step, typical time (median of its last 20 that succeeded), branch and `controls`; each agent's status (Working, Queued, Waiting on a person, Stuck, Idle, from the index and the journey's questions and stuck reports) and its last day; the graphics card and CPU jobs running. `journey.get`'s `jobs` is the same list |
| `job.control` | write on the job's project | `{ id, op }`: pause (a running task stops before Claude's next tool call, its work committed and pushed on its branch and its transcript kept; a queued one is held), resume (a paused task carries on as a new task on its branch, continuing its conversation when it was kept; a held one is released), move_up (one place up its agent's queue), cancel (aborts it on its worker and terminates its Batch jobs; a paused one is discarded). People's controls are the journey record's `job_controls`, never the agents' index. A workflow's job can only be cancelled. Every job view carries `controls` |
| `requirements.trace` | read | each requirement with its evidence status (verified, failing, untested, waived) and the intent lines it is derived from; the intent statements (proposed by agents, accepted, edited or rejected by people) with their flags and coverage; `intent_note` only while none is recorded |
| `design.get` | read | the KiCad files with the latest ERC and DRC findings placed on the drawings the latest `kicad.export` kept (`runs/<id>/sheets/<file>.svg`), the requirements each sheet serves, the architecture (options, blocks, connections, scores, the chosen option), the pin plan checked against the newest netlist and who agreed it, and `notes` for what is still not recorded |
| `design.decide` | write | a person's decision about the design record (accept, edit or reject an intent line; leave one uncovered; accept or strike a requirement with its reason; fix the architecture criteria; choose an architecture; agree a part's pin plan), kept in the journey record's `design_decisions` and logged; the design skills' Submit records the same |
| `build.get` / `order.record` | read / write | releases (snapshots), orders (journey table `orders`) with their shipping and Wait line, the order ready to place, boards by serial with their inspection, the bench (each instrument's identity, the bring-up readings against their limits); `src/api/actions-build.ts` |
| `order.update` / `order.check_now` | write / read | the shipping notice (carrier, tracking number), delivered, cancelled, a corrected ship date: people record them, trace never does; a DHL number is followed by the order watch on a backed-off timer (README "Cost and orders"); check now asks it once |
| `board.record` / `board.check` | write | a board received by serial (order, photos, status); one incoming inspection check of one board (journey tables `boards`, `board_checks`) |
| `cost.get` | read (money: admins) | the stage timeline for everyone; for admins: cloud use from the cost ledger (estimates by kind, priced from the dated price table; actuals from Cost Explorer a day behind, and when it reads next), orders paid, committed, the build forecast; `src/api/actions-cost.ts` |
| `usage.month` | admin | every project's month: estimated and actual cloud spend, orders paid, budget; the installation's untagged spend |
| `skill.get` / `skill.draft` / `skill.drafts` / `skill.submit` | read / read / read / write | a guided skill's bar computed from the record (`unavailable` where it cannot be yet), the person's draft in the journey store, and submit (refused unless every check is met or waived; Waiver and Question answer go through `waiver.add` and `question.answer`) |
| `policy.get` / `policy.set` | signed-in / admin | the installation's locked settings (`me.get` answers them as `locks`; `me.set` refuses a locked key) |
| `users.history` | admin | a person's assignment log in words |
| `voice.vocabulary` / `voice.vocabulary.sync` | read / write | the state of the project's dictation vocabulary for a language (`READY`, `PENDING`, `FAILED`, `NONE`, `usable`), and remaking it on the project's worker (`src/api/actions-voice.ts`, `src/tools/voice`) |
| `installation.layout` | signed-in (a class) | `{ layout: 'flat'\|'nested', projects: { max, updateMax }, has: { knowledgeBase, cpuQueue, answerEvents }, note, recommendation?, move? }`: what a flat installation lacks and how to move (`src/api/actions-layout.ts`); shown on New project and Admin › Installation |
| `prompts.chat` | signed-in (a class) | the installation's text of each editable `chat.*` entry (null: the default), never a locked one; the chat agent asks for it as the person and keeps it 60 s per container (`src/web/chat-prompts.ts`), cleared by a prompts write through that container |

The app reads the answers whose shape differs from its screens' through `web/src/lib/readers.ts` (journey.get, inbox,
me.get, project.members, users.list, files.list, files.url, gate.sign, projects.create), tested against real answers
the API's own test writes to `web/src/lib/api-answers.json`.

The journey record is new tables (`src/core/journey.ts`): `journey` (template, revision, current stage), `stages`,
`gates`, `gate_criteria`, `criterion_opens`, `gate_signatures`, `questions`, `waivers`, `decisions`, and
`design_decisions` (people's decisions over the agents' design record, which lives in the repository's
`.trace/project.db` beside the requirements: `src/tools/design`). Templates (Board,
FPGA, Firmware, Mixed) define stages and gate criteria as in [user-journey.md](user-journey.md). The live record is not
in the repository: it is one SQLite database per project in the central bucket, `projects/<slug>/journey/journey.db`
(`src/core/journey-store.ts`), read and written with conditional puts like the central store and chats (a lost race
is re-run on a fresh copy); every write answers the record's `version`. When a release is cut (signing the gate the
Release stage follows) the record is copied into the repository: the default branch's `.trace/project.db` with its
journey tables replaced, committed on `trace/release-<revision>-<time>` the way `settings.set` writes, and the commit
logged in the decisions; `journey.snapshot` (admin) makes the same copy on demand. A project whose journey an older
install kept in `.trace/project.db` has it imported into the bucket on first read.

**What agents contribute** is kept beside the record, never in it (agents may read the record but not write it, so
they can never sign, waive or answer for a person): `projects/<slug>/journey-agent/facts.db` (`src/core/agent-facts.ts`,
the same conditional-write store), with `agent_questions` (options with exactly one recommended and a reason each,
sources, what it blocks, asked of a person by Cognito sub or of the contributors or admins), `criterion_checks` (a
criterion trace owns met or not met, with evidence, the agent and its job; the newest check of a criterion stands) and
`stuck` (why, the recommendation, options). Agents write it through the worker tools `journey.status`, `journey.ask`
(optionally waiting for the answer), `journey.check` and `journey.stuck`, which the API's `tool` action never runs.
`journey.ask`'s wait is told when the answer may have come: each project's events topic
(`<prefix>-<hash>-batch-events`, nested layout) gets the bucket's "Object Created" event of its own `journey.db` from a
rule of its own (`<prefix>-<hash>-journey-events`), and the waiting worker subscribes a short-lived queue to it (the
same way it waits on its Batch jobs, `src/gpu/batch.ts openWaitQueue`), filtered to those events, and reads the record
once per write. It also reads it 30 s and 90 s after subscribing and then every 5 minutes in case a message is lost.
Without the topic, or when subscribing or receiving fails, it reads the record on a timer (30 s doubling to 5
minutes) and says when it looks next. The S3 event was chosen over publishing from the API: it needs no new
permission in the API's role, and it covers every write of the record (an answer through a guided skill too).
A person may dismiss a stuck report (`stuck.dismiss`): the dismissal is a row of the record's `stuck_dismissals`, the
item leaves every view, and `journey.status` shows the agent the dismissal with its reason. The worker and workflow roles may write it only with conditional puts and never delete it; the API
role reads it. Every journey view (`journey.get`, the inbox, `gate.sign`, `waiver.add`, the guided skills) merges the
facts in: an agent's question is a question, a check sets a trace-owned criterion's status (on its revision, not from
before its stage was reopened, not over a newer row of the record), a stuck agent is a `stuck` item. `question.answer`
writes the answer into the record under the agent's question id, which is where the agent reads it. A person-owned
criterion never moves from an agent's fact. Chats and preferences are not in
the repository either: chats in the central bucket under `projects/<slug>/chats/`, preferences in the access store.

## The app (`web/`)

React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui (new-york style, neutral base, source in `web/src/components/ui`),
TanStack Router (file routes), TanStack Query, TanStack Table, CopilotKit v2 with AG-UI, lucide icons, Geist fonts.
Its own `package.json` and lockfile; built into `web/dist` by the stack's asset bundling (and by `npm run build:web`).

```
web/src/
  lib/        api.ts (call(), typed actions), auth.ts (tokens in memory, refresh), live.ts (AppSync Events),
              theme.ts, prefs.ts, format.ts, glossary.ts
  components/ ui/ (shadcn), shell/, data-table/, stage-rail, next-step-card, needs-you-card, decision-card,
              run-line, wait-line, status-badge, evidence-chip, quality-bar, focus/, chat/, files/, canvas/
  routes/     sign-in, invite, no-access, index (Home), inbox, projects, p/$id/…, knowledge/…, agents/…, ops/…,
              admin/…, me
```

`web/` is excluded from the root TypeScript project and from the agent image.
