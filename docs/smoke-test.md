# Smoke test

Status: Tier 1 (screens) built, November 2026. Tier 2 (the `test-esp32` journey) follows the ontology work.

The smoke test proves every part of trace still works on the happy path, in two tiers.

| Tier | What it does | Time | When |
| --- | --- | --- | --- |
| 1. Screen smoke | Playwright opens every screen; each loads, shows real data and does one thing, on a desktop and a phone | about 4 min | every pull request (mock), and after each self-update (live) |
| 2. Journey smoke | A fresh `test-esp32` goes through all nine stages, gates signed in the app, ending with a prepared (never submitted) JLCPCB order | 1–2 h | nightly and before a release |

The plan, with the stage diagram and the full surface checklist, is the Claude doc "Trace smoke test plan".

## Running it

From `web/`:

```sh
npm run smoke            # against the mock app (starts it on port 5179)
npm run smoke:live       # against an installation (variables below)
npx playwright show-report ../web/smoke-report
```

Every check fails if the page throws, takes a screenshot at its end, and keeps a Playwright trace when it fails.
Checks tagged `@phone` run again on a Pixel 7 viewport. A phone shows tables as lists; the helpers accept either.

## What Tier 1 covers

| File | Covers |
| --- | --- |
| `shell.smoke.ts` | sign-in page, Home, Next, the working indicator, themes, search |
| `projects.smoke.ts` | projects table (search, columns), a project's stage strip, a new project's first step |
| `chat.smoke.ts` | Ask trace: send, reply, up-arrow recall, conversations, read-aloud and dictation controls, a remember card kept only on Confirm |
| `project.smoke.ts` | traceability highlight, block diagram, sheets, pin plan, decisions timeline, evidence and a run, file viewer, settings and the project logo's sample cover, cost, memory |
| `board3d.smoke.ts` | the 3D board and its underside (desktop and phone), the Case tab: whether the board fits, its problems on the board and listed. Run one at a time (the `3d` project) |
| `changes.smoke.ts` | review a change in the app, its files, accepting it, a gate locked while work is pending, a shape's findings under its criterion (each waivable), signing off a criterion an admin added |
| `admin.smoke.ts` | people, connected systems, agent instructions, project templates (edit a stage, discard), installation, usage, operations, agents and tools, knowledge, its graph and a project's replay, voice preferences |
| `outside.smoke.ts` | external API, remote MCP, `tracectl`, web push (live only; each skips with its reason when not set up) |

Checks that change data (a new project, accepting a change) run against the mock always, and against a live
installation only with `TRACE_SMOKE_WRITES=1`. Accepting a change never runs live: Tier 2 does that for real.

## Live runs

The CI job `smoke-live` runs after `update-installation` once trace's own repository has the variable
`TRACE_SMOKE_SECRET`. The installer sets all of it up, with nothing to do by hand (`src/installer/smoke.ts`, the
"Set up the live smoke test" step), whenever the installation updates itself and has its web app:

- **The smoke user**, `smoke@<prefix>.trace.invalid`: an ordinary user and a Reviewer of the smoke project only, so it
  can read that project and nothing else, and sign or accept nothing. Its address can never receive mail, so Cognito
  is told to send none. Its password is random and the installer enrols its authenticator, with a secret only this
  installation keeps.
- **Its sign-in**, in the Secrets Manager secret `<prefix>/smoke/sign-in`: one JSON object of the variables below.
- **The read grant**: the self-update role may read that secret (`SmokeUserSecret`) and nothing else of it.
- **The variable** `TRACE_SMOKE_SECRET` on trace's own repository, set once the secret is there.

A later run keeps the smoke user only after signing in with what is stored (password, then an authenticator code), and
then only updates the address or project in its secret. If that sign-in fails (a reset by hand, a failed run), the user
gets a new password and authenticator. Turn it off with the installer answer `runners.smokeTest: false`: the variable
goes before the deploy, then the user and its secret. Uninstalling removes all three. Choose the project with
`runners.smokeProject` (default: the sample project, else the first).

Live runs skip the admin screens (the smoke user is not an admin; set `TRACE_SMOKE_ADMIN=1` in the secret for an admin
account). trace's repository is public, so a live run keeps no traces, screenshots or HTML report: the job uploads
`results.json` only, for 7 days. Its log is public like any CI log, so a failed check's message can quote a few words
from a page.

| Key | Meaning |
| --- | --- |
| `TRACE_SMOKE_URL` | the web app, e.g. `https://d1ubkf6kpykgil.cloudfront.net` |
| `TRACE_SMOKE_EMAIL`, `TRACE_SMOKE_PASSWORD` | the smoke user |
| `TRACE_SMOKE_TOTP_SECRET` | the base32 secret of the smoke user's authenticator |
| `TRACE_SMOKE_PROJECT` | the project the screens are checked on, as in its address (`owner~test-esp32`) |

Optional keys, added to the secret by hand when wanted: `TRACE_SMOKE_ADMIN=1` (an admin account), `TRACE_SMOKE_WRITES=1` lets checks that change data run on the
smoke project; `TRACE_SMOKE_TOKEN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_API_URL` and `_MCP_URL` of a read-only connected
system turn on the external API and MCP checks. A later installer run keeps them.

## Findings

| Found | Where | What | Status |
| --- | --- | --- | --- |
| 2026-11-04 | Change review, after Accept | The page threw `Cannot read properties of undefined (reading 'setTransform')` four times: pdf.js still drawing a page after the PDF viewer left. Intermittent (1 in about 4 full runs) | open |
| 2026-11-04 | Mock: Evidence → a run | The runs list (admin fixtures) and the single-run lookup (s1 fixtures) disagreed, so a listed run sometimes showed "Could not load this run" | fixed in the mock |
| 2026-11-04 | Ask trace, desktop and phone | A message sent soon after the panel opened vanished: the panel reopened the last conversation from a lookup started on open, and when that answered late (a loaded machine) it switched away from the new conversation the message had just made; a message sent while a stored conversation was still loading was overwritten when it landed. Intermittent in CI | fixed: the panel shows the conversation only once it knows which one, never switches away from one started meanwhile, and holds sending (not typing) until a conversation has loaded; the check starts a conversation of its own and waits for the panel to be ready rather than for the network to go quiet |
| 2026-11-04 | 3D board, desktop | Building the board in 3D took over 30 s with software rendering on a loaded test machine | check allows 90 s |
| 2026-11-05 | 3D board, desktop | With the Case tab's check added, two 3D boards rendered at once on a runner without a GPU, and the Turn over click timed out (each passes alone) | the 3D checks run one at a time (`board3d.smoke.ts`, the `3d` project) |
