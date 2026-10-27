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
                                     │                  bearer token), exactly as `trace` CLI calls it
                                     ├── /api/agui      the "trace" chat agent: AG-UI events over SSE; Claude on Bedrock
                                     │                  (ConverseStream); its tools are API actions called as the person
                                     ├── /api/voice/*   Polly speech (cached in S3) and signed Transcribe streaming URLs
                                     ├── /api/ops       CloudWatch dashboards and metric data, filtered by access
                                     └── /api/config    what the app needs to start (no secrets)
browser ──wss──▶ AppSync Events (Cognito tokens): the one live connection, channel /trace/users/<sub>
```

Rules every piece keeps:

- **The API runtime stays the one place that decides access.** The web backend never reads the access store or a
  project's database itself. Anything per project goes through `/api/call` (or the chat agent's tools, which call the
  same thing with the person's token). The backend's own AWS reach is Polly, Transcribe, CloudWatch read, its voice
  cache prefix, AppSync publish and one SSM parameter.
- **No circular references in the stack.** The backend reads its settings (user pool and client ids, the API runtime's
  ARN, the AppSync endpoints, the voice bucket) from one SSM parameter, `/<prefix>/web/config`, whose name is fixed.
  CloudFront → Lambda URL; the user pool → CloudFront's domain (the passkey relying party); nothing points back.
- **Tokens never in browser storage.** Access and id tokens live in memory; the refresh token is an HTTP-only,
  Secure, SameSite=Strict cookie `trace_rt` scoped to `/api/auth`.
- **Every mutating `/api/call` publishes a live event** to the people on that project (from `project.members`), so
  screens update without asking again.

## Web backend endpoints (`src/web/`)

All bodies are JSON unless noted. Errors: `{ ok: false, error, code? }` with a fitting status (400, 401, 403, 404, 429,
500). Authenticated endpoints take `Authorization: Bearer <access token>`.

| Endpoint | Body / query | Answer |
| --- | --- | --- |
| `GET /api/config` | – | `{ region, prefix, userPoolId, clientId, events: { http, realtime }, features: { passkeys, email, voice, ops } }` |
| `POST /api/auth/start` | `{ email }` | `{ session, choices: ('passkey'\|'email_code'\|'password')[] }`: `InitiateAuth` USER_AUTH without a preferred factor |
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
| `POST /api/voice/listen` | bearer, `{ language, repo? }` | `{ url }`: signed Transcribe streaming WebSocket URL, 5 minutes; vocabulary phrases from the project when `repo` |
| `GET /api/ops?range=24h&repo=` | bearer | `{ status, tiles, alarms, sections: [{ id, title, widgets: [{ id, title, kind, unit, series: [{ label, repo?, points: [[t, v]] }] }] }], updatedAt, nextAt }` filtered by access |

## Live events (AppSync Events)

- One API, namespace `trace`. Subscribe auth: the user pool (the app passes its id token). Publish auth: IAM (the web
  backend's role only).
- Channel per person: `/trace/users/<sub>`. The namespace's `onSubscribe` handler refuses any channel whose `<sub>` is
  not the subscriber's own.
- Event: `{ type, repo?, at, ...detail }` with `type` one of `record.changed` (`{ repo, what: 'journey'|'settings'|
  'memory'|'chats'|'people'|'prompts'|'kb' }`), `job.updated` (`{ repo, jobId, state }`), `notification`
  (`{ id, kind, repo, summary }`). The app treats each as "invalidate these queries" and refetches; payloads never
  carry project content.

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
| `projects.create` | admin | onboard a repository (new or existing; reuses `src/installer/onboard-api.ts`), register it, assign people with parts, write the journey record's first state from the template; returns what was done and what waits (the project's own cloud resources come with the next stack update, shown as a wait) |
| `journey.get` | read | the project's journey: template, revision, stages (state, criteria met/total, reopened), gates (state, criteria, evidence, waivers, signature), next step, questions, waivers, decisions log |
| `journey.criterion.open` | read | records that this person opened a criterion's evidence (the Sign button needs it) |
| `gate.sign` / `gate.return` | admin / write | sign (every criterion met or waived, evidence opened, waivers acknowledged) or return with a reason; a signature that cuts a release also copies the record into the repository |
| `journey.snapshot` | admin | copy the journey record into the repository's `.trace/project.db` on a `trace/release-…` branch and log the commit |
| `question.answer` | write | answer an agent's question (the recommended option or another with a reason) |
| `waiver.add` | write | a waiver with reason, risk, severity, where it is caught instead |
| `inbox` | signed-in | the four kinds that earn a notification across the person's projects, oldest and most blocking first |
| `chats.list` / `chats.get` / `chats.append` / `chats.rename` / `chats.recall` | read | threads per project (visible to everyone on it), messages, the person's own sent messages newest first |
| `me.get` / `me.set` | signed-in | the person's preferences (one JSON document, `key` paths), and per-table views |
| `graph.neighbourhood` | read | `{ nodes, links }` around a focus item, depth 1–3, from the project record, memory and the knowledge base |
| `files.list` / `files.url` | read | the project's files by kind, and a short-lived signed URL (or bytes) for one |

The journey record is new tables (`src/core/journey.ts`): `journey` (template, revision, current stage), `stages`,
`gates`, `gate_criteria`, `criterion_opens`, `gate_signatures`, `questions`, `waivers`, `decisions`. Templates (Board,
FPGA, Firmware, Mixed) define stages and gate criteria as in [user-journey.md](user-journey.md). The live record is not
in the repository: it is one SQLite database per project in the central bucket, `projects/<slug>/journey/journey.db`
(`src/core/journey-store.ts`), read and written with conditional puts like the central store and chats (a lost race
is re-run on a fresh copy); every write answers the record's `version`. When a release is cut (signing the gate the
Release stage follows) the record is copied into the repository: the default branch's `.trace/project.db` with its
journey tables replaced, committed on `trace/release-<revision>-<time>` the way `settings.set` writes, and the commit
logged in the decisions; `journey.snapshot` (admin) makes the same copy on demand. A project whose journey an older
install kept in `.trace/project.db` has it imported into the bucket on first read. Chats and preferences are not in
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
