# Project repositories on trace's own GitLab

Status: design, November 2026; open questions settled 16 November 2026; projects move both ways (16 November 2026). Decided 16 November 2026 (Marc): project repositories move from GitHub to a GitLab
that trace's installer deploys in the installation's own AWS account. trace's own development stays on GitHub
(`mteichtahl/trace`), as does the installation's self-update from trace's `main`.

## Why

Projects are the designs people make with trace. Keeping them on a GitLab inside the installation's own account means
the designs never leave that account, an installation does not depend on a GitHub account for its projects, and the
code host follows the same rules as the rest of trace (installed, upgraded and backed up by the installer).

## What stays the same

Everything a person sees. People already never go into GitHub ([stay-in-trace.md](stay-in-trace.md)), so the move is
behind the app: the same changes, checks, gates, stacked changes, deploy approvals, logs and progress. Admins' "More"
menu links to GitLab in place of GitHub. Builds still run on AWS CodeBuild: CodeBuild has hosted runners for
self-managed GitLab (February 2025), reached through CodeConnections as the GitHub runners are today.

## Decisions

- **Only project repositories can live on GitLab.** trace's own repository, its pull requests, CI and the installation's self-update
  stay on GitHub. An installation that reads `mteichtahl/trace` anonymously and keeps every project on
  its GitLab needs no GitHub token at all; the installer then asks for AWS credentials only.
- **The installer deploys GitLab Community Edition** (free) in the installation's account, from the same CDK app:
  - one EC2 instance (Graviton, `m7g.large` by default) running the official GitLab Omnibus package on Amazon Linux
    2023 (8 GB memory; GitLab's minimum is 4 GB, and trace runs CI on CodeBuild, not on the instance, so it never needs
    more for build load), in a private subnet with no SSH and no public address (admins reach the machine with Session
    Manager),
  - its data on an encrypted EBS volume with daily snapshots kept 14 days (Data Lifecycle Manager) and GitLab's own
    backup to the central bucket nightly,
  - reached over HTTPS through CloudFront, with the instance as a VPC origin, so only CloudFront's origin-facing
    addresses can reach it (the installation's own `*.cloudfront.net` address, nothing to buy or set up), git over
    HTTPS only, no SSH; it learns its address from `/<prefix>/gitlab/external-url` in SSM and follows it when it
    changes,
  - its root password and an admin token in Secrets Manager (`<prefix>/gitlab/root`, `<prefix>/gitlab/admin-token`),
    created by the installer on first start, never shown,
  - upgraded by the installer on GitLab's supported upgrade path, one required stop at a time, after a snapshot.
- **No Premium features.** Everything trace relies on exists in Community Edition: protected branches, merge requests
  with a target branch, auto-merge when the pipeline succeeds, labels, notes, webhooks, environments, pipeline ID
  tokens. Approvals are already trace's own (gates, deploy approvals verified by the deploy job), so GitLab's Premium
  approval rules, code owners and protected-environment approvals are not needed.
- **Two identities, as on GitHub** ([agent-identity.md](agent-identity.md)):
  - **trace's API** holds the admin token and is the only thing that merges.
  - **The agents** act as their project's own bot. Each project gets a **project access token with the Developer role**
    (`trace-agents`; GitLab gives each such token its own bot user, whose username is the project's TRACE_AGENT_LOGIN,
    so one project's agents can never reach another's), made by the installer (src/installer/gitlab-setup.ts). A
    function, `<prefix>-gitlab-token-rotate` (src/core/gitlab-token.ts), checks each one twice a day and rotates it about once
    a day in practice (tokens live three days and are rotated with fewer than two left), and keeps its current value at
    `<prefix>/gitlab/agents/<slug>`, which only that project's own roles may read: so a project's agents reach their
    own project and no other, as the GitHub broker gives. GitLab's rotate keeps the token's bot user, so
    TRACE_AGENT_LOGIN never changes; it revokes the old value at once, so a caller reads the secret again and retries
    once on a 401.
  - **Each default branch is protected**: push allowed to no one, merge allowed to Maintainers. A Developer may push
    branches and open merge requests but cannot merge, so the guard GitHub needed a ruleset bypass and a live proof for
    is GitLab's ordinary role model. `.gitlab-ci.yml` and `trace/**` changes are held the same way as today's protected
    paths: by the API's merge rule (GitLab's push rules are a Premium feature, so trace does not rely on them).
- **CI moves to `.gitlab-ci.yml`.** The four project workflows (`trace-ci`, `trace-deploy`, `trace-prs`,
  `trace-worker`) become jobs in one generated `.gitlab-ci.yml`, tagged for that project's CodeBuild runner. The harness
  is the same bundled code, run as a Node script in a job instead of a GitHub Action, against a `Forge` client (below).
  Jobs reach AWS with GitLab's pipeline ID tokens (`id_tokens`) and an IAM OIDC provider for the installation's GitLab
  address; role trust uses GitLab's subject (`project_path:<group>/<project>:ref_type:branch:ref:<branch>`), so the
  default-branch-only and any-branch roles keep their meaning.
