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
| `chat.smoke.ts` | Ask trace: send, reply, up-arrow recall, conversations, read-aloud and dictation controls |
| `project.smoke.ts` | traceability highlight, block diagram, sheets, pin plan, 3D board and underside, decisions timeline, evidence and a run, file viewer, settings, cost, memory |
| `changes.smoke.ts` | review a change in the app, its files, accepting it, a gate locked while work is pending |
| `admin.smoke.ts` | people, connected systems, agent instructions, installation, usage, operations, agents and tools, knowledge and its graph, voice preferences |
| `outside.smoke.ts` | external API, remote MCP, `tracectl`, web push (live only; each skips with its reason when not set up) |

Checks that change data (a new project, accepting a change) run against the mock always, and against a live
installation only with `TRACE_SMOKE_WRITES=1`. Accepting a change never runs live: Tier 2 does that for real.

## Live runs

The CI job `smoke-live` runs after `update-installation` once the repository variable `TRACE_SMOKE_SECRET` names a
Secrets Manager secret the update role can read. The secret is one JSON object:

| Key | Needed | Meaning |
| --- | --- | --- |
| `TRACE_SMOKE_URL` | yes | the web app, e.g. `https://d1ubkf6kpykgil.cloudfront.net` |
| `TRACE_SMOKE_EMAIL`, `TRACE_SMOKE_PASSWORD` | yes | the smoke user |
| `TRACE_SMOKE_TOTP_SECRET` | yes | the base32 secret of the smoke user's authenticator app |
| `TRACE_SMOKE_PROJECT` | yes | the project the screens are checked on, as in its address (`owner~test-esp32`) |
| `TRACE_SMOKE_WRITES` | no | `1` lets checks that change data run on the smoke project |
| `TRACE_SMOKE_TOKEN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_API_URL`, `_MCP_URL` | no | a read-only connected system on the smoke project, for the external API and MCP checks |

Still to do, so nobody sets this up by hand: the installer creating the smoke user (password plus authenticator, an
admin, on the smoke project only), the secret, the read grant for the update role, and the variable.

## Findings

| Found | Where | What | Status |
| --- | --- | --- | --- |
| 2026-11-04 | Change review, after Accept | The page threw `Cannot read properties of undefined (reading 'setTransform')` four times: pdf.js still drawing a page after the PDF viewer left. Intermittent (1 in about 4 full runs) | open |
| 2026-11-04 | Mock: Evidence → a run | The runs list (admin fixtures) and the single-run lookup (s1 fixtures) disagreed, so a listed run sometimes showed "Could not load this run" | fixed in the mock |
| 2026-11-04 | Ask trace, desktop and phone | A message sent soon after the panel opened vanished: the panel reopened the last conversation from a lookup started on open, and when that answered late (a loaded machine) it switched away from the new conversation the message had just made; a message sent while a stored conversation was still loading was overwritten when it landed. Intermittent in CI | fixed: the panel shows the conversation only once it knows which one, never switches away from one started meanwhile, and holds sending (not typing) until a conversation has loaded; the check starts a conversation of its own and waits for the panel to be ready rather than for the network to go quiet |
| 2026-11-04 | 3D board, desktop | Building the board in 3D took over 30 s with software rendering on a loaded test machine | check allows 90 s |
