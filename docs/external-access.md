# External access: letting other systems talk to trace

Status: design, October 2026. Built on the branch `claude/external-access`.

## Summary

Other systems reach trace through **connected systems**: an admin creates one per outside system, gives it a name,
what it may do (read, or read and write) and which projects it is on (as a contributor or a reviewer, like a person).
trace gives back a client id and a secret, shown once. The system swaps them for a short-lived token at the
installation's sign-in address and calls trace in one of two ways:

| Way in | For | Address | Speaks |
| --- | --- | --- | --- |
| **External API** | scripts, pipelines, other services | the `external` runtime's `/invocations` | the same `{ action, ...args }` JSON as the people's API |
| **MCP endpoint** | AI agents and MCP clients | the `mcp` runtime's `/invocations` | MCP (streamable HTTP), one tool per allowed action |

Both are off until an admin turns on **External access** in the installer (`external.enabled`). With it off nothing
below exists in the account. With it on but no connected systems, nothing can get in: every token must come from a
connected system that is enabled.

People keep using the existing API runtime and web app. Nothing about how a person signs in changes.

```
  outside system ──client id + secret──▶ Cognito /oauth2/token ──access token (1 h)──┐
                                                                                      │ Bearer
           ┌──────────────────────────────────────────────────────────────────────────┤
           ▼                                                                          ▼
  trace-external (AgentCore, HTTP)                                   trace-mcp (AgentCore, MCP)
    authorizer: scope trace-external/read|write                        authorizer: same scopes
    verifies again; looks up the connected system                      no AWS permissions of its own
    perform(action) with the system's principal  ◀──── forwards each tool call with the caller's token
    (the API role: same code, same checks)
```

## Decisions

Each has the recommendation that was taken, and the alternative not taken.

| Decision | Taken | Why | Not taken |
| --- | --- | --- | --- |
| How a system proves who it is | OAuth client credentials: one Cognito app client per connected system, with a secret | The standard for machine-to-machine; every MCP client and HTTP library supports it; Cognito rotates secrets (two at a time) and revokes by deleting the client | API keys stored by trace: a second credential system to build and secure; signing in as a "robot person": passwords and refresh tokens, and no scopes |
| Where systems come in | Two new AgentCore runtimes, `external` and `mcp`, beside the people's API runtime | The people's runtime keeps its exact authorizer (its two app clients). A mistake in the new door can't lock people out | Widening the people's runtime's authorizer to scopes: one door for both, but a fault there stops every person |
| How the MCP endpoint enforces access | It forwards every tool call to the `external` runtime with the caller's own token | One place decides access (the `external` runtime, running the API's `perform`); the MCP runtime holds no AWS permissions | Running `perform` in the MCP runtime too: one hop less, but a second copy of the API role to keep tight |
| Library gateway | Unchanged | It runs with its own role and can't tell callers apart, so it stays internal (README "Library gateway") | Opening it to systems: it would reach the shared library for anyone with a token |
| What a system can be on | Projects, with a part, exactly like a person; never an admin | The existing access model applies unchanged: a reviewer reads, a contributor writes; a project it's not on does not exist for it | A per-system policy language: more to learn, and a second model to audit |
| What a system can do at all | A fixed list of actions (below), further limited by its scopes | Some actions are a person's by nature: signing gates, answering questions asked of a person, waivers, decisions, orders, chats, preferences. An allow-list fails closed when new actions are added | A deny-list: every new action would be open to systems by default |
| Revocation | Disabling a system stops it at once; deleting it also deletes its Cognito client | The `external` runtime checks the access store on every call (cached 30 s), so a disabled system's tokens stop working within 30 seconds, not when they expire | Waiting for the token to expire (up to an hour) |
| Secrets | Shown once, never stored by trace. Rotation adds a second secret; the old one is removed when the admin says so | Cognito holds the secret; nothing to leak from trace's stores | Keeping secrets in Secrets Manager for later display: a store of every outside system's keys |
| Token lifetime | 1 hour; systems should reuse a token until it nears expiry | Cognito charges per machine-to-machine token request; reuse keeps cost near zero | 5 minutes: safer if leaked, but twelve times the requests |
| Address | The AgentCore runtime URLs, given in full on the admin screen with copy buttons and ready-made snippets | Works with no extra infrastructure | A friendly `/api/external` and `/mcp` on the web app's address through CloudFront: a later step, noted below |

## Connected systems

A connected system is a row in the access store (`services` table) plus a Cognito app client:

| Field | Meaning |
| --- | --- |
| `client_id` | the Cognito app client id; also the system's `sub` (Cognito sets a client-credentials token's `sub` to its client id) |
| `name` | a short name, unique, `^[a-z][a-z0-9-]{1,39}$` (for logs and the app: "service:ci-dashboard") |
| `description` | what it is for, up to 500 characters |
| `scopes` | `read`, or `read` and `write` |
| `disabled` | stops it at once |
| `created_by`, `created_at`, `last_used` | for the audit trail and the admin screen |