- **One `Forge` interface.** `GitHubApi` (src/api/github.ts) and the harness's direct Octokit use become one interface
  with a GitLab implementation. Merge requests carry what pull requests did; pipelines and jobs stand in for check runs
  and statuses; GitLab environments and deployments for GitHub's. trace's words in the app do not change ("change",
  "checks").
- **Events come from GitLab webhooks** to the same hooks function (`/api/hooks/gitlab`, src/web/hooks.ts), verified by
  `X-Gitlab-Token` against the same webhook secret as GitHub's, the project named by the hook's own address
  (`?repo=owner/name`, as GitLab names it by its path): merge request, pipeline, job, note, push and deployment events, mapped to the events
  `hook.apply` handles today. One hook per project (GitLab's group webhooks are a Premium feature).
- **Stacked changes keep working.** A dependent change's merge request targets its parent's branch, as now. GitLab
  retargets dependent merge requests on its own when the one below merges; the restack job still merges `main` up and
  reports conflicts, and trace's conflict resolver handles them as today.
- **All projects live in one GitLab group**, the installation's prefix; a project's path there is its repository's
  name (`<prefix>/<name>`, src/core/gitlab-path.ts). A project keeps its identity (`owner/name`, the key every name
  and record of it is made from) wherever it lives; only its address changes, and two GitLab projects of one
  installation may not share a name. Which forge a project is on is its `projectSettings` entry's `forge` (the
  installer's project answer `forge`).
- **Projects move both ways, as often as needed** (Marc, 16 November 2026: "allow users to move back and forth from
  GitHub and GitLab"). Each project lives on one forge at a time, chosen per project, and can move from GitHub to
  trace's GitLab and back again. So GitHub stays fully supported for projects: both forges are kept behind the `Forge`
  interface for good, and nothing that works on one may be missing on the other. See "Moving a project" below.
- **A new project's forge** is chosen when it is made: trace's GitLab by default on an installation that has one,
  GitHub otherwise. The installer asks for a GitHub token only when some project is on GitHub (or will be).

## Moving a project

**Who and where.** In the web app (Marc, 16 November 2026: "allow users to move projects via the UI"): an admin of
the project moves it from the project's Settings, never in GitHub or GitLab. `tracectl project move <slug> --to
gitlab|github` does the same for scripts. The other forge must be set up for the installation: GitLab installed, or a
GitHub token that can make repositories in the chosen owner; when it is not, the button says why and what to set up.

**The screens** (renders proposed before building, as for every UI change; approved by Marc, 16 November 2026):

- **Settings → "Where this project lives"**: the forge it is on now and its repository, and one button, "Move to
  trace's GitLab" or "Move to GitHub". On GitHub, the destination owner is asked for (the installation's default
  owner filled in).
- **Before it starts, a confirm sheet** with a summary first and detail one tap away: what moves (history, open
  changes, issues, its builds), what stays as it is (journey, chats, memory, costs, renders, orders), that the project
  is paused while it moves (about how long, from its size), and the old home archived, not deleted. trace's
  recommendation and why: move when nothing is running, and the sheet says so when something is, offering "Move when
  idle" (recommended, starts as soon as the running work finishes) or "Move now" (waits for running work at once).
- **While it moves, a progress view** in Settings and on the Overview's Next card ("Moving to trace's GitLab"): each
  step with its state (pause, copy history, recreate changes, set up builds, first checks, unpause), the step running
  now, how long it has taken and when it is next checked, and its log one tap away, as the "trace is working" indicator
  shows other work. Every project member sees it; only admins can start or cancel.
- **When it is done**, a push notification and a Next item; the Settings card shows the new home, and "Move back" is
  there at once. **When it fails**, the project is back where it was and unpaused, and the card says why in plain
  words and what to do, with "Try again".
- **On a phone**, the same, the progress view first.

**What moves.** trace does the move itself, the same code in both directions (GitHub's own importer from GitLab was
retired, and one path keeps both directions alike):

- the whole git history: every branch and tag, pushed as a mirror;
- every open change: recreated as a pull request or merge request with its title, description, labels, base branch
  (so stacks keep their shape) and author named in the description, plus one comment that carries its discussion so
  far; closed and merged changes are not recreated (their commits are in the history);
- open issues and labels;
- the project's CI: the other forge's pipeline file (`.gitlab-ci.yml` or `.github/workflows/trace-*.yml`) committed
  in one change, its CodeBuild runner, its webhook, its roles' trust (OIDC subject) and its repository settings
  (protected branch, labels), as onboarding does today.

**What stays where it is.** Everything trace keeps outside the repository: the journey record (stages, gates,
signatures, decisions), chats, agent memory, knowledge base, costs, renders, orders. They belong to the project, not to
the forge, so they come along by not moving. trace records the move in the journey, with who asked and when, and keeps
a map of each change's old number to its new one, so old links in the journey and chats still open the right change.

**While it moves.** The project is paused (as a person can pause it: no changes, no harness runs) from the moment the
move starts until the new home passes its first checks, and the Overview's Next card says "Moving to GitLab" with the
step it is on. Running jobs are let finish first; nothing is cut off mid-change. A move that fails is undone: the
project goes back to its old home, unpaused, and the reason is shown.

**The old home.** Archived (read-only), never deleted. Moving back later reuses it: the archived repository is
un-archived and brought up to date, rather than a new one being made, so its old links keep working.

**After the move.** The project's record points at the new forge (the router, src/api/forge.ts, reads it from there
instead of TRACE_GITLAB_REPOS), its agents' tokens come from the new forge's broker, and its checks run on the new
forge's pipeline on the same CodeBuild runners. People see no difference apart from the "More" menu's link.

## Rough running cost

The GitLab instance is always on: roughly US$70 to 85 a month for a Graviton instance (`m7g.large`) and 100 GB of
storage, depending on region, plus about US$35 for the NAT gateway its way out needs (packages, GitLab's webhooks to
trace), plus snapshot storage. CloudFront and CodeBuild costs are unchanged.

## Build order (a stack, each layer building and passing CI on its own)

1. This note.
2. The `Forge` interface: GitHub behind it, unchanged behaviour, then a GitLab implementation tested against fakes.
3. The GitLab stack in CDK (instance, storage, backups, CloudFront, secrets) and the installer step "Set up GitLab",
   with its health check.
4. Identity: the group and projects, their settings and labels, protected branches and the agents' project tokens
   (src/installer/gitlab-setup.ts, run by the installer for each project whose `forge` is gitlab, with its pipelines
   (committed to an empty project before its branch is protected, else proposed as a change), the update queue's
   schedule, and its webhook at gitlabHookUrl); then their rotation and the IAM OIDC provider for GitLab's pipeline ID tokens;
   then each project's forge in its settings, its roles trusting GitLab's ID tokens, its own token secret, and the API
   routing its calls there.
5. CI: the per-project CodeBuild GitLab runner project, through an AWS CodeConnections host and connection for
   trace's GitLab (made by the stack, set up once by a person in the AWS console, as the GitHub connection is: the
   installer shows the link and waits, then sets `gitlab.connectionReady`); then the generated `.gitlab-ci.yml`
   (templates/gitlab/trace.gitlab-ci.yml: open-pr, automerge, update-queue) and the harness as a pipeline job
   (src/harness/gitlab.ts, bundled to harness/dist/gitlab.cjs) with an Octokit-shaped client GitLab answers
   (src/harness/gitlab-octokit.ts), so the harness's logic is one code on both forges. Two calls have no GitLab API
   equivalent (merging one branch into another outside a merge request, the restack's, and updating a change by
   merge, the update queue's): the client does them with git in the job, as the agents, into their own branches only,
   with a merge commit (src/harness/gitlab-git.ts), so stacks restack on GitLab as on GitHub. The jobs act with TRACE_GITLAB_TOKEN, the agents'
   token the rotation also keeps as a masked project variable. ci-doctor is the build's last stage (`.post`, its
   run the pipeline itself); the worker picks and dispatches to the project's AgentCore runtime in one job (GitLab has
   no matrix from another job's output), as the project's own AWS role through GitLab's ID token; the project's own
   build is `.gitlab/build.yml`, included when present, made by the installer from its kind (templates/gitlab/build:
   empty, kicad, python, rust, as GitHub's templates/build) when missing and never overwritten after; the installer sets the pipelines' variables as it sets a
   GitHub project's. The deploy pipeline follows.
6. Events and the app: GitLab webhooks into `hook.apply`; changes, checks, logs, deploys and the admins' "More" links.
7. Stacked merge requests, restack and conflict handling on GitLab; the live smoke test running against GitLab.
8. Moving a project in both directions: the mover, the pause, the change-number map; then its screens in the web app
   (Settings, the confirm sheet, progress, done and failed; renders first) and `tracectl`.
9. The GitHub token step only when a project is on GitHub; docs.

## Settled 16 November 2026 (Marc)

- **GitLab's address: the installation's CloudFront address first, with room for your own domain.** The installer
  takes an optional host name (such as `git.trace-eda.com`) and its certificate (ACM, `us-east-1`, as CloudFront needs).
  Left empty, GitLab answers on the CloudFront address. Setting or changing it later is a re-run of the installer (or
  the Installation screen): it adds the name to CloudFront, sets GitLab's `external_url`, and moves everything that
  names the address with it: the IAM OIDC provider and every project role's trust, the CodeConnections host, the
  group webhook, project remotes in the worker runtime, and the admins' "More" links. The old address keeps
  answering until the move is done, so nothing in flight breaks. Pointing DNS at CloudFront stays with the person who
  owns the domain; the installer shows the record to add and waits until it resolves.
- **Admins only get GitLab accounts.** trace keeps one GitLab account per trace admin in step with trace's admins
  (made, blocked when no longer an admin), reached from "More". Everyone else stays in trace.
- **GitLab Community Edition** (free).
