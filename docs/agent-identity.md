# Agent identity: trace's agents act as trace's own GitHub app

The build contract for giving trace's agents their own GitHub identity (Marc, 3 November 2026: "a trace GitHub app").
It follows [stay-in-trace.md](stay-in-trace.md), whose security review left one gap.

## Why

Today one person's GitHub token does everything: the API merges with it, the agents push and open pull requests with
it (the repository secret `TRACE_TOKEN`, and `<prefix>/github-token/<slug>` for the worker runtime), and the workflows
merge with it. GitHub has no token that may push a branch but not merge one, so an agent with Bash and that token can
merge anything, including a change to the files that steer trace, past the hold label. Code owners' review is the only
thing GitHub itself enforces against that, and it is a review given on GitHub, so projects with `worker.escalate_to`
set cannot stay in trace.

The fix is two identities: the person's token, which only trace's own API holds and which may merge; and trace's GitHub
app, which the agents and workflows act as, and which may push branches and open pull requests but never update the
default branch.

## Decisions

- **A GitHub app per installation**, named `trace-<prefix>`, made by the installer from a manifest (GitHub's
  one-click "Create GitHub App" page), installed on the projects' repositories (GitHub's install page). Its private key
  is kept in Secrets Manager (`<prefix>/github-app`) and nowhere else: never in a repository secret, never in an
  agent's environment.
- **Its permissions**: contents, pull requests and issues write; actions, checks, statuses and metadata read. Not
  `workflows`: GitHub then refuses any push of the app's that changes `.github/workflows/**`, a second guard on the
  files that steer trace. Not administration.
- **Tokens come from a broker.** A Lambda function (`<prefix>-github-app-token`), reached through its function URL
  with IAM sign-in, mints an installation token for one repository only. It decides the repository from who is asking
  (`requestContext.authorizer.iam.userArn`: a project's worker role or its GitHub OIDC role, matched against the
  installation's registry of roles), never from the request. A token lasts an hour; callers refresh it ten minutes
  before. So an agent can reach its own project's repository and no other, as with per-project tokens today.
- **Only trace's API updates the default branch.** The "trace" ruleset gains `update` (restrict updates) with one bypass
  actor: the repository admin role, which the person whose token the API holds has. The app is not an admin, so it
  cannot merge. Code owners' review comes out of the ruleset again: it is no longer the only guard.
- **Merging that happened in workflows moves into trace.** The harness's `automerge` (merge a green pull request that
  is not held and changes no protected path) runs in the API, in `hook.apply`, after every GitHub event, with the same
  rules. The workflow's `automerge` job keeps holding pull requests (label, comment) and stops merging. `updateQueue`
  (bringing pull requests up to date) stays in the workflow: it never writes the default branch.
- **Checked live, once per repository.** GitHub's documentation does not settle whether `update` with a role bypass
  lets an admin merge through the REST API. After the installer applies the ruleset it proves both halves on a
  throwaway branch: the app's merge is refused, the API's merge goes through (then reverted by deleting the branch, never
  touching the default branch: the check merges into a scratch branch the ruleset also covers). A repository where the
  proof fails keeps code owners' review and says so.
- **`TRACE_AGENT_LOGIN` becomes the app's bot login** (`trace-<prefix>[bot]`). The change rule (a change is trace's
  when the agents' login opened it), the deploy refusal (bots never approve) and `trustedAuthor` keep working unchanged.
- **Existing installations change when the admin runs the installer once more**, or from the web app's Installation
  page ("Give the agents their own identity"), which runs the same manifest flow with the web app as the return page.
  Until then everything works as today.

## Pieces

1. **The app and its broker** (`src/installer/github-app.ts`, `src/infra/github-app.ts`, `src/infra/lambda/github-app-token.ts`):
   the manifest, the code exchange, storing the key; the Lambda, its function URL (AWS_IAM), the roles allowed to call
   it, the repository each role maps to.
2. **The agents and workflows use it** (`src/agents/runtime/job.ts` and `tool.ts`: the token from the broker, refreshed;
   `harness/actions/run/action.yml` and the workflow templates: a step that asks the broker with the job's OIDC role,
   in place of `secrets.TRACE_TOKEN`).
3. **Merging in trace** (`src/api/automerge.ts`, called from `hook.apply`): the harness's automerge rules, with the
   API's token; `src/harness/prs.ts` `automerge` stops merging when the app is in use.
4. **The ruleset and its live check** (`traceRuleset`, `repo.rules.fix`, `src/installer/ruleset-check.ts`).
5. **The installer and the web app's Installation page**: the step that makes the app (screens proposed separately,
   before they are built).

## Not changing

The person's token still does what only a person's token can: the installer's own setup, the API's merges and
rulesets, webhooks, and CodeBuild's source credential when the runners use a token.