Its project assignments live in the existing `assignments` table, keyed by its `sub`, with a part. Its class is
derived, never stored as admin: a system with the `write` scope counts as a **user** (so it can be a contributor), one
with only `read` counts as a **guest** (always a reviewer). The assignment log records every change, as for people.

Cognito side: one resource server `trace-external` with scopes `read` and `write`, created by the stack. Each
connected system's app client is created by the API runtime when an admin asks (`CreateUserPoolClient`, client
credentials only, a secret, the chosen scopes, access tokens of one hour), named `<prefix>-svc-<name>`.

## The principal

A verified service token becomes a `Principal` like a person's, with two more fields:

```ts
{ sub: client_id, email: null, groups: ['trace-users'] | ['trace-guests'], kind: 'service', name: 'ci-dashboard' }
```

So every existing check (`require_`, `partIn`, `projectsFor`, the `job` ownership check) works unchanged. Logs and
records show `service:<name>` where they would show a person's email. A token is accepted only when all of these hold:

1. signature, issuer and time, as today (`src/api/jwt.ts`);
2. `token_use` is `access`, there is no `username` claim (a person's token always has one), and `scope` contains
   `trace-external/read` or `trace-external/write`;
3. `client_id` is a connected system in the access store, and it is not disabled;
4. the token's scopes are a subset of the scopes the system has now (an admin who removed `write` is obeyed at once).

## What a system may do

The allow-list (`SERVICE_ACTIONS` in `src/api/service-policy.ts`) and the scope each needs. Anything not here answers
"no access", the same words as a project that isn't yours.

| Scope | Actions |
| --- | --- |
| `read` | `whoami`, `projects`, `installation.layout`, `status`, `settings.get`, `runs`, `run`, `artifact`, `jobs.list`, `job`, `journey.get`, `requirements.trace`, `design.get`, `build.get`, `cost.get`, `files.list`, `files.url`, `graph.neighbourhood`, `kb.search`, `tools.list`, `tools.waits`, `tool` (read-only tools) |
| `write` | `task`, `job.control` (its own jobs), `settings.set` (opens a pull request a person merges), `kb.sync`, `tool` (tools that record runs) |

Never, whatever the scope: anything that needs an admin; signing or returning gates; answering questions; waivers;
design decisions; orders; chats; preferences and `me.*`; memory; prompts; skills; people and assignments; voice; the
inbox. These are a person's by the rules in `docs/user-journey.md` (gates are signed by a person; trace prepares orders
and a person submits them).

The scope is checked first, then the project part, so `write` on a project where the system is a reviewer still reads
only.

## External API

`POST /invocations` on the `external` runtime, exactly the people's API contract (`src/api/server.ts`): body
`{ action, ...args }`, `Authorization: Bearer <access token>`, answers `{ ok, result | error }`, 401 for a token that
isn't accepted, 403 `no access`. `GET /ping` for health.

Same code: `TRACE_AGENT_MODE=external` starts the API server with the service verifier in place of the people's, and
the service policy in front of `perform`. It runs with the API's role.

Per-system soft limit: 10 requests per second, bursting to 20, per container; over it answers 429 with
`Retry-After`. Every request is logged as the API logs (who is `service:<name>`), and `last_used` is updated at most
once a minute.

## MCP endpoint

`TRACE_AGENT_MODE=mcp` on an AgentCore runtime with the MCP protocol: a stateless streamable-HTTP MCP server on
`0.0.0.0:8000/mcp` (what AgentCore requires).

- **Tools**: one per allowed action the caller's scopes permit, named `trace_<action>` with dots as underscores
  (`trace_journey_get`), described in plain words (`src/mcp-remote/descriptions.ts`), with an input schema made from
  the action's zod arguments (`z.toJSONSchema`). `tools/list` hides write tools from a read-only system.
- **Calls**: forwarded to the `external` runtime with the caller's own bearer token
  (`src/api/runtime-url.ts`), and the answer returned as text JSON. An `ok: false` answer is a tool result with
  `isError` set, so the model reads it and adjusts. A 401 or 403 becomes an MCP error.
- The runtime's role can write its own logs and traces and nothing else. It has the `external` runtime's ARN in its
  environment (`TRACE_EXTERNAL_RUNTIME_ARN`), and makes the address from it.

Connecting an MCP client (Claude Code, for example):

```json
{ "type": "http", "url": "<mcp url>", "headers": { "Authorization": "Bearer <access token>" } }
```

Clients that do OAuth themselves are pointed at the token address with the client id and secret.

## Managing connected systems

API actions, admins only:

| Action | Arguments | Result |
| --- | --- | --- |
| `services.list` | | every system with its scopes, projects and parts, disabled, last used |
| `services.create` | `name`, `description?`, `scopes`, `projects?: [{ repo, part }]` | the system, its `client_id`, its `secret` (only here), the token, API and MCP addresses |
| `services.update` | `name`, `description?`, `scopes?`, `disabled?` | the system |
| `services.assign` | `name`, `repo`, `part?` | the assignment (a read-only system is always a reviewer) |
| `services.unassign` | `name`, `repo` | whether it was on it |
| `services.rotate` | `name` | a new `secret`, shown once; the old one keeps working |
| `services.retire_secret` | `name`, `secret_id` | removes an old secret |
| `services.delete` | `name` | deletes the Cognito client and every assignment; logged |
| `services.history` | `name` | its assignment log, in words |

