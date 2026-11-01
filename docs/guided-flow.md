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
