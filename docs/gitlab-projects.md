# Project repositories on trace's own GitLab

Status: design, November 2026; open questions settled 16 November 2026. Decided 16 November 2026 (Marc): project repositories move from GitHub to a GitLab
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

- **Only project repositories move.** trace's own repository, its pull requests, CI and the installation's self-update
  stay on GitHub. An installation that reads `mteichtahl/trace` anonymously needs no GitHub token at all; the
  installer then asks for AWS credentials only.
- **The installer deploys GitLab Community Edition** (free) in the installation's account, from the same CDK app:
  - one EC2 instance running the official GitLab Omnibus package (8 GB memory class; GitLab's minimum is 4 GB, and
    trace runs CI on CodeBuild, not on the instance, so it never needs more for build load),
  - its data on an encrypted EBS volume with daily snapshots kept 14 days (Data Lifecycle Manager) and GitLab's own
    backup to the central bucket nightly,
  - in a private subnet, reached over HTTPS through CloudFront (the installation's own `*.cloudfront.net` address,
    nothing to buy or set up), git over HTTPS only, no SSH,
  - its root password and an admin token in Secrets Manager (`<prefix>/gitlab/root`, `<prefix>/gitlab/admin-token`),
    created by the installer on first start, never shown,
  - upgraded by the installer on GitLab's supported upgrade path, one required stop at a time, after a snapshot.
- **No Premium features.** Everything trace relies on exists in Community Edition: protected branches, merge requests
  with a target branch, auto-merge when the pipeline succeeds, labels, notes, webhooks, environments, pipeline ID
  tokens. Approvals are already trace's own (gates, deploy approvals verified by the deploy job), so GitLab's Premium
  approval rules, code owners and protected-environment approvals are not needed.
- **Two identities, as on GitHub** ([agent-identity.md](agent-identity.md)):
  - **trace's API** holds the admin token and is the only thing that merges.
  - **The agents** act as a `trace-bot` user. Each project gets a **project access token with the Developer role**,
    minted and rotated by the existing token broker (`<prefix>-github-app-token` becomes `<prefix>-forge-token`): it
    decides the project from the caller's IAM role, never from the request, exactly as today. Tokens last one day (the
    shortest GitLab allows) and the broker rotates them every twelve hours.
  - **Each default branch is protected**: push allowed to no one, merge allowed to Maintainers. A Developer may push
    branches and open merge requests but cannot merge, so the guard GitHub needed a ruleset bypass and a live proof for
    is GitLab's ordinary role model. `.gitlab-ci.yml` and `trace/**` changes are held the same way as today's protected
    paths: by the API's merge rule, plus a push rule rejecting the bot's commits to `.gitlab-ci.yml`.
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
- **Events come from GitLab webhooks** to the same hooks endpoint, verified by `X-Gitlab-Token` against the secret in
  `<prefix>/web/forge-hooks`: merge request, pipeline, job, note, push and deployment events, mapped to the events
  `hook.apply` handles today. One group-level hook covers every project.
- **Stacked changes keep working.** A dependent change's merge request targets its parent's branch, as now. GitLab
  retargets dependent merge requests on its own when the one below merges; the restack job still merges `main` up and
  reports conflicts, and trace's conflict resolver handles them as today.
- **All projects live in one GitLab group**, `trace`, named per installation; a project's path is its slug.
- **Existing GitHub projects move, with their history.** The installer (and an admin's "Move projects to GitLab" in the
  web app's Installation screen) imports each project repository with GitLab's GitHub importer (repository, branches,
  open pull requests as merge requests, labels, comments), points the project's record at GitLab, and archives the
  GitHub repository rather than deleting it. Open work carries on from the imported merge requests.
- **GitHub support for projects is removed** once every project of every installation has moved, not before: the
  `Forge` interface keeps the GitHub implementation until then, so nothing breaks mid-move.

## Rough running cost

The GitLab instance is always on: roughly US$75 to 95 a month for the instance and its storage, depending on region,
plus snapshot storage. CloudFront and CodeBuild costs are unchanged.

## Build order (a stack, each layer building and passing CI on its own)

1. This note.
2. The `Forge` interface: GitHub behind it, unchanged behaviour, then a GitLab implementation tested against fakes.
3. The GitLab stack in CDK (instance, storage, backups, CloudFront, secrets) and the installer step "Set up GitLab",
   with its health check.
4. Identity: the `trace-bot` user, protected branches, the broker minting project access tokens, the IAM OIDC provider
   and role trust.
5. CI: the generated `.gitlab-ci.yml`, the harness as a script, the per-project CodeBuild GitLab runner project.
6. Events and the app: GitLab webhooks into `hook.apply`; changes, checks, logs, deploys and the admins' "More" links.
7. Stacked merge requests, restack and conflict handling on GitLab; the live smoke test running against GitLab.
8. Moving existing projects (installer and Installation screen).
9. Removing GitHub project code paths and the GitHub token step for projects; docs.

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