The same from the command line: `tracectl services create NAME --scope read|write --project OWNER/REPO[:reviewer]`,
`list`, `show`, `disable`, `enable`, `assign`, `unassign`, `rotate`, `retire-secret`, `delete`.

In the web app: **Admin → Connected systems**, a table (TanStack, like People) and a create sheet. After creating,
one screen shows the client id and the secret with copy buttons and the words "This secret is shown once", the token,
API and MCP addresses, and three ready-made snippets: get a token with curl, call the API, and add the MCP endpoint
to an MCP client. Each system's page shows its projects and parts, scopes, last used, secrets (by id and date, never
the value), its history, and Disable, Rotate secret and Delete (with a typed confirmation).

## Infrastructure

Only with `external.enabled` (`src/infra/external.ts`, the `ExternalAccess` construct; the installer's **External
access** switch). With it off the template is the same as without the feature (`test/infra/external.test.ts`).

- A Cognito resource server on the people's pool, identifier `trace-external`, scopes `read` ("read the projects the
  system is on") and `write` ("start work and change settings on the projects the system contributes to").
- `CfnRuntime` `<prefix>_external` (dashes become underscores, as for `<prefix>_api`): the agent image, the API's role,
  HTTP protocol, the API's network, session limits and file system, `Authorization` passed through. Authorizer
  `{ discoveryUrl (the API's), allowedScopes: ['trace-external/read', 'trace-external/write'] }`, with no
  `allowedClients`: connected systems' clients are made at run time, and AgentCore requires every configured check to
  pass. Its environment is the API's (built once in `stack.ts`) with `TRACE_AGENT_MODE=external`, plus
  `TRACE_TOKEN_URL` and `TRACE_EXTERNAL_RESOURCE_SERVER`. It is never told its own ARN or the MCP runtime's.
- `CfnRuntime` `<prefix>_mcp`: same image, MCP protocol, the same authorizer, its own role `<prefix>-agent-mcp-<region>`
  (pull the agent image, write its own runtime's logs, X-Ray spans, `cloudwatch:PutMetricData` in the
  `bedrock-agentcore` namespace, and the span destination's `logs:PutResourcePolicy`; nothing else). Environment:
  `AWS_REGION`, `TRACE_AGENT_MODE=mcp`, `TRACE_PREFIX`, `TRACE_EXTERNAL_RUNTIME_ARN` (the external runtime: the code
  makes its address with `src/api/runtime-url.ts`), `TRACE_EXTERNAL_RESOURCE_SERVER`, `TRACE_COGNITO_ISSUER`,
  `TRACE_TOKEN_URL`, and the observability settings every runtime gets.
- The API role gains one statement, `ManageConnectedSystemClients`: `cognito-idp:CreateUserPoolClient`,
  `UpdateUserPoolClient`, `DeleteUserPoolClient`, `DescribeUserPoolClient`, `AddUserPoolClientSecret`,
  `DeleteUserPoolClientSecret`, `ListUserPoolClientSecrets` on the pool's ARN; and the external runtime's log group
  (it runs that runtime too).
- The people's API runtime gets `TRACE_EXTERNAL_RUNTIME_ARN`, `TRACE_MCP_RUNTIME_ARN`, `TRACE_TOKEN_URL`
  (`<the pool's domain>/oauth2/token`) and `TRACE_EXTERNAL_RESOURCE_SERVER` (it has `TRACE_PREFIX` already), so
  `services.create` can give the addresses.
- Outputs: `ExternalApiUrl` and `McpUrl` (the full invocation URLs,
  `https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<ARN, ':' and '/' encoded>/invocations?qualifier=DEFAULT`,
  made in the template with `Fn::Split`/`Fn::Join`: what `encodeURIComponent` makes of a runtime ARN), `TokenUrl`,
  `ExternalResourceServer`.
- Observability: both runtimes join the dashboard and get `ExternalLogGroup` and `McpLogGroup` outputs, as the API's
  `ApiLogGroup`.
- Names: the prefix must make runtime names AgentCore accepts (`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`); the settings refuse one
  that doesn't, rather than cutting it short. Every prefix the settings accept (21 characters at most) fits.

## Cost

AgentCore runtimes cost nothing while idle. Cognito charges for machine-to-machine use per app client and per token
request: a system that reuses its token for the hour makes about 720 requests a month. The admin screen says so beside
**Create**.

## Later

- A friendly address on the web app's domain (CloudFront `/api/external/*` and `/mcp`), so systems don't see AgentCore
  URLs.
- People connecting their own MCP clients (Claude, for example) with their own sign-in, through OAuth authorization
  code on the CLI's hosted domain. Today a person uses `tracectl mcp` locally.
- Events out: webhooks to a connected system when a gate is signed or a job finishes, from the journey events that
  exist already.
