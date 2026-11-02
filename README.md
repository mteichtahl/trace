# trace

trace runs a repository by itself and gives Claude the tools to do electronics work in it. It is generalised from
the loop that runs Potroller.

- **The loop.** A pushed branch gets its pull request. A PR merges itself when its required check passes, and open
  PRs are brought up to date one at a time. A failing build is triaged: flaky failures are re-run, and real ones go to
  Claude, which fixes them. Deploys run behind a risk check, a smoke test and an automatic rollback. A person is asked
  only when a project's rules say so, or when the loop is stuck.
- **The tools.** These cover KiCad (reading schematics and boards, ERC/DRC, BOM, fabrication outputs), component
  calculators, SPICE and Verilog simulation, a datasheet library and parts database shared by every project,
  hardware-in-the-loop (serial, CAN, and SCPI power supplies, scopes and meters), and the firmware loop (build, flash,
  logs). They are reachable from the `tracectl` CLI and, for Claude Code, from the `trace` MCP server.

## Installing

```sh
npm install -g github:mteichtahl/trace#main    # the `tracectl` CLI (Node 22.13+; git, which this needs anyway)
tracectl install                               # opens the installer in your browser
```

The command is `tracectl`, not `trace`: macOS ships its own `/usr/bin/trace` (kernel tracing), and a `trace` on
`PATH` would shadow it, or be shadowed by it wherever nvm's directory is not first (sudo, cron, launchd). The
product, the MCP server (`claude mcp add trace -- tracectl mcp`) and `.trace/` keep the name.

**What you need:** AWS credentials (a profile, SSO included, or access keys; an administrator is simplest) and one
GitHub token. Nothing else: no Docker, no `gh` CLI, no KiCad or Python on this machine (the images build in
CodeBuild, and onboarding talks to GitHub's API and `git`).

The token: a fine-grained token (github.com/settings/personal-access-tokens) on the repositories trace will run, with
Contents, Pull requests, Issues, Workflows, Actions, Secrets, Variables, Administration and Webhooks read and write,
Deployments read, and the account permission "Email addresses: read"; or a classic token with `repo`, `workflow` and `user:email`. What each
permission is for, and what happens without it, is in [Tokens and permissions](#tokens-and-permissions).

Builds need nothing more. Every GitHub Actions job runs on an AWS CodeBuild runner in your account, trace's own
repository's included, and on GitHub's runners only until that runner exists. CodeBuild reaches GitHub through an AWS
CodeConnections connection already authorized in the account and region when there is one, else through that same
token (see [Where builds run](#where-builds-run)), so the first deploy has the runners and no console step is needed.

The installer is a page served from your own machine (127.0.0.1, with a one-time key in its address). It has four
steps, and only the first asks for anything:

1. **Connect.** The credentials and the token, then **Check**. Everything below is checked at once, before anything
   is created, and each finding says what to do (`src/installer/preflight.ts`); where the installer can fix it itself
   it offers a button, and does nothing until you press it.
2. **Projects.** The repositories the token sees, to tick, or **Create a new project** (a repository made and
   scaffolded from a KiCad, Rust, Python or empty template), or **Install the sample project** (see
   [The sample project](#the-sample-project)). None is fine: install now, add repositories by running the installer
   again.
3. **Integrations (optional).** Keys for Nexar, Mouser or Digi-Key, each checked with its service. Skippable; see
   [Optional integrations](#optional-integrations).
4. **Review.** The plan, how long it takes, and **Advanced**, which holds every other setting with its default.

**Worked out, not asked** (`src/installer/derive.ts`):

| Setting | From |
| --- | --- |
| Account | STS `GetCallerIdentity` (a second run stops if the credentials now resolve to another account) |
| Region | The profile's region, else `us-east-1` (Advanced to change) |
| GitHub login | The token (`GET /user`) |
| First administrator | The token's verified primary email (`GET /user/emails`); asked for under Advanced only when the token cannot see it |
| Model | The newest Claude Sonnet inference profile active in the region, the region's geography before `global.` |
| GPU and CPU jobs | On when the account's quotas allow one job (G and VT instances for GPU, standard instances for CPU), else off |
| Knowledge bases | On where the region has Amazon S3 Vectors |
| Prefix, session limits, bucket, observability, images | Their defaults (`trace`, 8 h, 15 min, a named bucket, on, prebuilt) |
| How the build runners reach GitHub | An authorized GitHub connection in the account and region, else the token ([Where builds run](#where-builds-run)) |
| Web app | On, at CloudFront's own address; a custom domain and email sign-in codes are optional ([Web app](#web-app)) |

**The preflight** checks, in parallel: the credentials; Bedrock AgentCore in the region; the model's inference
profile and the account's access to it (`GetFoundationModelAvailability`; for Anthropic, whether the one-time use-case
form was sent, `GetUseCaseForModelAccess`); Amazon S3 Vectors; the G and VT and standard-instance quotas (Service
Quotas) and the region's VPC quota; the CDK bootstrap (present, healthy, version 6 or later); the trace stack (none,
updatable, or stuck after a failed first deploy); names a removed installation kept (its image repositories and token
secret) that a new stack would collide with; the Cognito domain `<prefix>-<account>`; how the build runners will reach GitHub (an authorized GitHub connection, or
CodeBuild's GitHub credential, which with the token must be allowed to make each repository's webhook);
the token, its email, and whether trace's own actions can be used from other repositories; and, per chosen
repository, exactly which permission is missing and what that costs. What it offers to do:

| Finding | What the installer can do (on request) |
| --- | --- |
| Anthropic's first-time-use form not sent | Send it (`PutUseCaseForModelAccess`) with your answers; once per account or organisation |
| No access to the model yet | Accept its agreement (`ListFoundationModelAgreementOffers`, `CreateFoundationModelAgreement`; needs `aws-marketplace:Subscribe` and a payment method) |
| G and VT quota below one job (4 vCPUs) | Leave GPU and CPU jobs off and request 16 vCPUs (`RequestServiceQuotaIncrease`); turn them on and run again once granted |
| Standard-instance quota below one CPU job, or the region's VPCs full | Request an increase |
| The stack is `ROLLBACK_COMPLETE` (a failed first deploy) | Delete it, so the next install can create it |
| A removed installation's image repositories and token secret | Delete them |
| trace's actions not shared (a private source repository) | Share them with repositories of the same owner, when the token is its admin |

Model access never blocks installing: the stack deploys without it, and the agents work once it is granted.

It then runs the plan:

- **AWS (CDK):** one stack (bootstrapped first if needed). It contains the central bucket, the agent image and the
  tools image (both arm64, see [Images](#images-copied-or-built)), and AgentCore runtimes from the agent image: one
  worker runtime per project, each with its own execution role, GitHub OIDC role, GitHub token secret, memory,
  knowledge base, GPU and CPU job definitions, tools function (AWS Lambda, running the tools image: KiCad, Blender,
  the FPGA and verification tools, CalculiX, ffmpeg, build123d; see `agent/README.md`), cad function (the same image on
  a role with no S3, where the project's case script runs; see [Enclosures](#enclosures)) and CodeBuild build runner (see [Where builds run](#where-builds-run)), and the API runtime. Each project's
  resources are in a nested stack of their own (see [Stack layout](#stack-layout-and-limits)). A project's worker is
  invoked by that repository's workflows through IAM, and by the API. The API runtime is for people and is reached
  only with a Cognito sign-in. The stack also holds the Cognito user pool. Before the deploy, the token becomes
  CodeBuild's GitHub source credential when the runners use it; after it, only when the runners wait for a GitHub
  connection nobody has authorized yet, the installer waits for that and deploys again with them.
- **Integrations:** any keys given, stored as `<prefix>/integrations/<name>`.
- **GitHub, several repositories at once:** each repository's Actions variables (`TRACE_AWS_ROLE`,
  `TRACE_AGENT_RUNTIME_ARN`, `TRACE_MEMORY_ID`, `TRACE_KB_ID`, `TRACE_KB_DATA_SOURCE_ID` and `TRACE_CODEBUILD_PROJECT`,
  all its own project's, `TRACE_AWS_REGION`, `TRACE_HOME`, `TRACE_AGENT_LOGIN`) and its `TRACE_TOKEN` secret (its
  project's agent token, encrypted with the repository's key); and its onboarding pull request, or, when it is onboarded already and the trace workflows
  have changed, a held pull request refreshing them (`src/installer/onboard-api.ts`). trace's own repository gets
  `TRACE_CODEBUILD_PROJECT` alone, and `TRACE_UPDATE_ROLE`, `TRACE_AWS_REGION` and `TRACE_STACK` so the installation
  keeps itself up to date (see [Staying up to date](#staying-up-to-date)). `TRACE_CODEBUILD_PROJECT` is set only once
  the repository's build runner exists.
- **People:** Cognito invitations into each person's class group, at once, and project assignments recorded in the
  central database, one after another (it is one file).
- **Ready.** The page says trace is ready to use (`tracectl login`). Only then does it wait for **the GPU image**: the
  deploy starts it and does not wait for it (see [GPU jobs](#gpu-jobs-rendering-and-autorouting)), and it starts it
  again if an earlier one failed. A failed GPU image leaves GPU and CPU jobs unavailable and everything else
  installed.

**How long** (estimates from what each step does; not yet measured on a real account):

| | First install | Re-run or upgrade |
| --- | --- | --- |
| CDK bootstrap | about 2 minutes, when the region has none | none |
| The stack | about 15 minutes of CloudFormation, plus the agent image: about 5 minutes to copy a published one, 20–40 to build it | a few minutes for settings or projects; 5–10 when trace changed (the image rebuilds from its cache, or is copied) |
| Repositories, runners, onboarding, people | 1–2 minutes, in parallel | the same |
| GPU image (after trace is ready) | about 10 minutes to copy, 30–60 to build | from its cache |

Before this change the first install was the bootstrap, then 20–40 minutes for the agent image inside the deploy, then
each repository and person one after another, and only then the 30–60 minute GPU image before the page said anything
was done: about 60–110 minutes to a usable trace on a GPU-enabled account. Now it is about 20–25 minutes with a
published image (35–60 when it builds), and the GPU image no longer stands in the way.

**Running it again** updates the installation: the preflight says so, the plan lists what changes since the last run
from this machine (projects added or removed, settings changed, people), and CloudFormation leaves the rest alone.
Every step is safe to repeat. Adding or removing a repository adds or removes that project's runtime, roles, secret,
job definitions and runner.

Tokens and keys stay in the installer's memory. They are written only to Secrets Manager, to GitHub (encrypted), and,
when the build runners use the token, as CodeBuild's GitHub source credential (see [Where builds run](#where-builds-run)).

### The sample project

**Install the sample project**, on the Projects step, adds a new repository (`<your login>/trace-sample` unless you
name another): a small, finished sensor board from intent to fabrication files (`templates/sample`). It is the
quickest way to see the whole system work before you bring your own design, and it can be the only project.

- **It is a new project like any other:** the installer creates the repository with the other new ones, and it gets
  its own runtime, roles, memory, knowledge base and build runner; you can assign people to it. Onboarding fills it
  with the sample's files and settings, seeds its project database (requirements, a test plan using every method,
  analog and protocol specifications, thermal data) and pushes it all to `main`, with no pull request to merge.
  Its journey starts too, as a project made in the web app does: the Mixed template, at Define, so the web app shows
  its stages and gates from the start.
- **The tour,** last, opens one task per step of the journey (define, architect, capture, prove, layout, sign-off,
  release, bring-up), each labelled for the agent that takes it. Together they run every agent and every tool,
  every simulation included: circuit (ngspice), mixed-signal, logic, formal and coverage, FPGA synthesis and place
  and route, protocols, thermal (2.5D, CalculiX and CFD), electromagnetic (openEMS), autorouting (Freerouting and
  OrthoRoute), rendering (Blender), firmware, and hardware in the loop on an emulated bench (`tracectl hil emulate`).
  The tasks that need GPU or CPU jobs wait for the GPU image (and are left out when GPU jobs are off). The tour runs
  on AWS like any other work and costs what that work costs; untick **Start the tour** to install the sample without
  it. Running the installer again opens only the tasks that are missing.

`test/installer/sample-tour.test.ts` keeps the tour complete: a tool, agent or kind of remote job added without a
tour task fails it.

### Tokens and permissions

One token does everything. On each repository it needs:

| Permission (fine-grained) | For | Without it |
| --- | --- | --- |
| Contents, Pull requests, Issues, Workflows, Actions: read and write | The agents' work, the onboarding PR | Onboarding fails for that repository |
| Secrets, Variables: read and write | Its `TRACE_TOKEN` secret and variables | Refused for that repository, unless an admin token is given |
| Administration: read and write | Its settings and the "trace" ruleset; with the token as CodeBuild's credential, CodeBuild registering each job's runner | Settings and ruleset left alone; with the token as CodeBuild's credential the preflight stops: its runner can't be made |
| Webhooks, Commit statuses: read and write | With the token as CodeBuild's credential, its runner's workflow-job webhook; and the web app's live updates from GitHub | The same (a GitHub connection needs neither); live updates are a warning, and its screens look again every 60 s |
| Deployments: read | The project's last deploy in its status (the app and chat) | Its status says the last deploy is unreadable; the rest still shows |
| Email addresses: read (account) | The first administrator's email | The email is asked for |

A classic token needs `repo`, `workflow` and `user:email`, and its account must be an admin of each repository. The
preflight probes each permission without changing anything and names the missing ones per repository.

**The optional second token** (Advanced → Admin token): when the agents' token is deliberately narrow (no Secrets,
Variables or Administration, which the agents never need), give an admin token for the installation; it is used only
while installing and never stored, unless you choose it as the token CodeBuild keeps (Advanced → Build runners). A project's own agent token
(Advanced) isolates that project's agent on GitHub, as [Project isolation](#project-isolation) explains.

**Nothing on the default path needs the AWS console.** The preflight's fixes are API calls (the Anthropic use-case form,
`PutUseCaseForModelAccess`; the model agreement, `CreateFoundationModelAgreement`; quota increases,
`RequestServiceQuotaIncrease`; a failed first deploy, `DeleteStack`; a stuck rollback, `ContinueUpdateRollback`; a
removed installation's sign-in domain, `DeleteUserPoolDomain`; its kept repositories and secret), the build runners
use the token unless a connection is authorized already, and publishing images is set up by API too. What a person
still decides, and why:

| What | Why it can't be automated | When it comes up |
| --- | --- | --- |
| Authorizing a new AWS CodeConnections connection | AWS requires the GitHub app's installation to be approved in the console (the OAuth handshake with GitHub) | Only with Advanced → Build runners → "An AWS CodeConnections connection" and none authorized yet |
| Waiting for AWS: a pending Anthropic agreement, a quota increase | AWS decides (it emails; usually minutes for the agreement, within a day for a quota) | Only when the preflight found them missing; installing never waits |
| A payment method on the account | The model agreement is an AWS Marketplace subscription, which needs one (Billing) | Only on an account that has none |
| A custom ECR Public alias | Requested in the console only | Never: trace uses the registry's default alias |
| Sharing a private trace source repository's actions | GitHub requires that repository's admin | Only when you are not its admin |

### Optional integrations

Keys for external services some tools use. None is needed to install or deploy; without one, the tools that use it
carry on with what they have and say which key would add more ("no Nexar (Octopart) credentials …: add them with
`tracectl integrations set nexar`").

| Integration | Keys | Enables | Get one |
| --- | --- | --- | --- |
| `nexar` | `NEXAR_CLIENT_ID`, `NEXAR_CLIENT_SECRET` | Stock, prices and lifecycle from every distributor Octopart lists (parts lookup, search, alternatives, BOM checks) | [portal.nexar.com](https://portal.nexar.com/) |
| `mouser` | `MOUSER_API_KEY` | Mouser stock, prices, lifecycle, datasheet links | [mouser.com/api-hub](https://www.mouser.com/api-hub/) |
| `digikey` | `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` | Digi-Key stock, prices, lifecycle, datasheet links | [developer.digikey.com](https://developer.digikey.com/) |
| `dhl` | `DHL_API_KEY` | Following a shipped order's DHL parcel ([Cost and orders](#cost-and-orders)); read by the order watch only, kept as `<prefix>/order-watch/dhl`, never by a worker | [developer.dhl.com](https://developer.dhl.com/api-reference/shipment-tracking) |

LCSC needs no key, and the datasheet tools fetch public URLs; those are every credential the tools read
(`src/core/integrations-catalog.ts`, checked by `test/core/integrations.test.ts`).

```sh
tracectl integrations list                      # which are set, what each enables
tracectl integrations set nexar                 # asks for the keys (or NEXAR_CLIENT_ID=… NEXAR_CLIENT_SECRET=…)
tracectl integrations check nexar               # the stored keys, checked with Nexar
tracectl integrations remove nexar
tracectl integrations set mouser --remote       # through the API, as a signed-in admin
```

Each is one Secrets Manager secret, `<prefix>/integrations/<name>`, written by the installer, the CLI (your AWS
credentials) or an admin through the API (`integrations.set`, `.list`, `.remove`; the API may write them and never
reads them back). A key is checked with its service when given; a failed check is reported and the key stored anyway.
With the library gateway off, each worker role may read `<prefix>/integrations/*`, and the worker loads them into its
environment when it starts (so an agent, which has Bash and its role's credentials, can read them too). With the
[library gateway](#library-gateway) on, only the gateway's Lambda may read them and no worker role can. A changed key
reaches workers at their next session and the Lambda at its next cold start; nothing is redeployed.

### Images: copied or built

The three images (the agent's, arm64, at most 2 GB for AgentCore; the tools functions', arm64, with the programs too
large for it; the GPU and CPU jobs', amd64) are made by CodeBuild in your account (`src/infra/images.ts`):

- **Prebuilt** (the default): CodeBuild copies trace's published image for exactly this source from Amazon ECR Public,
  `<registry>/trace-agent:<content tag>`, `/trace-tools:` and `/trace-gpu:`, into the installation's own private
  repository. The
  content tag is a hash of what goes into the image, computed the same way by the stack and by trace's release
  workflow (`scripts/image-tag.mjs`), so a modified trace never takes an image that is not its own. The copy is pinned:
  `scripts/resolve-image.mjs` reads the tag's digest from the registry and checks it against the manifest's own
  bytes, the image is pulled by that digest, its digest is checked again after the pull, and only then is it re-tagged
  and pushed. When the tag is not published (an unreleased commit, a fork), or no registry is set, it builds instead.
  `<registry>` is found at install time: the source repository's `trace-images` release, which publishing writes
  (below), names it. Nothing published yet, so always built until then. Advanced → "Published images registry"
  overrides it, and `PUBLISHED_REGISTRY` in `src/infra/props.ts` can pin one for a fork; neither is needed.

  AgentCore would also run an image straight from `public.ecr.aws` (its `containerUri` accepts it), and Batch could
  pull one; trace copies it anyway, so the runtimes and jobs pull from the account's own registry in their region (no
  public pull rate limits, no dependence on ECR Public at each cold start, the image stays if a release is withdrawn),
  and the private repository keeps its lifecycle rule (the last 10 images).
- **Build:** `docker build` with BuildKit's inline cache: the previous image (`:cache`) is the cache, so a rebuild
  after an upgrade redoes only the layers whose inputs changed, and CodeBuild's local Docker layer cache helps a build
  soon after another.

An installed trace has no `package-lock.json` or `.npmrc` (npm never packs them), and both the images and the CDK's
Lambda bundling need the lock file: `npm run build` copies both into `agent/`, which npm packs
(`scripts/stage-image.mjs`, `src/infra/lockfile.ts`).

### Publishing images

trace's own images are published to Amazon ECR Public from one AWS account, the project owner's, so every
installation can copy them. Publishing is a step of the install itself, with no prework: when the GitHub token you
install with administers trace's source repository, the installer sets publishing up from that account and starts
the first release (the preflight says so, and Advanced → "Publish trace's images" turns it on or off). Nothing is
done in the console, and nothing is edited or committed. `tracectl release setup --publish` does the same on its own.

It (`src/installer/release.ts`):

1. bootstraps CDK in us-east-1 (ECR Public's only region) when it isn't, and deploys **TraceRelease**
   (`src/infra/release.ts`; `npm run deploy:release` deploys it alone): the public repositories `trace-agent`
   and `trace-tools` (linux/arm64) and `trace-gpu` (linux/amd64) with their gallery catalog data, and the release role `trace-release`,
   which GitHub OIDC lets only the source repository's `main` and `v*` tags assume, and which may only log in and push
   to those three repositories (the account's GitHub OIDC provider is used when it has one);
2. reads the registry's address, `public.ecr.aws/<alias>`, with `DescribeRegistries`. The alias is the registry's
   default one, which ECR Public assigns by itself once the account's first public repository exists, so a new
   registry gets it right after the deploy (setup waits a minute for it). A custom alias is the only kind that needs
   the console, and trace does not use one. The gallery display name is set with `PutRegistryCatalogData`;
3. sets the source repository's variables `TRACE_RELEASE_ROLE` and `TRACE_IMAGE_REGISTRY` with the GitHub token you
   gave (REST);
4. records the registry in the source repository's `trace-images` release (a pre-release, never "latest"), where every
   installer finds it;
5. starts the first release (`workflow_dispatch`; the CLI with `--publish`) and prints where the images appear
   (`public.ecr.aws/<alias>/trace-agent`, `https://gallery.ecr.aws/<alias>/trace-agent`, and the same for `trace-tools` and `trace-gpu`).

From then on every merge to `main` and every `v*` tag publishes (`.github/workflows/release-images.yml`, which does
nothing until both variables are set). It runs on the source repository's own AWS build runner, which the
installation makes (with Docker, when it publishes; see [Where builds run](#where-builds-run)), and on GitHub's
`ubuntu-24.04` runner until that exists. It builds both images with BuildKit, caches in the registry
itself (`:cache`, mode=max), attaches an OCI provenance attestation, tags the content tag plus `latest` on main and
`vX.Y.Z` on a tag, and records each pushed digest in the job summary. Installations look there from then on by
themselves: each install reads the `trace-images` release, and copies its version's images when they are published.

### Upgrading and uninstalling

```sh
tracectl upgrade              # pull the newer trace (npm install -g github:mteichtahl/trace#main), then redeploy with the
                           # saved answers and refresh each repository's variables and workflows
tracectl upgrade --check      # what it would change, without changing anything
tracectl upgrade --runner-auth token|connection|auto   # switch how the build runners reach GitHub (Where builds run)
tracectl upgrade --connection ARN|auto   # choose the GitHub connection the build runners use (auto: the installer's pick)
tracectl uninstall            # remove it (asks you to type the stack's name; --yes to skip)
```

Running trace from a clone (`npm link`)? `tracectl upgrade` doesn't pull it from GitHub: update the clone (`git pull && npm ci && npm run build`), then run `tracectl upgrade --no-pull`.

Both use the answers saved on this machine and your AWS credentials; the GitHub token is read back from the
installation's own secret, so neither asks for it. `tracectl uninstall` removes the integrations' secrets, each
repository's trace variables (`TRACE_CODEBUILD_PROJECT` among them) and `TRACE_TOKEN`, trace's own repository's
`TRACE_UPDATE_ROLE`, `TRACE_STACK` and `TRACE_AWS_REGION` (see [Staying up to date](#staying-up-to-date)), the stack (and with it the
build runners and their webhooks), then CodeBuild's GitHub credential when trace imported it, and lists what stays (a
GitHub connection the stack created among it): with keep data (`retainData`, the default) the central
bucket, the image repositories, each project's memory, log groups and knowledge-base vectors; always the Cognito user
pool, the API's token secret, the CDK bootstrap, Transaction Search and the files onboarding added to each repository.
`--delete-data` also deletes what would block installing again with the same prefix (the image repositories, the token
secret, the user pool) and prints the commands for the bucket and the memories.

## Project isolation

Each project's agent runs Claude with Bash, so it can use its runtime's AWS credentials directly. The line between
projects is therefore drawn in IAM, not only in code (`src/infra/project.ts`):

| Isolated per project | How |
| --- | --- |
| **Worker runtime** | One AgentCore runtime per repository (`<prefix>_w_<hash>`, tagged `trace:project`), with its own execution role and `TRACE_PROJECT=owner/repo`. It refuses, with a 403 that is logged, any invocation or job for another repository. |
| **Memory** | One AgentCore Memory per repository (`<prefix>_m_<hash>`, tagged `trace:project`), its own event expiry, and its own log group and log delivery. The worker is told only its own (`TRACE_MEMORY_ID`) and its role may use only that memory's ARN. On it, the role may still create and list events only for actors `<owner>/<repo>/*`, and recall and list records only under `/trace/<owner>/<repo>/*` (the condition keys `bedrock-agentcore:actorId` and `bedrock-agentcore:namespace`), as defence in depth. The actor comes from `TRACE_PROJECT`, never from the request. The GitHub OIDC role has the same grants on the same memory, for the `worker.runner = actions` fallback (the repository variable `TRACE_MEMORY_ID`). |
| **S3** | Read and write `projects/<owner>/<repo>/*` and `jobs/<owner>/<repo>/*`, and list only those prefixes and `central/*`. Read, never write, `prompts/*` (the installation's prompt overrides, see [Managing prompts](#managing-prompts)). Nothing under `access/*`, and nothing of another project. |
| **GPU and CPU jobs** | Two AWS Batch job definitions per project (`<prefix>-gpu-<hash>`, and `<prefix>-cpu-<hash>` with the CPU queue), with one job role that reads and writes only that project's `jobs/<owner>/<repo>/*`. A project's role may submit only with its own definitions, only jobs tagged `trace:project=<owner>/<repo>`, and may stop only jobs carrying that tag. SubmitJob cannot override a definition's job role. |
| **Tools and cad functions** | Nested layout: two AWS Lambda functions per project from the tools image. The tools function (`<prefix>-tools-<hash>`) runs trace's own programs (KiCad, Blender, the FPGA tools, CalculiX, ffmpeg, the enclosure engine's checks) on a role that reads and writes only `jobs/<owner>/<repo>/*` and its own log group. The cad function (`<prefix>-cad-<hash>`) runs the project's case script (`mechanical/case.py`, code a person or a pull request wrote) on a role that may write its own log group and nothing else: no S3, no X-Ray. The worker signs 20-minute URLs for that one job's files and sends only those (`src/gpu/urls.ts`), so a script that reads the runner's credentials or `/proc` finds nothing that reaches another object, and whatever it writes back is a claim the tools function measures. Only the project's worker may invoke either. The flat layout has its tools functions in one nested stack and no cad functions: a custom case script builds there on a laptop or in CI. |
| **Events** | Nested layout only. One SNS topic per project, `<prefix>-<hash>-batch-events`, and up to two EventBridge rules sending it events: its own Batch jobs' state changes (with GPU jobs), and `<prefix>-<hash>-journey-events`, the central bucket's "Object Created" event for its journey record (`projects/<owner>/<repo>/journey/journey.db`, which only the API writes), its job index (`journey-agent/jobs.db`) and its agents' facts (`journey-agent/facts.db`, where a hand-off's answer is written). Only those rules may publish to it. A worker waiting on a job, on a person's answer in `journey.ask`, or on a hand-off's answer in `journey.handoff`, subscribes a short-lived queue of its own (`<prefix>-<hash>-wait-*`) and is told at once. It still checks on a slow timer (30 seconds and 90 seconds after subscribing, then every 5 minutes) in case a message is lost. Without the topic (flat layout, or an older stack) it checks on a timer and says when it will look next. |
| **Knowledge base** | One Amazon Bedrock knowledge base per repository (`<prefix>-kb-<hash>`, nested layout only), with its own service role (`<prefix>-kb-<hash>-<region>`) that reads only `projects/<owner>/<repo>/kb/*` and its own S3 Vectors index, and invokes only the embedding model. The worker role and the OIDC role may `bedrock:Retrieve` and start, get and list ingestion jobs on that knowledge base's ARN only. See [Knowledge base](#knowledge-base). |
| **Library gateway** | Off by default (`gateway.enabled`). When on, each worker role may `bedrock-agentcore:InvokeGateway` on the installation's one library gateway and nothing else of it; the gateway serves only the shared datasheets and parts tools. See [Library gateway](#library-gateway). |
| **GitHub OIDC role** | One per repository, trusted only for `repo:OWNER/REPO:ref:refs/heads/BRANCH`, and for the same branch under GitHub's immutable subject `repo:OWNER@OWNER_ID/REPO@REPO_ID:…` (what GitHub sends for repositories created, renamed or transferred after 15 July 2026, or opted in; the installer reads the ids from GitHub). It may invoke only that project's runtime, read and write only that project's prefix (and the central database), and use only that project's memory and knowledge base, as its worker does. |
| **GitHub token** | Each project has its own secret, `<prefix>/github-token/<owner>/<repo>`, and its worker reads only that one. This isolates GitHub access only when you give the project its own fine-grained token limited to that repository. By default the shared token is copied into every project's secret, and the installer's summary says so. A project token is checked: it must see its repository, and the installer warns if it can also see another project's. |

Shared on purpose:

- **The central database** (`central/`: datasheets and the parts database). Every project reads it. Every project
  may also write it, because adding a datasheet is a shared write, but only with a conditional put (`If-Match` or
  `If-None-Match`, which is how the central store always writes) and never a delete. The bucket is versioned.
- **The library gateway** (when `gateway.enabled`): one AgentCore Gateway and its Lambda, which reach the central
  store and the distributor keys only. See [Library gateway](#library-gateway).
- **The GPU and CPU queues and compute environments**, and the GPU image (which both run).
- **The S3 vector bucket** that holds every project's knowledge base index (one index per project; each service role
  reaches only its own index's ARN).
- **The agent image**: every runtime runs the same one. **The tools image**: every project's tools function runs it.
- **The API runtime.** It is the one component that spans projects. It holds the shared GitHub token, which admins
  need for `settings.get` and `settings.set` on any project. It reads (never writes) the records of every project's
  memory for `memory.list` and `memory.recall`, choosing the memory of the project asked for after the access check,
  it may `bedrock:Retrieve` on every project's knowledge base for `kb.search`, again after the access check,
  and it may invoke every project's worker: each by its exact runtime ARN, and the runtime only when it carries this
  installation's tag `trace:installation=<prefix>` (`aws:ResourceTag`, which the Service Authorization Reference
  lists for both of InvokeAgentRuntime's resource types, runtime and runtime-endpoint; the endpoint statement names
  the exact ARNs only, because the `DEFAULT` endpoint AgentCore makes is not tagged by the stack). No name pattern, so
  another installation in the account is out of reach. It does all of this only after its
  Cognito access check. It runs no model and no agent, and nothing reaches a shell through it: a `task` is handed to
  the project's own worker runtime.

`DescribeJobs` in AWS Batch has no resource-level permissions, so any project's role can describe (not change) any
job on the queue, which includes its command and environment. Job ids, not data, are what that reveals.

### Stack layout and limits

An installation holds up to 60 projects. Each project's resources (its worker runtime and execution role, GitHub
OIDC role, token secret, memory with its log group and log delivery, GPU and CPU job definitions and job role, and its
knowledge base with its index, service role and data source: 23 CloudFormation resources with everything on) are a CloudFormation nested stack of their own, `Project<hash>Stack`
(`src/infra/project.ts` `ProjectNestedStack`). The parent stack holds the shared parts and one
`AWS::CloudFormation::Stack` per project. What a project uses of the parent (the bucket, the agent image and its
repository, the OIDC provider, the GPU and CPU queues, image repository, execution role and log group) reaches its
nested stack as parameters (the S3 vector bucket too), and the parent waits for Transaction Search before it creates or updates a project (not
for the GPU image: see [GPU jobs](#gpu-jobs-rendering-and-autorouting)).
Inside, the resources are the ones the single stack had, with the same names, IAM and removal policies (with
`retainData`, a removed project's memory, log group and log delivery stay in the account, as before).

| Projects | Parent stack: resources / outputs | Each project's nested stack: resources / outputs / parameters |
| --- | --- | --- |
| 1 | 89 / 20 | 23 / 15 / 12 |
| 24 | 115 / 20 | 23 / 15 / 12 |
| 60 | 152 / 20 | 23 / 15 / 12 |

(Everything on, including the legacy memory's one-deploy output and the CI runners' role. The knowledge bases add the vector bucket to the
parent, and to each nested stack five resources, its two outputs `Project<hash>KnowledgeBaseId` and
`Project<hash>KnowledgeBaseDataSourceId`, the knowledge base id the parent reads for the API, and the vector bucket's
parameter. From 24 projects, CDK moves part of the API role's policy, which names every project's memory, worker
runtime and knowledge base, into managed policies of that role: three at 24 and four at 60, of the ten a role may have
by default. The tools functions add five resources and the `ToolsImageUri` output to the parent, for the tools image
(its repository, its CodeBuild project with its role and policy, and its build), and to each nested stack four
resources (the function, its role, policy and log group: `src/infra/tools.ts`) and three parameters (the tools
image's repository and tag); the cad function (`CadFunction`, the case script's) adds the same four to each nested
stack, 39 with everything on. The flat layout has no room for those per project, so its tools functions are all
in one nested stack, one resource of the parent's, left out when the parent has no room even for that, and it has no
cad functions: see `agent/README.md`.)

CloudFormation allows 500 resources, 200 outputs and 200 parameters per template, and the stack checks all three
when it is built. The parent carries none of a project's outputs, so its output count does not grow with the
projects. Each project's are its nested stack's, under the names they always had (`Project<hash>RuntimeArn`,
`Project<hash>ActionsRoleArn`, `Project<hash>MemoryId`, `Project<hash>GithubSecretArn`,
`Project<hash>GpuJobDefinition`, `Project<hash>LogGroup`, `Project<hash>MemoryLogGroup`), with `Repository`
(`owner/repo`). The installer lists the parent's resources (`ListStackResources`: `DescribeStackResources` returns
only the first 100), takes each `AWS::CloudFormation::Stack` whose logical id is `Project<hash>Stack…`, reads its
outputs with `DescribeStacks` on its physical id, checks its `Repository` output against the hash, and takes only the
outputs named for that hash (`src/installer/aws.ts` `stackOutputs`). The flat layout keeps its outputs in the one
stack, as before. The other limit at 60 is the API's three `owner/repo=<id>` lists (see
[Agent memory](#agent-memory)): very long repository names can reach their 5000 characters first, and the stack says
so when it is built. The output `Layout` says which layout an installation has.

`cdk deploy` uploads each nested template to the CDK bootstrap bucket as a file asset, the same way it already
uploads the agent source and the Lambda code, so the bootstrap the installer runs (version 6 or later) covers it.

**Installations from before nested stacks keep `layout: 'flat'`.** There every project's resources are in the one
stack, and it holds about 20 projects (`cdk synth` refuses more). A flat installation has no knowledge bases and no CPU
queue: at about 480 of its 500 resources with 20 projects, it has no room for them. The installer picks the layout from the deployed
stack: a stack with a `Layout` output keeps that layout, a stack without one is flat, and a new installation is
nested. Deploying by hand, set `layout: 'flat'` in `TRACE_INFRA` for an older stack.

Moving a flat installation to nested stacks is a choice in the installer ("Move to one nested stack per project"),
because it deletes every project's memory records. CloudFormation cannot move these resources in place:

| Resource | What a plain switch to nested would do |
| --- | --- |
| AgentCore runtime (`<prefix>_w_<hash>`), memory (`<prefix>_m_<hash>`), IAM roles (`<prefix>-w-`, `-gh-`, `-gpu-<hash>-<region>`), secret (`<prefix>/github-token/<owner>/<repo>`), delivery sources and destinations (`<prefix>-m-<hash>-…`) | CloudFormation creates a moved resource before it deletes the old one, and these names are fixed, so the nested stack's create fails on the first name already in use and the update rolls back. Nothing is lost, and nothing moves. A memory with `retainData` is also Retain, so even after its old copy is removed its name stays taken. A deleted secret can keep its name through its recovery window. |
| Batch job definition (`<prefix>-gpu-<hash>`) | Would work: registering an existing name adds a revision, and deleting the old resource deregisters only its own revision. |
| A memory's log group (`/aws/vendedlogs/…/<memory id>`) | Named after the memory's id, so a new memory gets a new log group. The old one stays with `retainData`. |

CloudFormation stack refactoring (2025, and `cdk refactor`) moves resources between stacks, nested ones included,
but only as an operation that creates, deletes and modifies nothing. This move has to create the nested stack
resources and their parameters, and to change the API runtime's environment, the API role's policy and the outputs
to read from the nested stacks. That would take a separate deploy for each of those changes around a refactor, and
refactoring also requires every moved resource type to be fully mutable, which has not been confirmed for the AgentCore
resource types. It was not chosen. Renaming everything once (a version suffix) would keep the records but change every
name for good, and the names are how projects are told apart in IAM.

The move is therefore three deploys in a row, run by the installer:

1. **release** (only with `retainData`; `layoutMigration: 'release'`): the same stack, with each project's memory and
   its log delivery marked Delete. Nothing else changes.
2. **drain** (`layoutMigration: 'drain'`): every project out of the stack. CloudFormation deletes each project's
   runtime, roles, secret, job definition, memory with every record in it, and log delivery. With `retainData`, each
   memory's log group stays in the account. The API is told no workers, so the projects are offline from here.
3. **nested** (`layout: 'nested'`): every project again, each in its own nested stack, with an empty memory. Just
   before it the installer force-deletes any project secret still in its recovery window (they are copies of tokens,
   and it writes them again straight after). Then it rewrites every repository's variables as usual.

Workflows that run between the second deploy and the variable update fail; re-run them. If a deploy fails, run the
installer again: it carries on from the layout the stack is then in.

**What a flat installation gets, and why the move is the way on.** Projects created in the web app are added to a flat
installation by the self-update too, while it holds fewer than 15 projects (`FLAT_UPDATE_MAX`, src/installer/pending.ts;
each project is about 21 of the stack's 500 resources, and an unattended deploy keeps room for trace's own changes);
past that, by the next installer run. They get their agent, memory and build runner, but no knowledge base, CPU queue or
per-project events topic, so an agent waiting in `journey.ask` checks the record on its timer. Giving the flat layout
those was rejected: the knowledge base (5 resources), the CPU job definition (1) and the events topic with its policy
and rule (3) would take 20 projects past 500 resources, so the flat cap would drop to about 15 for every existing
installation. The self-update never moves the layout, because the move deletes every project's memory records, which
is a person's call; the installer offers it ("Move to one nested stack per project"), and the app says all of this on
New project and Admin › Installation (`installation.layout`), with the move's steps and what it costs.

**Upgrading an installation from before per-project roles.** The next installer run replaces the single worker
runtime (`<prefix>_agent`), its role, the one GitHub OIDC role (`<prefix>-github-actions-<region>`) and the one GPU
job definition with one of each per project, and rewrites every repository's `TRACE_AWS_ROLE` and
`TRACE_AGENT_RUNTIME_ARN`. Workflows that run between the deploy and the variable update fail to assume the old
role; re-run them. The shared `<prefix>/github-token` secret stays, as the API's. GPU job files written under the
old `jobs/<id>/` layout expire with the bucket's one-week rule.

**Upgrading an installation from before per-project memory.** The installation-wide memory (`<prefix>_memory`) is
removed and every project starts with its own, empty memory. See [Agent memory](#agent-memory) for what happens to
the old one's records.

## People and permissions

Everyone signs in with Amazon Cognito (`tracectl login`). Each person is in one of three classes:

| Class | What they can do |
| --- | --- |
| **admin** | Everything, on every project. This includes inviting people, setting classes and assigning projects. |
| **user** | Read and write, only on the projects they are assigned to. |
| **guest** | Read only, only on the projects they are assigned to. |

- **Read** means seeing a project's status, settings, runs and artifacts, and using the read-only tools.
- **Write** also allows changing settings, giving the agents work (`tracectl remote task`), and using the tools that
  record runs.

A person's class is their Cognito group (`trace-admins`, `trace-users`, `trace-guests`), so it travels inside their
signed token. Someone in none of these groups can do nothing. Project assignments live in the central database.
Someone not assigned to a project cannot tell that it exists.

The API runtime checks every request against these rules. Each repository's own workflows reach only that project's
worker runtime, through IAM, so a person's sign-in never acts as the loop, and the loop never acts as a person. Admins manage
people with:

```sh
tracectl users invite EMAIL --class user|guest|admin
tracectl users class EMAIL guest
tracectl users assign EMAIL OWNER/REPO
tracectl users unassign EMAIL OWNER/REPO
tracectl users list
tracectl users assignments
```

The installer sets up the first admin and anyone else you list, with their classes and projects.

Changing a project's prompts takes write access on it, and the installation's prompts only an admin can change;
guests can list, read and preview them (see [Managing prompts](#managing-prompts)).

Marking an agent memory inactive (`tracectl remote memory deactivate`) takes write access. A person's own preferences
are the exception: they may mark those with read access alone (see [Inactive memories](#inactive-memories)).

## Connecting other systems

A **connected system** is another system or AI agent that calls trace with its own keys: a build dashboard, a release
pipeline, a script, an MCP client. Each one has a name, what it may do (read, or read and change) and the projects it
is on, as a reviewer or a contributor, exactly like a person. A project it is not on does not exist for it. The design
is in [docs/external-access.md](docs/external-access.md).

**Turning it on.** External access is off until an admin turns it on: run `tracectl install`, open **External
access**, switch it on and deploy. That adds a sign-in for systems and two addresses, one for scripts (the external
API) and one for AI agents (the MCP endpoint). Both cost nothing while nobody calls them. With it off, the admin screen
and `tracectl services` say so, and nothing outside can get in.

**Connecting one.** In the web app, **Admin → Connected systems → Connect a system**: a name, what it is for, what it
may do (Read only is recommended: it can look but not change anything) and its projects. A read-only system is always
a reviewer. Or from the command line:

```sh
tracectl services create build-dashboard --scope read --project acme/soil-sensor --description "The lab's wall screen"
tracectl services create release-bot --scope write --project acme/soil-sensor:contributor
tracectl services list
tracectl services show build-dashboard
```

Both show the client id and the **secret once**, with the sign-in (token) address, the API address and the MCP
address. trace does not keep the secret: store it at once, in a password manager or the other system's secret store.

**Getting a token.** The system swaps its client id and secret for a sign-in token that lasts an hour:

```sh
curl -s -u "$CLIENT_ID:$TRACE_CLIENT_SECRET" -d grant_type=client_credentials \
  --data-urlencode "scope=trace-external/read" "$TOKEN_URL"          # trace-external/read trace-external/write to change things
```

**Calling the API.** The same `{ action, ...args }` JSON as the app, with the token:

```sh
curl -s -X POST "$API_URL" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"action":"projects"}'
```

**Connecting an AI agent.** Point an MCP client (Claude Code, for example) at the MCP address. It gets one tool per
action the system may use:

```json
{ "type": "http", "url": "<MCP address>", "headers": { "Authorization": "Bearer <token>" } }
```

**What a system can and can't do.** With read it can see the projects it is on: their status, settings, runs and
artifacts, jobs, requirements, design, build and cost records, files, the knowledge base, and the read-only tools.
With read and change it can also, where it is a contributor, give the agents work, pause or cancel its own jobs,
propose a settings change (as a pull request a person merges), sync the knowledge base and run tools that record
runs. Never, whatever it may do: anything that needs an admin, signing gates, answering questions, waivers, design
decisions, orders, chats, preferences, memory, prompts, people and assignments, or the tools of the shared datasheet
library and the parts search (shared by every project, and the parts search spends the installation's paid quota).
Those stay with a person. Anything else answers "no access", the same words as a project that isn't yours.

**Limits.** Each system may make 10 requests a second and 300 a minute, counted across the whole installation; over
that it is answered 429 with `Retry-After`, the number of seconds to wait. It may have at most three tasks queued or
running on one project; a fourth is refused until one finishes. An unexpected failure is answered
`internal error (ref …)`: the reference finds the details in the external runtime's log (`ExternalLogGroup`).

**Stopping and rotating.** Disabling a system stops it within 30 seconds; deleting it disables it first, then removes
its keys and takes it off every project. A new secret works beside the old one, so the system can switch without
stopping; retire the old one once it has:

```sh
tracectl services disable release-bot          # enable to let it in again
tracectl services rotate build-dashboard       # prints the new secret, once
tracectl services retire-secret build-dashboard OLD_SECRET_ID
tracectl services delete release-bot           # asks you to type the name; --yes skips that
tracectl services history build-dashboard
```

Every command takes `--json`. The web app has the same on each system's page.

**A leaked secret.** Disable the system first, then rotate, retire the old secret, give the new one to the system, and
enable it again. Rotating alone is not enough: the old secret keeps working until it is retired, and a token already
issued lasts up to an hour, which disabling stops at once.

```sh
tracectl services disable build-dashboard
tracectl services rotate build-dashboard
tracectl services retire-secret build-dashboard OLD_SECRET_ID
tracectl services enable build-dashboard
```

**Cost.** Each system's keys are checked with Amazon Cognito, which charges a small amount per system and per sign-in.
A system that reuses its token for the hour makes about 720 sign-ins a month. The shared request limit is a small
DynamoDB table, billed per request (two small writes per call).

**What it runs as.** The external API has an AWS role of its own, with only what systems' actions need: it cannot
manage people or keys in Cognito at all. The details are in [docs/external-access.md](docs/external-access.md).

## Web app

The installer sets up a web app beside `tracectl login`: one address where people sign in and work with their projects.
It is on by default and needs nothing more at install time. It is built from `web/` (the app) and `src/web/` (its
backend) when the stack is deployed, and lives in its own nested stack (`src/infra/web.ts`).

| Part | What it is |
| --- | --- |
| Address | A CloudFront distribution: CloudFront's own address (`https://<id>.cloudfront.net`, the `WebUrl` output) unless a custom domain is set. HTTP/2 and HTTP/3, price class 100 |
| The app | A private S3 bucket that only this distribution can read (origin access control). `index.html` is never cached; Vite's hashed files under `assets/` are cached for a year. Any path without a dot loads the app |
| Backend | A Lambda function (Node.js 22, arm64, response streaming) behind `/api/*` on the same address. Only CloudFront can call its function URL (IAM auth, origin access control). It reads its settings from one SSM parameter, `/<prefix>/web/config` |
| Live updates | AppSync Events, `<prefix>-events`. People subscribe with their sign-in, each to `/trace/users/<their id>` only. Only the backend, and the agents' facts function below, can publish |
| GitHub's webhook | (`web.hooks`, on by default) Each project repository's webhook (pull requests, checks, statuses) posts to `/api/hooks/github`, which goes to a small function of its own, `<prefix>-web-hooks`. CloudFront adds a random header only it knows, and the function drops anything without it before reading the rest; it checks each delivery's signature against the secret `<prefix>/web/github-hooks` (the installer makes it and registers the hooks), drops a delivery id it has seen, asks the API runtime who is on the project, and tells their screens to look again, once or twice per push. A repository the token may not add a webhook to is a warning; its screens look again every 60 s. docs/guided-flow.md "Live updates" |
| Agents' facts | When an agent records a journey fact (a question, a check, a stuck report), the central bucket's event reaches a small function, `<prefix>-journey-events`, through an EventBridge rule. It tells everyone on that project to refresh, and notifies the people a new question or stuck report is for. Its role may read the access store and the agents' facts files, and publish live events. Nothing else |
| Sign-in | A Cognito app client of its own, `<prefix>-web`, using choice-based sign-in. People sign in with a passkey or a password, plus an email code when SES is set (see below). The CLI keeps its own client |
| Voice | Polly speech kept 30 days in a small bucket of its own. The browser gets signed URLs for it and for Transcribe streaming. Dictation in a project uses that project's own words (below) |

The backend's role can read its settings and use Polly, Transcribe streaming, its voice cache, CloudWatch (read
only), the chat model, and publishing live events. It cannot reach the access store, any project's data or Cognito's
admin API. Anything about a project goes through the API runtime, with the person's own token, so the access checks
stay in one place.

**Dictation with the project's words.** Each project gets an Amazon Transcribe custom vocabulary made from its design,
so dictation writes `U4`, `R14`, `STM32F405RGT6`, `VCC_3V3` or `REQ-LAY-001` as the design spells them. Every push to
the default branch remakes it (the `voice-vocabulary` job of `trace-worker.yml`, `tracectl tool voice.vocabulary`, with
the project's own role); `voice.vocabulary.sync` does it on demand through the API. The table
(`projects/<owner>/<repo>/voice/<language>.txt`) has one row per way of saying a name: a reference designator's
letters spelled and its number said digit by digit or as a number ("R one four", "R fourteen" → R14), a part number or
net spelled with its words kept ("Buck E N" → Buck_EN), with Transcribe's rules for a phrase (letters and hyphens, single
letters with periods, no digits, at most 256 characters, at most 50 KB in all; `SoundsLike` and `IPA` are left empty,
since Transcribe no longer uses them). It is named `<prefix>-<project hash>-<language>`, for the languages in the
project setting `voice.languages` (default `en-AU`; English only, as the spoken numbers are English; Transcribe allows
100 vocabularies per account by default). When the microphone opens, the backend asks the API (`voice.vocabulary`, as
the person) and names the vocabulary in the signed streaming URL only when it is ready; the app says whether the
project's words are in use. Waiting for a vocabulary to be ready is a timer (every 10 seconds, growing to a minute),
declared: Transcribe's "Vocabulary State Change" event is sent only when a vocabulary is first made, not when it is
updated. IAM: each project's worker and OIDC roles may create vocabularies only tagged with their own project and
update and read only their own names; the API role may only read their state; the backend role gets nothing new. Turn
it off per project with `voice.vocabulary = false`.

**Ask trace's instructions.** An admin's change to `chat.role` at installation scope (Admin › Prompts, or
`prompts.set`) reaches the chat agent within a minute. The backend cannot read the prompts store, and is not given
read access to it: the store is one database holding every prompt's override and its history, and S3 cannot grant
part of one object. Instead it asks the API for `prompts.chat`, which answers only the editable chat entries, and
keeps the answer for 60 seconds per Lambda container. A change made through the app clears that container's copy at
once; other containers pick it up within the 60 seconds (the live `record.changed` event reaches browsers, not the
Lambda). The locked chat entries (the data fences) always come from the code.

Every response carries strict security headers: HSTS, `nosniff`, `X-Frame-Options: DENY`, and
`strict-origin-when-cross-origin`. The content security policy allows only these:

- the app itself
- AppSync in the stack's region
- Transcribe streaming
- the voice bucket
- `data:` and `blob:` URLs
- WebAssembly (PDF.js and Shiki)
- inline styles

**AWS WAF.** On by default (Advanced → Web app, "Protect the app with AWS WAF"; `web.waf`). The app's address is public
and sign-in takes no token, so a web ACL sits in front of it (`src/infra/edge.ts`): AWS's managed rule groups (the core
rule set, known bad inputs and the IP reputation list), at most 1,000 requests to `/api/*` and 100 to `/api/auth/*` per
address in 5 minutes (`web.waf.apiRequestsPer5Minutes`, `authRequestsPer5Minutes`; over them a 429), and no request to
`/api/*` declaring a body of 5 MB or more (the chat's limit is 4 MB). The core rule set's 8 KB body limit and its body
cross-site-scripting rule only count, since a chat or a prompt is larger and people paste code; the app renders no HTML
from them. It costs about US$11 a month (US$5 for the web ACL and US$1 for each of its six rules) and US$0.60 per
million requests. That is the default because the alternative is sign-in with no limit per address; turn it off for a
private trial. CloudFront takes web ACLs from us-east-1 only: in us-east-1 the web ACL is in the web app's own stack;
elsewhere the installer deploys a small stack of its own, `<prefix>-edge`, in us-east-1 first (bootstrapping CDK there
if needed), and deploys the main stack with its `WebAclArn` output as `web.waf.aclArn`. Passing that one value between
two deploys was chosen over CDK's `crossRegionReferences`, which would add a custom resource (a Lambda and its role) and
an SSM parameter the two stacks would then hold each other to. The self-update deploys `<prefix>-edge` too, with the
CDK bootstrap roles of us-east-1 and the right to read that stack's outputs only; it never bootstraps us-east-1, so
when that is missing it keeps the web ACL the app had and says to run the installer. A failed edge deploy never stops
the main one. Turning the WAF off deletes `<prefix>-edge` after the main deploy, and `tracectl uninstall` deletes it
too. A web ACL of your own (`web.webAclArn`) is used instead when given. Admin → Installation says whether it is on.

**Custom domain.** Under Advanced → Web app, give a domain and its ACM certificate (it must be in us-east-1). After the
deploy, point the domain's DNS at the distribution with a CNAME or alias (`WebDistributionId`). The props for this are
`web.domainName` and `web.certificateArn`.

**Passkeys.** Each passkey belongs to the app's address, which is the user pool's relying party. If you move from
CloudFront's address to a custom domain later, people have to register their passkeys again. Their passwords still
work.

**Email codes.** Cognito sends sign-in codes by email only through Amazon SES. Without SES (the default), people sign
in with a passkey or a password, and Cognito's own sender still sends the invitations. To add codes by email, give a
verified SES sender under Advanced (`web.sesFrom`). The pool then sends all its email through SES.

The invitation email points at `https://<address>/invite` as well as `tracectl login`. The installer's last card has an
Open trace button. Turn the app off with Advanced → Web app (`web.enabled: false`). Other stack settings:
`web.model` (the chat model, which defaults to `model`) and `web.dashboards` (extra CloudWatch dashboards for the
Operations page, beside `<prefix>-agents`).

## Cost and orders

**Cloud cost per project.** Each project's spend is kept in a cost ledger in the central bucket, beside its agents'
facts (`projects/<slug>/journey-agent/cost.db`, `src/core/cost.ts`), not in the repository: money is for admins only.

- **Agents.** Every Claude run records each model's tokens (the Agent SDK's result) with its job and agent, priced from
  the price table.
- **Graphics card and CPU jobs.** Every finished AWS Batch job records its running time (Batch's start and stop
  times) times its pool's price: a graphics card job holds its instance, a CPU job pays for the vCPUs it asked for.
- **Tools function jobs.** Every call of a project's tools function (KiCad, Blender on the CPU, the FPGA and
  verification tools, CalculiX, ffmpeg: `agent/README.md`) records Lambda's billed duration (a cold start included)
  times its memory and its `/tmp` over 512 MB, plus the call, at Lambda's arm64 prices. The price list fetch does not
  ask for Lambda yet: the built-in price (us-east-1), or `cost.prices.tools`, prices them.
- **The price table** (`src/core/prices.ts`) is one dated table: Claude on Bedrock per million tokens per model
  (input, output, cache write, cache read; a global inference profile's price and the higher in-region one) and the
  two pools' prices per hour. Its prices come from three places, highest first:
  1. **An admin's prices**, the stack setting `cost.prices` (a model entry, a region-only entry, a pool, `tools`, and an
     `asOf`; run the installer to apply): the workers and the API get them as `TRACE_PRICES`.
  2. **The AWS price list.** Once a day, the same Lambda that reads Cost Explorer (below, at `cost.explorer.at`) asks
     the AWS Price List Query API (`pricing:GetProducts`, free) for Claude on Bedrock in the installation's region
     (service code `AmazonBedrockFoundationModels`, on-demand, Anthropic) and for the pools' instances on demand
     (`AmazonEC2`: the GPU pool's first instance type per hour, the CPU pool's first family's xlarge per vCPU), and
     writes the table to `installation/cost/prices.json`, dated the day it fetched (`src/core/price-list.ts`,
     `src/core/prices-store.ts`). Its endpoint is the nearest of the three the API has (us-east-1, eu-central-1,
     ap-south-1; `cost.priceList.endpoint` picks one). It takes the configured models (`model`, `web.model`) and the
     current Claude family (version 4 on). The price list names models by display name ("Claude Sonnet 4.6"), not by
     id, so each becomes a match key (`claude-sonnet-4-6`); it gives no Spot prices, and for some models no cache
     prices. A field it lacks is taken from the built-in entry of the same model, and a model it lacks (a newly
     released one) is priced by the built-in table; the notes on Cost and time say which. No price is made up. A
     failed fetch keeps the last table fetched and says why and when it tries next. `cost.priceList.enabled: false`
     turns it off.
  3. **The built-in table**, dated when it was taken from the public price pages: the last resort.

  Workers read `prices.json` at most once an hour (their role may read that one key of `installation/` and nothing
  else of it). Every row of the ledger records the date and the source (`override`, `fetched`, `built-in`) of the
  price that priced it. Cost and time and Admin › Usage and cost say where the prices come from ("prices from the AWS
  price list, fetched …"), warn when the fetch failed and the last or built-in prices are in use (with why and the next
  try), say when the built-in table is more than six months old, and how many rows each source priced. Every figure
  from the table is shown as an estimate.
- **What AWS billed.** Every project resource carries the `trace:project` and `trace:installation` tags. A Lambda,
  `<prefix>-cost-explorer`, reads Cost Explorer once a day (`cost.explorer.at`, default 06:17 UTC), grouped by
  `trace:project` and service, and writes per-project actuals into `installation/cost/actuals.db`. Cost Explorer can
  group by a tag only once it is **activated as a cost allocation tag**, a billing setting made once per account. With
  `cost.explorer.activateTags` (default on) the Lambda activates it (`UpdateCostAllocationTagsStatus`); in a member
  account of an AWS Organization only the management account may, so activate `trace:project` (and
  `trace:installation`) once in the Billing and Cost Management console, under Cost allocation tags. Billing lists a
  new tag up to a day after the first tagged resource exists, activation counts cost from then on only, and a day's
  figures settle about 24 hours later. The screens say all of this, and when the next read is. Model use and the
  shared job machines are not tagged per project, so for those the estimate is the per-project figure. Each run makes
  two to four Cost Explorer requests (US$0.01 each). The Lambda's role may call `ce:GetCostAndUsage`,
  `ce:ListCostAllocationTags`, `ce:UpdateCostAllocationTagsStatus` (with `activateTags`) and `pricing:GetProducts`
  (none of these take a resource, so `*`), and read and conditionally write `installation/cost/*` only. With
  `cost.explorer.enabled: false` and the price list on, it only fetches prices.

`cost.get` (Cost and time, and the gate's cost line) and `usage.month` (Admin › Usage and cost, and Operations' cost
tile) answer from the ledger, for admins only.

**Order status.** JLCPCB offers order status only through its Ordering API, for partner companies it approves on
their order history and volume, so trace does not read JLCPCB. The person records the order after paying, then the
carrier and tracking number from JLCPCB's shipping notice (Build tab, `order.update`), and marks it delivered. With
the `dhl` integration set, an hourly Lambda, `<prefix>-order-watch`, follows each DHL parcel: its first check an hour
after the number is recorded, then less often while nothing changes (up to every 12 hours), back to hourly when the
status moves; a person can check now. The Wait line says when the next check is. It never changes an order: when DHL
says delivered, the Build tab says so and the person records it. FedEx and UPS have tracking APIs that need an OAuth
app with a shipping account; they are not built, and their parcels are not checked. Reading JLCPCB's notification
emails would need inbound email (SES receiving and a domain's MX record), which an installation does not have, so it
is not built either.

**Boards and bring-up readings.** Boards are recorded by serial when they arrive (Incoming inspection: `board.record`,
`board.check`), each check against a board: counted, labelled, a fault at its reference, each hand-placed part fitted
or marked as left off. They are journey tables, people's entries. A hil tool given `bringup={board, step, min, max}`
stores its reading against that board and bring-up step, with pass or fail, in the run record (`bringup_readings`, a
measurement like any other), and copies it live beside the agents' facts so the Bring-up run screen shows it as it
is taken; `hil.idn` stores each instrument's identity the same way. The Incoming inspection, Bench setup and
Bring-up run checks are computed from these.

## Where builds run

Every build, test and automation job runs on AWS, in the installation's own account, once the installer has set it
up. Until then the same jobs run on GitHub's own runners (`ubuntu-24.04`), so nothing waits. The installer handles
all of it, including trace's own repository; there is nothing to deploy by hand.

The workflows stay in GitHub Actions, so pull requests show their checks as usual. On AWS, each job runs on an
[AWS CodeBuild-hosted runner](https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner.html): GitHub
queues the job, CodeBuild receives the queued event, starts a fresh build container in your account, and that
container runs the job and is discarded.

- **One runner per repository**, `<prefix>-ci-<hash>`, made by the stack: one for each project, and one for trace's
  own repository.
- **The switch is one repository variable.** Every job's `runs-on` reads `TRACE_CODEBUILD_PROJECT`: when it is set,
  the job runs on that CodeBuild runner; when it is not, on `ubuntu-24.04`. The installer sets it only once the
  repository's runner exists, and removes it where the runner does not exist, so a job never waits for a runner that
  isn't there. When the runner arrives, the jobs move to AWS by themselves; no workflow changes.
- **trace's own repository too.** The installer works out which GitHub repository your trace was installed from (the
  `repository` field of its `package.json`, `github:mteichtahl/trace`; a git checkout's own remote, or
  `TRACE_SOURCE`, comes first). If your token can manage that repository's variables, it gets a runner of its own
  (a runner only: no agents, roles or memory) and its `TRACE_CODEBUILD_PROJECT`. This is on by default; turn off
  "Build trace's own repository on AWS too" under Advanced → Build runners to leave it on GitHub's runners. When the
  installation publishes trace's images, that runner has Docker (`runners.ciPrivileged`) for the release workflow.
- **How CodeBuild reaches GitHub** (to make each runner project's webhook, register each job's just-in-time runner
  and fetch the source): one of two, chosen per installation (`runners.auth` in the answers; Advanced → Build
  runners in the installer):

  | | GitHub connection (CodeConnections) | The GitHub token (CodeBuild source credential) |
  | --- | --- | --- |
  | Stored with CodeBuild | No token: the AWS Connector for GitHub app's installation | The personal access token, imported with `ImportSourceCredentials` |
  | Console step | One authorization per AWS account and region, the first time | None |
  | First deploy | With the runners when a connection is authorized already; else without (GitHub's runners meanwhile), then a second deploy once it is | With the runners |
  | GitHub access | The app's: grant it every repository trace builds | The token's: Administration, Webhooks, Commit statuses (read and write) and Contents (read) on each repository |

  **Automatic** (the default) uses a connection when one is authorized in the account and region already (the one
  this installation used before, `<prefix>-github`, or another installation's), and the token otherwise, so a first
  install needs only the AWS credentials and the token. **The token** always uses the token. **A connection**
  (Advanced: "use an AWS CodeConnections connection instead of the token; needs one console authorization") always
  uses one, and creates `<prefix>-github` when there is none. Switch later with
  `tracectl upgrade --runner-auth auto|token|connection` (or by choosing again in `tracectl install`): the runner projects
  are updated in place.

  **Which connection**: Advanced → Build runners → GitHub connection lists every GitHub connection in the account and
  region with whether it is authorized. Leave it on Automatic, which says which one the installer would reuse, or pick
  one (or type another's ARN). An account can hold several, each the AWS Connector app of a different GitHub account
  or organization, and only one whose app can reach your repositories makes their runners. Change it later with
  `tracectl upgrade --connection ARN` (`--connection auto` goes back to the installer's pick).
- **When GitHub refuses a runner's webhook** (the AWS Connector app not allowed on the repository, a token without
  admin rights on it, an old CodeBuild webhook left on the repository, or GitHub's limit on a repository's hooks), the
  deploy still finishes. Each build-only repository's runner, and each project's runner in the nested layout, gets its
  webhook from a small custom resource (`src/infra/lambda/runner-webhook.ts`) rather than from CloudFormation, which
  would roll the whole stack back. The runner project is made, its `TRACE_CODEBUILD_PROJECT` output says `none`, the
  installer and the self-update leave that repository's jobs on GitHub's runners and say why, and every later deploy
  tries again. The flat layout's projects keep CloudFormation's own webhook: a flat stack of 20 projects has no room
  for one more resource each.
- **With the token**, the installer imports it before the deploy as CodeBuild's account-level GitHub source credential
  (`ImportSourceCredentials`, server type `GITHUB`, auth type `PERSONAL_ACCESS_TOKEN`; Advanced chooses the agents'
  token or the admin token). The runner projects then name no source credential of their own, so CodeBuild uses that
  one for their webhooks, runner registration and checkouts
  ([multiple access tokens](https://docs.aws.amazon.com/codebuild/latest/userguide/multiple-access-tokens.html):
  account credentials "will be used on a project when no project or source level credentials are specified"). An
  account that already has a GitHub source credential keeps it: it may be another team's, so trace uses it and leaves
  it alone, and the preflight says so. One trace imported is refreshed on every run and removed by `tracectl uninstall`.
  CodeBuild keeps the token itself: no job and no role can read it. The preflight stops when the token lacks
  Administration or Webhooks on a chosen repository, because CodeBuild could not make that runner and the deploy would
  fail.
- **With a connection**, CodeBuild uses the AWS Connector for GitHub app and no GitHub token is stored for it. Grant
  that app access to every repository trace builds. One connection serves the whole account and region: a person
  authorizes it once, in the AWS console, and every installation there reuses it, and says which one it used. Nothing
  needs it up front:
  1. The installer looks for a connection that is already authorized. If it finds one, it deploys once, with the
     runners, and sets each repository's variable.
  2. If there is none, the stack creates `<prefix>-github` and the first deploy goes ahead without the runners
     (CodeBuild can't attach a runner to a connection nobody has authorized yet). Until the build runners are added,
     workflows run on GitHub's runners.
  3. The installer shows the link to the AWS console, what to choose there ("Update pending connection", which
     installs the AWS Connector for GitHub app), and the time of its next check. It checks every 15 seconds for up to
     30 minutes.
  4. Once the connection is authorized, it deploys again. That only adds the runners and their GitHub webhooks, and
     then it sets the variables. If nobody authorizes it in time, the rest of the installation is finished anyway
     and the workflows keep running on GitHub's runners; authorize it and run the installer again to move them.

  A connection the stack created is kept if the stack is deleted, because other installations may be using it.
- **No AWS access comes with it.** The runner's own role may write its logs and (with a connection) use the
  connection, nothing else. Jobs reach AWS exactly as they do on GitHub's runners, through their repository's GitHub
  OIDC role.
- **Bigger machines:** `runners.computeType` sets every job's default size (large unless changed); a job can ask for
  another with an `instance-size:` label. `runners.privileged` turns on Docker for jobs that build containers.

`tracectl doctor owner/repo` notes when a repository has no AWS runner yet. A guard test fails the build if any workflow
here or in `templates/` names a runner other than its CodeBuild runner or the `ubuntu-24.04` fallback.

### Staying up to date

An installation updates itself when trace's own repository changes, so nobody has to run the installer (or
`tracectl upgrade`) for every update. The installer is still what makes the first installation, and what adds or removes
repositories, people and integrations or changes a setting.

- **What triggers it.** A push to trace's own default branch (a merged pull request). Once the tests pass, the
  `update-installation` job of `.github/workflows/ci.yml` deploys the stack again from that commit. It runs only in
  trace's own repository, and only once the installer has set that repository's `TRACE_UPDATE_ROLE`. One update runs
  at a time; a newer merge waits for the one before it.
- **What it deploys.** After its deploy (and after the second deploy that adds the build runners, when there is one),
  the installer saves the settings it deployed with in the central bucket (`installation/props.json`), with how the
  build runners reach GitHub (Advanced → Build runners: automatic, the token or a connection) and the connection named
  there, if any. No token or key is in it: the installer refuses to save a record any of them would be in. The job
  deploys with exactly those settings and this commit's code, so the images, the stack and the workflows' helpers move
  to the new version.
- **How the runners reach GitHub** is decided again, exactly as the installer decides it (see
  [Where builds run](#where-builds-run)). With **automatic**, a GitHub connection already authorized in the account and
  region is used when there is one, else the token CodeBuild already holds. With **a connection**, the runners are
  deployed only once it is authorized; if it is not, the summary says where to authorize it, and the next merge (or
  re-running the job) adds them. With **the token**, the job uses the GitHub source credential the installer imported:
  it never imports or changes one itself, so if CodeBuild has none in the region it does not deploy, and its summary
  says to run the installer again.
- **What it does besides.** Once the build runners exist, each repository's `TRACE_CODEBUILD_PROJECT` is set (or
  removed where its runner is gone) with the shared agent token. If the token may not change a repository's variables,
  the job still succeeds, and its summary lists which variable to set to what. It starts the GPU image build when that
  image changed, and does not wait for it.
- **Projects created in the web app.** A project made there (Projects → New) is onboarded at once, but its own agent,
  memory, knowledge base and build runner need the stack deployed again. Its request waits in the central bucket
  (`installation/pending-projects/`), and the next update adds it: the job deploys with the saved settings plus every
  such project (nested layout only, at most 60 projects), marks each request added, writes the project's token secret
  (a copy of the shared token) and sets its repository's variables and `TRACE_TOKEN`; what it cannot set, the step
  summary lists. A deploy that fails counts against the request; after two, the job leaves it to the installer. To add
  a project now rather than at the next merge, run the `ci` workflow on main by hand (Actions → ci → Run workflow). The
  next run of the installer takes every such project into its own answers and clears the requests.
- **What it can't do.** It cannot add repositories (other than those created in the web app) or people, change
  integrations, rulesets or onboarding pull requests, import CodeBuild's GitHub credential, or change any setting. Run the installer for those, and it saves the
  new settings for the next update. The job fails only when the deploy fails (CloudFormation then rolls the stack back
  to how it was), or when it cannot deploy faithfully (no saved settings, or the token's credential is missing).
- **Security.** The job signs in to AWS as `<prefix>-self-update`. That role can be used only by the `ci` workflow
  of trace's own repository running on its default branch: its trust policy checks the repository, the branch and
  the workflow file. It may use CDK's deployment roles in this account and region, read `installation/*`, read the
  stack's outputs, check the GitHub connection, see whether CodeBuild has a GitHub source credential (never its token)
  and read the shared agent token. For projects created in the web app it may also list and rewrite the requests under
  `installation/pending-projects/` and write (never read) the projects' token secrets (`<prefix>/github-token/*`).
  Nothing else in the account trusts it, and no project's role can read or write `installation/*` (the API may only
  write requests under `installation/pending-projects/`, with conditional writes). Deploying through CDK's roles can change anything the stack holds, so **whoever can merge to
  trace's default branch can change this AWS installation.** Protect that branch as you would the AWS account.
- **Turning it off.** Untick "Keep this installation up to date when trace's main branch changes" (Advanced → Build
  runners, under "Build trace's own repository on AWS too") and run the installer again. The role goes with that
  deploy, and the installer removes `TRACE_UPDATE_ROLE`, so the job no longer runs. It is on by default whenever trace's
  own repository is built on AWS; `tracectl uninstall` removes the job's variables with everything else.

## Putting another repository under trace

```sh
tracectl onboard owner/repo --apply-settings      # an existing repository: opens a held PR with what it adds
tracectl new owner/board --template kicad         # a new one: created, scaffolded and pushed
tracectl doctor owner/repo                        # what is still missing, and how to fix each item
```

`tracectl onboard` and `tracectl new` reach GitHub with the `gh` CLI, signed in as you. `tracectl install` does the same
onboarding through GitHub's API and `git` with the installer's token, so it needs no `gh`.

Onboarding adds the following:

| What | Why |
| --- | --- |
| `.trace/project.db` | The project's own SQLite database. It holds the detected settings and, later, every tool run. |
| `.trace/rules.md` | **Empty.** You write the rules. Agents treat them as the authority on what to do and when to ask you. |
| `.github/workflows/trace-*.yml` | Four thin workflows that call this repository's actions: `prs`, `ci`, `worker`, `deploy`. |
| `.gitattributes` | Makes `project.db` merge row by row (`tracectl db merge`) instead of conflicting as a binary file. |
| `CLAUDE.md` section | A pointer to the rules and the tools. It is appended; nothing already there is replaced. |

Settings are changed with `tracectl config set <key> <value>` (`tracectl config keys` lists them all). Each workflow has a
kill switch, a repository variable set to `false`: `TRACE_PRS`, `TRACE_CI`, `TRACE_WORKER`, `TRACE_DEPLOY`. Work is
done by a specialist agent (see [Specialist agents](#specialist-agents)) on AgentCore by default; `tracectl config set worker.runner actions` runs it as a GitHub Actions job instead, which
runs on the project's CodeBuild runner in AWS like every other job (or on GitHub's runners until that exists).

## Data

trace's records are SQLite databases: the ones below, and beside them in the central bucket each project's journey
record, agents' facts, job index and cost ledger, the prompt overrides and the memory marks. The few other files it
keeps are listed after them. The ontology that names these records and the rules over them is designed in
[docs/ontology.md](docs/ontology.md), with its build plan in [docs/ontology-plan.md](docs/ontology-plan.md); nothing of it is
built yet.

- **Project database** (`.trace/project.db`): one per project. It holds settings plus the run record: every
  simulation, check, build and capture, with its measurements and artifacts stored as blobs. Use `tracectl runs`,
  `tracectl run <id>` and `tracectl artifact <id> <name>` to read it.
- **Central database** (`$TRACE_HOME/central.db`): one for everything. It holds the datasheet library (PDFs by
  sha256, page text, version history) and the parts database (stock, prices, lifecycle). Every project reads and
  writes the same one. Figures taken from a datasheet are cited by part number, sha256 and page.
- **Cache** (`~/.cache/tracekit/cache.db`): disposable data such as parsed boards and field-solver results.

The only YAML is what GitHub requires (workflow, action and Dependabot files). JSON is used only where another
program or service needs it (`package.json` and the `tsconfig` files, shadcn's `web/components.json`, the job files
trace hands Blender and the EMC scripts, kicad-cli's reports kept as run artifacts, and Bedrock's `<key>.metadata.json`
sidecars); for a few small objects in the central bucket (the installer's saved settings `installation/props.json`,
the price table `installation/cost/prices.json`, project requests under `installation/pending-projects/`, and when
each connected system was last seen, under `access/services-seen/`); for the sample project's seed files, which the
installer reads (`templates/sample/settings.json` and `tour.json`); for the design canvas's layout
(`docs/ui/source/canvas.json`); and for test fixtures.

## Tools

```sh
tracectl tools                                   # every tool
tracectl tool calc.divider vin=12 vout=3.3       # run one
tracectl tool kicad.drc project=hw/board.kicad_pro
claude mcp add trace -- tracectl mcp             # give Claude Code all of them
```

Tools that drive real hardware (instruments, buses, flashing a target) are refused, and hidden from MCP, unless
`TRACE_HARDWARE=1`. Run them only on a machine wired to the bench. Configure the bench with `tracectl config set` for
`hil.instruments`, `hil.serial` and `hil.can`. Every power supply must have voltage and current limits.

### Hardware in the loop without hardware

`tracectl hil emulate` starts a pretend bench on your own machine, so the hardware tools can run with no instruments.
That is how the sample project tests its board. Run it inside the project's clone:

```sh
tracectl hil emulate --write-settings --serial      # keep it running; Ctrl-C stops it
TRACE_HARDWARE=1 tracectl tool hil.psu instrument=bench-psu voltage=12 current=0.05 output=on
TRACE_HARDWARE=1 tracectl tool hil.dmm instrument=bench-dmm       # about 3.0 V
```

The bench copies the sample board's input stage. A 39k/13k divider and an RC filter bring the 0-12 V input down to
the microcontroller's ADC pin, and a diode clamps that pin at 3.3 V.

| Name | Pretends to be | What it shows |
|---|---|---|
| `bench-psu` | Rigol DP832 power supply, port 5555 | Channel 1 powers the board. Limits are 13 V and 0.1 A. |
| `bench-dmm` | Keysight 34465A multimeter, port 5557 | The ADC pin: a quarter of the input with the supply on, 0 V with it off. It also reads the board current, and a temperature of 25 °C. |
| `bench-scope` | Rigol DS1104Z oscilloscope, port 5556 | Channel 1 is the ADC pin, showing the last input change as it passes the filter (rise time about 0.35 ms). Channel 2 is a 1 kHz, 3.2 V test square wave. |
| `bench-uart` (with `--serial`) | The board's firmware console | Once the input is at 4 V or more, it prints `adc raw=3722 mv=11998` every second and a temperature every 5 seconds. It answers `READ`, `ID` and `HELP`. |
| `bench-can` | A CAN bus | python-can's `virtual` bus. It carries frames only between the CAN tools of a single trace process, and nothing on the bench answers. |

The command prints the settings these names need. `--write-settings` saves them into `.trace/project.db` and keeps
your other instruments. To use other ports, pass `--psu-port`, `--scope-port` and `--dmm-port`; 0 picks any free
port. `--host` sets the address the instruments listen on. The serial console needs Linux or macOS and `python3`
(standard library only). It is a pseudo-terminal, reached through a fixed link at `/tmp/trace-bench-uart-<psu port>`.
Tests start the same bench with `startBench()` from `src/tools/hil/emulator/bench.ts`.

## Library gateway

The shared library's tools (datasheets and parts) can run behind one Amazon Bedrock AgentCore Gateway instead of in
every worker. Turn it on with `gateway.enabled` in the stack settings, or **Library gateway** in the installer's Agents
step. It is off by default, and with it off every tool runs in the worker, as before.

**What moves.** Only calls that need nothing on the worker's disk: `datasheets.list`, `.find`, `.text`, `.history`,
`.add` (from a URL), `.acknowledge`, and `parts.lookup`, `.search`, `.alternatives`, `.bom_check` (with `rows`),
`.fetch_datasheet` (`src/core/gateway.ts` `LIBRARY_TOOLS`). A call that names a local file or another store (`file`,
`path`, `library`) runs where it was made, and so do `datasheets.get`, `.tables`, `.params` and `.page_image`, which
hand back a local path or need Python or poppler. Everything that works on a project (KiCad, simulation, PCB,
firmware, hardware, memory, the knowledge base, GPU jobs) stays in the project's own worker, under its own role.

**Why only the library.** A Lambda target runs with the gateway's role, never the caller's, and is not told who
called. A per-project tool behind a shared gateway would need a role that reaches every project, which is the line
[Project isolation](#project-isolation) draws in IAM. The central database is shared by every project already, so the
gateway's Lambda reaches nothing a worker can't.

**How a call gets there.** The agent's MCP configuration does not change: `tracectl mcp` stays its one server. With
`TRACE_GATEWAY_URL` set (the stack sets it on every worker), `tracectl mcp` forwards these calls to the gateway as MCP
`tools/call` on `library___<tool>`, signed with SigV4 by the runtime's own credentials (the gateway's inbound auth is
`AWS_IAM`; an MCP client's remote configuration takes static headers only, so the signing has to be done here).
Parts calls carry the project's `parts.providers` and `parts.currency`, since the Lambda has no project. The Lambda
(`src/library/lambda.ts`) answers in an envelope that `tracectl mcp` unwraps, so a forwarded call reads the same as one run
in-process, and refuses any `file`, `path` or `library` whoever sends it.

**When a call fails.** Only a failure that means the call never ran counts as unreachable: the session could not be
opened, the connection was refused, or the gateway answered 401, 403, 429 or 503. A read then runs in the worker
instead, and `tracectl mcp` says so on stderr; a write (`datasheets.add`, `.acknowledge`, `parts.fetch_datasheet`)
reports the error. Anything else (an MCP error, the Lambda timing out, another HTTP status) may have run behind the
gateway, so it is answered as an error and never run a second time here. An expired session (404) is opened again and
the call sent once more. So while the gateway is on, library-tool writes without local inputs go only through it. A
call with `file` or `library`, and the CLI, still write `central/` with the worker's role: the worker role keeps its
conditional write there, because the central database is one SQLite file that also holds the project registry
(`src/core/onboard.ts`), and IAM can't let a worker write one table and not the library's.

**Downloads.** `datasheets.add` and `parts.fetch_datasheet` download from a URL, now from the shared Lambda. Every
hop is checked against private, loopback, link-local and multicast addresses, including IPv4 written inside IPv6
(`::ffff:7f00:1`, `64:ff9b::/96`), and the connection goes to the address that was checked, so a name that resolves
differently the second time (DNS rebinding) can't reach the Lambda's runtime API or anything else inside AWS.

**Distributor keys.** The installation's [optional integrations](#optional-integrations) (`<prefix>/integrations/<name>`):
with the gateway on, only the Lambda's role may read them, so no agent, which has Bash and its role's credentials,
can. The Lambda also still reads the older single secret, `<prefix>/library-keys` (output `LibraryKeysSecretArn`), for
any key the integrations leave unset; the installer no longer writes it. Without the gateway, each worker reads the
integrations itself (and its agent can read them).

**Resources** (`src/infra/gateway.ts`, in the parent stack):

| Resource | What it may do |
| --- | --- |
| `<prefix>-library` gateway | `AWS_IAM` inbound auth, MCP. Its role (`<prefix>-gateway-<region>`) may only invoke the Lambda. |
| `library` target | Lambda target, `GATEWAY_IAM_ROLE` credentials, its tool schema generated from the tools' zod inputs without their local inputs. Gateway's schema has no enums or bounds, so they are kept in each field's description; the Lambda validates with the full zod schema. |
| `<prefix>-library` Lambda | Node 22 on arm64, 2 GB, 10 minutes (a 2,000-line BOM check asks the providers line by line). Role `<prefix>-library-<region>`: read `central/*`, write it only with a conditional put, read the keys secret and `<prefix>/integrations/*`. Nothing of `projects/`, `jobs/`, `access/` or `prompts/`. |
| `<prefix>/library-keys` secret | The older home of the distributor keys, read for any key the integrations leave unset; never written by CloudFormation. |

**Cost.** Gateway calls are $0.005 per 1,000, and tool indexing $0.02 per 100 tools a month (11 tools), at
[AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/); the Lambda is billed per call. Nothing runs
while idle.

**Not yet tried on a real deploy.** Everything above is tested offline: the bundle CloudFormation ships is built and
run against a local store, and the client is run against a local MCP server that checks every request's SigV4
signature. Still to confirm on AWS:

- that the gateway accepts the generated tool schema and lists `library___<tool>` as expected;
- that `bedrock-agentcore:InvokeGateway` on the gateway ARN is all a worker role needs to call it with SigV4;
- that the `nodejs22.x` Lambda runtime has `node:sqlite` without a flag (Node 22.13 and later);
- how the gateway wraps the Lambda's answer (`tracectl mcp` unwraps the envelope only when it finds it, and passes
  anything else through unchanged).

## GPU jobs: rendering and autorouting

AgentCore runtimes have no GPU. Tools that need one, the Blender renders and the PCB autorouters, run their programs
through `runJob` (`src/gpu/jobs.ts`). A job runs on the local machine when that machine has an NVIDIA GPU or the job
does not need one. Otherwise, when `TRACE_GPU_QUEUE` is set (the stack sets it on each project's worker runtime,
with that project's job definition), the job goes to an AWS Batch queue of GPU instances that scales to zero when
idle. Inputs travel through the central bucket's `jobs/<owner>/<repo>/` prefix (`TRACE_PROJECT`; `jobs/_local/` outside
a project), and outputs and logs come back the same way, so the tool answers the same wherever the job ran. The API
runtime has no GPU or CPU queue and runs no tool itself: its `tool` action is forwarded to the project's worker
runtime (invocation kind `tool`, `src/agents/runtime/tool.ts`), which runs it on its clone of the default branch.
A job's spec (its argv, file names and program environment) is written to `jobs/<slug>/<id>/spec`, and the
container gets only `TRACE_GPU_JOB_URI` and `TRACEPARENT` and runs the definition's generic
`node /app/dist/gpu/runner.js`: AWS Batch's DescribeJobs has no resource-level permission, so anything in a job's
command or environment would be readable by every project. Input names may be relative paths (`rtl/sub/x.vh`); the
job sees them in that tree, locally and on the queue. A CPU job sent to the queue (`remote`, or
`TRACE_GPU_REMOTE=always`) goes to `TRACE_CPU_QUEUE` with `TRACE_CPU_JOB_DEFINITION` when the stack sets them, else to
the GPU queue. A job's `vcpus` hint becomes a VCPU override, capped at `TRACE_CPU_JOB_MAX_VCPUS` /
`TRACE_GPU_JOB_MAX_VCPUS` (not applied when the cap is unset).
`TRACE_GPU_REMOTE=always|never` overrides this choice. The installer's Agents step can turn the queue off and sets
its vCPU limit and Spot use (`gpu.enabled`, `gpu.maxVcpus`, `gpu.spot` in the stack settings). The GPU image is
described in `agent/README.md`.

**CPU jobs.** CPU-heavy jobs sent remote (openEMS, and Verilator, formal and nextpnr runs with `remote`) go to a second
Batch compute environment and queue, `<prefix>-cpu`, of x86 CPU instances (`c7i`, `c6i` and `m7i` families by default,
on the plain ECS Amazon Linux 2023 AMI), also scaling from 0 vCPUs. They run the same image as the GPU jobs: its CUDA
runtime base starts and runs CPU programs without a GPU, and only the programs that use CUDA load it. Each project has
a CPU job definition, `<prefix>-cpu-<hash>` (16 vCPUs and 32 GiB by default; with 32 GiB a job needs at least a
`c7i.8xlarge` or an `m7i.4xlarge`, so ask 30 GiB to fit a `c7i.4xlarge`), with the project's own job role, and each
worker is told `TRACE_CPU_QUEUE` and `TRACE_CPU_JOB_DEFINITION` (and `TRACE_GPU_JOB_MAX_VCPUS` and
`TRACE_CPU_JOB_MAX_VCPUS`, the two definitions' vCPUs, at which a job's `vcpus` hint is capped) and may submit there only with its own definition and
tag, as on the GPU queue. `src/gpu/batch.ts` sends a job that needs a GPU to the GPU queue and any other to the CPU
queue. Settings: `cpu.enabled` (default true), `cpu.instanceTypes`, `cpu.maxVcpus` (default 64), `cpu.spot`,
`cpu.vcpus` and `cpu.memoryMiB`, and the installer's CPU fields. The CPU queue shares the GPU side's image, network
and execution role, so it needs `gpu.enabled`; and it exists only in the nested layout, because a flat stack of 24
projects has no room for one more resource per project.

**The GPU image does not hold up the deploy.** CloudFormation cannot isolate a failure inside one stack: a failed
resource, a nested stack's included, rolls back the whole update, so putting the GPU side in a nested stack of its own,
or ordering it with dependencies, would still roll back the core with a broken GPU image. So the deploy starts the
GPU image's build (the same custom resource as before, with `Wait: 'false'`) and does not wait for it; no job
definition or project depends on it, and the job definitions name the image tag, which Batch resolves only when a job
starts. The installer then waits for that build as its last step (output `GpuImageBuild`, the build's id; CodeBuild
`BatchGetBuilds`), with everything else already installed. If that build failed in an earlier run (an unchanged
source starts no new build), the installer starts it again once (`StartBuild`, the same tag); if this run's build
fails, it says so, GPU and CPU jobs fail to start until it is fixed, and the next installer run retries it. Building
before the deploy instead was not chosen: the new source reaches S3 only when `cdk deploy` publishes it, so a build
before it would check the old source. Deploying by hand with `cdk deploy`, nothing waits for the GPU image: check the
`<prefix>-gpu-image` build in CodeBuild.

`pcb.autoroute` routes a KiCad board with up to two routers in turn:

- **OrthoRoute** is a CUDA lattice router. It handles the board's complex core: BGA escapes, dense buses and
  backplane connector fans. It is not a general-purpose router.
- **Freerouting** is a CPU push-and-shove router. It routes everything else around what OrthoRoute laid down, which
  is locked first.

With `engine: auto`, the tool decides from the board. A board without a complex core, or with no GPU reachable, gets
Freerouting only, and the answer gives the reason. The answer also includes the plan, a report for each stage, the
unrouted count and KiCad's DRC. The tool writes `<name>.routed.kicad_pcb` and never overwrites the input unless
`in_place` is set. `engine: orthoroute` or `engine: freerouting` re-runs one stage on its own. The thresholds are in
`electronics.autoroute.*`. To run either router locally, set `TRACE_FREEROUTING_JAR` (Freerouting needs Java 25,
`TRACE_JAVA`), `TRACE_KICAD_PYTHON` (a Python that can `import pcbnew`), and `TRACE_ORTHOROUTE` /
`TRACE_ORTHOROUTE_PYTHON` (its source, and a Python with numpy, scipy, psutil and, for the GPU, cupy).

## Verification and FPGA implementation

The Verification agent keeps a project's requirements, test plan and evidence in the project database. The tables are
`requirements`, `test_items`, `test_results`, `coverage_points` and `coverage_hits`, and `tracectl db merge` merges them
like everything else. Requirements, tests and points keep the newer row; results and hits are unioned. New
requirement ids are random (`REQ-<6 hex>`), so branches do not collide; older ids (`REQ-001`) are kept. When two
branches still added different requirements under one id, the merge keeps both: theirs is renamed `<id>-<6 hex>`, its
test items and coverage points follow, and the rename is listed as a merge note (`verify.requirements` list).

| Tool | What it does |
| --- | --- |
| `verify.requirements` | Adds, lists and updates requirements: id, text, kind (functional, electrical, timing, emc), acceptance criterion, source and page. `extract` returns candidate requirements from a spec's text, or from a PDF or text file. It works by rules (requirement verbs, spec-table rows, numeric limits) and never writes; the agent confirms each one with `add`. |
| `verify.plan` | Test items. Each is linked to requirements, has a method (sim, formal, spice, hil, inspection, drc), and runs as a tool call (its args are checked against the tool's schema) or as a command. Items can also carry measurement limits (`expect`). |
| `verify.run` | Runs items through their tools or commands and records pass, fail, error or blocked, with the evidence run ids. Hardware tools are blocked unless hardware is allowed. Inspection items take a given verdict. |
| `verify.coverage` | The requirement coverage matrix (verified, coverage_gap, failing, partial, untested, no_test, waived). It merges functional coverage from the evidence runs (cover property points, formal covers, `TRACE_COVER <name>` lines in any simulator's output) against coverage points, plus line, toggle and branch coverage from Verilator's coverage.dat. |
| `verify.report` | The status as Markdown, kept as an artifact and optionally written to a file. |
| `verify.verilator` | Lint, plus build and run of a C++ or HDL testbench, with line, toggle and user coverage. |
| `verify.cocotb` | cocotb tests on Icarus or Verilator. Per-test verdicts come from results.xml. |
| `verify.formal` | A `.sby` file through SymbiYosys, or files + top in bmc, prove or cover mode. Without sby it runs yosys and yosys-smtbmc directly (the steps of sby's smtbmc engine). Counterexample traces come back as VCD artifacts. |

Beside the requirements, the project database keeps the design record the agents propose for Define, Architect and
Capture (`src/tools/design`): intent statements with their source, each requirement's link to the statement it is
derived from, the architectures compared (blocks with their key parts and the requirements each serves, connections,
criteria and scores), the pin plan, and which requirements each schematic sheet serves. It changes with the design, so
it is committed and merged (newer row wins) like the requirements. Agents only propose: accepting intent, striking a
requirement, fixing the criteria, choosing an architecture and agreeing a pin plan are a person's decisions, made in
the guided skills (or `design.decide`) and kept in the journey record, which agents cannot write.

| Tool | What it does |
| --- | --- |
| `design.intent` | Intent statements by topic (purpose, environment, power, interfaces, performance, physical, compliance, build, constraints, references): words, source, interface details, numeric limits, "don't care", "unknown, decide by", open questions with an owner, conflicts. Links a requirement to the statements it is derived from. Lists them with people's decisions where the journey is readable. |
| `design.architecture` | Options (one recommended, with why and what it gives up), criteria with weights, a score with a reason per option and criterion, each option's blocks (role, key part numbers, requirements served, place on the diagram) and connections (what flows). |
| `design.pins` | The pin plan: each pin's function, peripheral instance and use, net, reserved role (boot, reset, debug) and the alternate functions the datasheet allows. `check` compares it with the schematic's netlist through kicad-cli and records the findings as a run. |
| `design.sheets` | Which requirements each schematic sheet serves, and its block (or why it serves none). |

`kicad.export` keeps the drawings people look at in its run as well as in the output folder: one SVG per schematic
sheet (`sheets/<file>.svg`), the board SVG and the render, with `drawings.json` naming the file and sheet each draws
and its page size, so the app can place rule-check findings on them.

HDL sources keep their folder layout in the job (named relative to the deepest folder holding all of them, include
dirs walked into sub-folders, `` `include`` directives followed), and include dirs and source folders are passed as
`-I`/`+incdir+`, so `` `include "sub/x.vh"`` resolves and two sources may share a basename.

The Implementation agent's tools cover two areas:

- **FPGA:** `fpga.synth` (yosys for ice40, ecp5, gowin and xilinx; cell counts by resource), `fpga.pnr` (nextpnr with
  PCF, LPF or CST constraints, seed, placer, per-clock targets and floorplan regions), `fpga.timing` (Fmax against
  target per clock, slack, closure status, and critical paths split into logic and routing), `fpga.closure` (a fixed
  sweep of seeds, placers and options that keeps the best attempt) and `fpga.bitstream` (icepack, ecppack,
  gowin_pack).
- **PCB:** `pcb.placement_check` (courtyard overlaps on the actual courtyard polygons, an L stays an L, with the
  convex hull only when an outline does not close, said so in the finding; parts outside or near the edge, keep-outs, decoupling distance,
  connectors off the edge), `pcb.length_match` (diff pair skew and length groups against given or `.kicad_dru`
  tolerances) and `pcb.floorplan` (placement by sheet or block: boxes, density, overlaps, nets between blocks). The PCB
  tools read the board file and only report; they never move anything.

The programs run through `runJob` as CPU jobs: locally, or on the queue only with `TRACE_GPU_REMOTE=always`. A missing
program is reported as such. `examples/fpga-blinky` (iCEBreaker, ULX3S and Tang Nano 9K constraints) is the fixture
that goes from synth to bitstream. `examples/sensor-node/logic` has a cocotb test (`test_moving_average.py`) and
formal properties (`moving_average_props.sv`, `moving_average.sby`) for its filter.

## Analog, mixed-signal and EMC

The Analog/Mixed-Signal agent's tools run ngspice (built and tested against ngspice 42) through the same code as
`sim.spice`, and record every run:

| Tool | What it does |
| --- | --- |
| `ams.spec` | Analog specs in the project database (table `ams_specs`): min/typ/max, unit, conditions and source per spec set and measure. `tracectl db merge` keeps the newer row. |
| `ams.corners` | PVT corners: `.lib` sections (tt/ff/ss from the netlist's or `electronics.models` libraries) or `.param` sets, × supply values, × temperatures. Returns a table, and per spec the worst corner (least margin). |
| `ams.montecarlo_yield` | Monte Carlo yield against specs, with a Wilson confidence interval, and per measure a sensitivity ranking (correlation over the runs, and/or one-at-a-time ±tol runs). |
| `ams.opamp_check` | Generated benches around a subcircuit: loop gain by Middlebrook double injection (crossover, phase and gain margin), Aol/GBW, CMRR, PSRR±, slew, output swing, input common-mode range. |
| `ams.noise` | `.noise` integrated over a band, output and input-referred, spot densities, and the top contributing devices. |
| `ams.mixed` | One ngspice transient with the analog netlist, an ideal behavioural ADC and a Verilog design compiled by Verilator into a `d_cosim` library. Without Verilator it runs the analog part only and says so. |

`ams.mixed` reproduces ngspice's `vlnggen` steps itself, with ngspice's own shim sources. It gives every input bit
its own port, because ngspice 42's shim mis-clears bits of multi-bit inputs. It also keeps the library path lower
case, because ngspice lower-cases the netlist. The co-simulation is two-state and cycle-based: Verilog `#` delays
are not simulated. For the sensor-node front end driving `moving_average.v`, the averages match the latched ADC codes
sample for sample (`test/tools/ams`).

The EMC/Simulation agent's tools:

| Tool | What it does |
| --- | --- |
| `emc.spectrum` | Closed forms: trapezoid harmonics and envelope (Paul), differential-mode loop and common-mode cable radiation (Ott), and the cable current that meets a limit, against CISPR 32 class A/B. |
| `emc.precheck` | Rules on the board's geometry with no solver. It checks return-path gaps and plane-split crossings, switching-node area, fast nets near the edge, missing stitching vias, decoupling distance, and an edge-rate emission estimate. Each finding has a location and its evidence. |
| `emc.setup` | An openEMS FDTD model of a board region: copper, stackup, lumped/MSL ports, PML or MUR at a reported margin, graded mesh, optional NF2FF. It is written as one deterministic Python script, with cell count, memory and time estimates. |
| `emc.run` | Runs the model through `runJob` (kind `openems`). It goes to the Batch queue when `TRACE_GPU_QUEUE` is set and the model has more cells than `TRACE_OPENEMS_LOCAL_MAX_CELLS` (2e6). Returns a Touchstone file, IL/RL, a TDR impedance profile, and a far-field dBuV/m pre-compliance estimate against CISPR 32. |
| `emc.si` | scikit-rf checks on S-parameters: TDR discontinuities, insertion loss against a budget, and NEXT/FEXT between nets. |

Every radiated figure is labelled as a pre-compliance estimate. Locally, openEMS needs its Python modules
(`TRACE_OPENEMS_PYTHON`, or `openems-python` on PATH) and scikit-rf (`TRACE_PYTHON`). The GPU image builds openEMS
v0.37.0 and installs scikit-rf 2.2.0.

## Digital protocols and timing

`src/tools/protocol` simulates digital buses, checks them against datasheets and the bus standards, and draws their
timing. It builds on what is there: the models write VCDs that `sim.wave_read`, `sim.wave_decode`, `sim.wave_timing`
and `verify.*` read; the analog layer runs through `sim.spice`; datasheet figures come from the shared library through
`datasheets.params`; captures come through `hil.scope_capture` and `hil.scpi`; testbenches run in `sim.logic`.

| Tool | What it does |
| --- | --- |
| `protocol.model` | Bus-functional models: transactions in, edges out (`model.vcd`, `model.csv`; RS-232 line voltages as `line.csv`), every time configurable. **I2C** standard, fast, fast-plus and high-speed (master code at Fast-mode timing, then Hs), 7- and 10-bit addresses, read, write, combined (repeated START), ACK/NACK, clock stretching, two-master arbitration (wired-AND, the loser releases SDA), general call. **SPI** modes 0-3, MSB/LSB first, 1-32-bit words, several selects, daisy chains (each device's output shown), dual and quad lanes, tCSS / tCSH / tCSD, inter-word gaps, the responder's tV and tHO (MISO `x` between them). **UART/RS-232** baud, 5-9 data bits, parity (even, odd, mark, space), 1/1.5/2 stop bits, break, inverted logic, a transmitter clock error, and the RS-232 driver voltage (mark negative). **CAN 2.0A/B** with stuffing, CRC-15, the ACK slot and bit timing from the clock, sample point and SJW. **1-Wire** reset/presence and slots at standard and overdrive speed. **I2S** in I2S and left-justified formats. Each run decodes its own waveform and reports whether it gets the transactions back. |
| `protocol.bus_analog` | The physical bus as a SPICE netlist, run with `sim.spice`: open drain (Rp, Cb, Ron = VOL/IOL), push-pull (driver resistance and edge, the trace as RC or a transmission line, ideal or lossy LTRA, from `calc.impedance` and `kicad.net_length` when a board net is given, receiver capacitance), RS-232 (levels, slew, cable, 3-7 kΩ load). It measures, per edge at the receiver, rise and fall time (30-70 % for I2C as UM10204 defines them, 10-90 % otherwise), overshoot, undershoot, settling, levels, and the delay to VIH / VIL. Those delays are the effective timing `protocol.check` applies to a digital capture (`analog_runs`). |
| `protocol.pullup` | The I2C pull-up range from UM10204 section 7.1: Rp(min) = (VDD - VOL) / IOL, Rp(max) = tr / (0.8473 Cb). `calc.i2c_pullup` does the arithmetic. With `simulate`, it runs the pick through `protocol.bus_analog`. |
| `protocol.spec` | Device interface timing in the project database. For I2C: fSCL, tHD;STA, tLOW, tHIGH, tSU;STA, tHD;DAT, tSU;DAT, tVD;DAT, tSU;STO, tBUF, tr, tf, Cb, tSP and levels. For SPI: fSCK, SCK high/low, tCSS, tCSH, tCSD, tSU, tH, tV, tHO, tDIS, the modes and word sizes. For UART: baud and tolerance. Each parameter has min/typ/max in the unit given (stored as SI), conditions, and a citation. A citation is `verified: true` only when it has the part, sha256 and page. |
| `protocol.spec_extract` | Proposes specs from a datasheet in the shared library, by rules, with no model inside. Each characteristics-table row is matched on its normalised symbol (`tSU;DAT`, `t SU:STA` and `tSU(DAT)` are one symbol), then on its parameter name. A symbol that belongs to another protocol is skipped. Numbers are converted to SI, and each candidate carries its page citation. Rows whose cells are not plain numbers come back raw. It never writes: the agent confirms each row with `protocol.spec`. |
| `protocol.check` | Judges a capture against a device spec, the standard (UM10204 speed modes; 1-Wire standard or overdrive; the derived mid-bit tolerance for UART), or inline limits. For each parameter it reports the measured worst case, the limit, the margin, pass/fail, the two edges and the transaction where the worst case happened, and SPI mode compatibility. It is recorded as a `protocol.check` run with a measurement per parameter and margin, so trends show over commits, and `verify.run` can take it as a test item. |
| `protocol.compat` | The initiator-to-responder budget from two specs, at corners (slow, fast, and the worst mix). SPI covers write and read setup/hold, the read-path fmax, fSCK, SCK high/low, tCSS/tCSH/tCSD and shared modes. I2C covers each generated time against the responder's minimum, fSCL, and tLOW - tr - tVD;DAT - tSU;DAT. Flight time comes from the delays you give, or from lengths or board nets. A missing figure is listed, and its check is skipped. |
| `protocol.diagram` | Timing diagrams of a capture or a spec, or both stacked. They show signal lanes, bus lanes with values, decoded rows (START, ADDR 0x50 W, ACK, DATA, ...), measurement arrows from a check (green pass, red fail), cursors, and zoom to a window or a transaction. The SVG is written in TypeScript. A PNG is made when resvg, rsvg-convert or sharp is installed; otherwise it is skipped and the result says so. WaveDrom JSON comes back as text, sampled on a tick. Spec mode draws the datasheet timing at the spec's limits. |
| `protocol.capture` | A real bus to VCD: sigrok-cli with a logic analyser (fx2lafw by default; not installed by trace), `hil.scope_capture` channels digitised at a threshold, or an oscilloscope's digital channels over `hil.scpi` (Rigol MSO5000-style commands by default). With `protocol`, it then checks the capture like `protocol.check`. Hardware only. |
| `protocol.testbench` | A self-checking Verilog testbench from a model: the initiator's signals are replayed into the DUT edge for edge, and each bit the DUT drives is checked where the initiator samples it. Supported DUTs: SPI slave, I2C target (wired-AND SDA), UART receiver (with a clock). It prints `MISMATCH` and ends with `$fatal`, or prints `ALL TESTS PASSED`. `TRACE_COVER` lines go out per clean transaction and per response value. With `run`, it goes through `sim.logic`. |

`sim.wave_decode` gained the CAN, 1-Wire, I2S and dual/quad SPI decoders (`src/tools/sim/decode.ts`) and mark/space
parity. `sim/wave.ts` `i2cDecode` now also says where each worst UM10204 value was seen.

The table is `protocol_specs` (key: device, protocol, parameter), registered with `ensureProjectSchema`. `tracectl db
merge` keeps the newer row.

**Verification numbers** (`test/tools/protocol`, `test/examples/sensor-node-protocol.test.ts`):

- **Round trips.** Every protocol model's output decoded by the `sim.wave_decode` decoders gives back the transactions, field for field:
  - I2C: write, read, combined with repeated START, NACK on the address and on data, 10-bit write and read, general call, a chain of repeated STARTs, stretching, arbitration, Hs-mode;
  - SPI: 4 modes × MSB/LSB × 8/12/16 bits with two selects, a three-device daisy chain, dual, quad, and a single-lane command before a quad transfer;
  - UART: 5/7/8/9 bits × 5 parities × 3 stop-bit settings, inverted, a 2 % clock error, a break;
  - CAN: standard, extended, RTR, empty, no ACK;
  - 1-Wire: standard and overdrive, with reset, presence, write, read and no presence;
  - I2S: both formats, and 24-bit samples in 32-bit slots.
- **UM10204 pull-ups** (equations 1 and 2):
  - Standard-mode, 5 V, 400 pF: Rp(min) 1533 Ω, Rp(max) 2951 Ω.
  - Fast-mode, 3.3 V, 400 pF: Rp(min) 967 Ω is above Rp(max) 885 Ω, so no resistor works.
  - Fast-mode Plus, 3.3 V, 550 pF, 20 mA: 145 Ω to 258 Ω.
  - These match the curves of UM10204 Figures 42 and 43 as recalled; they were not read from the PDF.
- **SPICE against the RC closed forms:**
  - Open drain, 2.2 kΩ and 200 pF: 30-70 % rise time 372.81 ns, where 0.8473 RC = 372.81 ns (-0.00003 %). The delay to VIH is 503.8 ns. Starting from the bus low level VOL = 0.19 V (Ron 133 Ω), RC ln((VDD - VOL) / (0.3 VDD)) = 503.9 ns.
  - Open drain at 10-90 %, 4.7 kΩ and 100 pF: 1.0327 µs, where 2.197 RC = 1.0327 µs.
  - Push-pull, 1 kΩ into 100 pF: 219.72 ns, where 2.197 RC = 219.72 ns (+0.00008 %).
  - Transmission line, 0.2 m of 55.1 Ω microstrip from `calc.impedance`: flight 1.168 ns, and the far end crosses VIH at 1.30 ns.
- **SPI timing budget at 10 MHz:**
  - Inputs: initiator tV 5 ns, tHO 1 ns, MISO set-up 10 ns, hold 0; responder tSU 5 ns, tH 5 ns, tV 20 ns, tHO 2 ns; 1 ns flight on each line.
  - Write: set-up slack 40 ns, hold slack 46 ns. Read: set-up slack 18 ns, hold slack 54 ns.
  - Read-path fmax: 15.625 MHz.
  - These are the hand-calculated values exactly. At 20 MHz the read set-up fails.

**What is verified and what is assumed.**

- The bus standards' figures in `src/tools/protocol/standards.ts` carry `verified: null`. No standard document is in the shared library, so they are cited from memory, not from a PDF:
  - UM10204 rev. 7 Tables 9, 10 and 12 and section 7.1;
  - AN126 and 1-Wire device AC characteristics;
  - TIA-232-F;
  - ISO 11898-1.
- The Table 10 figures are the same as the existing `I2C_LIMITS`, and a test keeps them equal. Add the PDFs with `datasheets.add` to confirm them.
- Model edges are ideal until `protocol.bus_analog` runs, and checks measure at the capture's pins.
- The I2C arbitration model shares one SCL between the two masters; clock synchronisation between different SCLs is not modelled.
- The CAN decoder resynchronises by at most SJW/16 of a bit.
- The UART tolerance is derived (±0.5 bit over the frame, split between the two ends) and labelled that way.
- Specific to `protocol.capture`:
  - The mso path has not been run against an instrument.
  - sigrok-cli is not installed here, so only its missing-program path is tested.
  - The scope path is tested against the fake SCPI scope.

## Thermal specialist

The Thermal specialist (`thermal`, label `agent:thermal`, memory actor `<owner>/<repo>/thermal`, settings
`agents.thermal`) is responsible for the thermal properties of a design: its job is to keep the design inside its
thermal envelope. Its workflow, in order (the catalog entry `specialist.thermal.workflow`, editable like the others):

1. establish the envelope (`thermal.envelope`) and the parts' limits from the datasheet library, each cited;
2. build the power budget (`thermal.budget`);
3. compute junction and case temperatures per part at every ambient corner (`thermal.junction`);
4. check them against the limits with the derating margin (`thermal.check`: one verdict, margins recorded per commit);
5. run a board-level model for hot spots and copper/via needs (`thermal.board`), sizing fixes with `thermal.pcb`;
6. when hardware is allowed, compare with measurements (`thermal.measure`);
7. report the margins and the parts at risk;
8. delegate design changes (pours, thermal vias, part swaps, heatsinks) to the worker, with acceptance criteria stated
   as thermal margins (e.g. "`thermal.check`: U3 `derated_margin_c` >= 5 at every corner");
9. escalate trade-offs (cost or size against margin) to a person.

Which board solver when (the workflow says so too): **2.5D** for quick checks on every commit; **CalculiX** for 3D
conduction (heatsinks, enclosure walls, component bodies, through-thickness paths); **CFD** for enclosures, ducted or
fan-cooled designs, dense card cages and fin spacing, where the airflow decides the answer. A CFD run's effective h is
stored as the envelope's correction and used by later 2.5D and CalculiX runs.

### Tools

| Tool | What it does |
| --- | --- |
| `thermal.envelope` | The envelope (table `thermal_envelopes`): ambient min/max (and a nominal corner), environment `natural`, `forced` (m/s), `sealed` (enclosure dimensions, wall) or `vacuum` (radiation only), orientation, altitude, emissivity (or a finish from the table), and the derating policy: `Tj <= Tj_max - offset` or `Tj <= fraction x Tj_max` (°C). Part limits (table `thermal_part_limits`): Tj max/min, θJA, θJC, θJB, ψJT, ψJB, each with a citation (`{mpn, sha256, page}`, or `{source}` for a manual figure; a figure without one is refused). `from_datasheet` proposes figures from `datasheets.params` rows, only where every matching row agrees. Also lists and clears the stored calibrations (`thermal_corrections`). |
| `thermal.budget` | Power per part. Priority: explicit, a SPICE operating point (ngspice `.op`: `@r1[p]`, `@q1[p]`, `@m1[p]`, or V(a,k) x `@d1[id]` for a diode, since ngspice's `@d[p]` is not usable), regulator calculations (LDO `(Vin - Vout) Iout + Vin Iq`; buck/boost `Pout (1 - eta)/eta`, with eta from the datasheet curve, else 0.85 assumed and flagged), datasheet typical/max. A part given twice keeps the higher-priority figure and lists the other. Totals per rail and for the board; stored as a scenario (`thermal_budget`). |
| `thermal.junction` | Tj per part at each corner: ψJT with a measured top, ψJB or θJB with the board model's temperature under the part, θJC plus interface plus heatsink, else θJA. It reports the margin to Tj max and to the derated limit, the status (pass / at-risk / fail / unknown), and which metric was used with its caveat (θJA is a JEDEC test-board figure, not this board). |
| `thermal.pcb` | Calculators: spreading resistance (circular isoflux source on a cooled plate: the separation-of-variables series of Kennedy 1960 / Song, Lee & Au 1994), via arrays (barrels in parallel, optional fill, laminate in parallel), copper area for a target θ (an annular fin, Incropera table 3.5), and trace temperature rise (IPC-2221B, inverted from `calc.trace_width`; IPC-2152's charts have no closed form and are not implemented). |
| `thermal.board` | The board model at one corner. `solver=2.5d` (default): a finite-volume grid, one node per copper layer; copper coverage rasterised from zone fills, tracks and pads; vias as vertical conductances; Jacobi-preconditioned CG. `solver=calculix`: 3D bricks (`DC3D8`) per copper layer and dielectric sublayer, with optional component bodies, run by `ccx` through `runJob` kind `calculix`. `solver=cfd`: OpenFOAM, below. Returns per-part board temperatures, the hot spot, the energy balance, grid size and solve time. Artifacts: temperature maps (PNG) and colour bar, CSV, VTU (ParaView), a temperature-textured GLB, the Markdown report, and the solver deck and logs. Large 2.5D grids (more than `TRACE_THERMAL_LOCAL_MAX_CELLS`, 400k) go to the CPU queue (`runJob` kind `thermal`, inputs and results in SQLite files). |
| `thermal.check` | Budget, junction and (with a board) the board model at every corner of the envelope, as one verdict. Records `<ref>.tj_c`, `<ref>.margin_c`, `<ref>.derated_margin_c` (worst over the corners) and per-corner figures, with the commit, so `trace.runs kind=thermal.check` shows the trend. |
| `thermal.validate` | Each solver against closed forms at two mesh sizes (numbers below); `solver=cfd` writes, and runs where OpenFOAM is available, the vertical-plate case against Churchill & Chu. |
| `thermal.measure` | Hardware only. Bench temperatures at stated points: the DMM's temperature function (`CONF:TEMP TC,K`, RTD, FRTD, thermistor), a Pt RTD read as resistance (IEC 60751), any SCPI query, firmware serial telemetry (a regex), or a manual reading. Each point is compared with a model run (error = predicted - measured). A heater calibration (heater power, measured ambient, a 2.5D run) fits an h multiplier by re-running the model, and stores it with both run ids. |
| `thermal.derating` | Derating curves (`thermal_derating`), from points or a datasheet table, cited; checks an operating point (outside the curve is out of range, never passed). |
| `thermal.compare` | Two time series (runs' CSVs, or inline measurements) overlaid, as Antmicro's `tpost compare-csv` does: max, RMS and end difference, and the plot. |
| `thermal.render` | A `thermal.board` run's temperature-coloured GLB through the Blender pipeline (`runJob` kind `blender`), as stills or a turntable, with the colour bar. |

`tracectl db merge` merges the five thermal tables by key, keeping the newer row.

### The models and their limits

- **Convection** is a film coefficient from textbook correlations (Incropera 7th ed.). Natural convection uses
  Churchill & Chu for a vertical plate, and hot-face-up and hot-face-down correlations for horizontal faces; forced
  flow uses the laminar or mixed flat plate. The air properties come from table A.4 at the film temperature, and
  altitude lowers the density. Like Antmicro's `find_coef.sh`, the coefficient is iterated until the surface
  temperature it assumes matches the solved one, and the converged h per surface is in the result and the report.
  `h_override` fixes h. A heater calibration or a CFD run stores a correction, which later runs apply and report.
- **Radiation** exchanges with surroundings at the sink temperature, with a view factor of 1. The 2.5D model
  linearises it per cell and iterates; CalculiX solves it exactly (`*RADIATE`). Emissivities (`materials.ts`) cover
  solder mask, FR-4, anodised, black-anodised and bare aluminium, polished and oxidised copper, and black paint. Each
  has a source and `verified: null`, because none was read from a document in the library.
- **A sealed enclosure** is a lumped network: board to internal air, the wall, and the outside with radiation.
  **Vacuum** is radiation only.
- **2.5D and CalculiX do not compute airflow (no CFD).** In the 2.5D model, component bodies are not modelled: all of
  a part's heat enters through its pads. Laminate figures are typical (`verified: null`) unless you give them.
- **CFD** (`solver=cfd`) is OpenFOAM conjugate heat transfer, ESI-OpenCFD v2412: `chtMultiRegionSimpleFoam` for
  steady runs, `chtMultiRegionFoam` for transient ones. The openfoam.org releases replaced these solvers with
  `foamMultiRun` from v11. trace writes the whole case in TypeScript into the job's scratch space:
  - meshing with blockMesh, snappyHexMesh (the board and each powered part as boxes, turned into cell zones) and
    `splitMeshRegions -cellZones`;
  - laminar flow for natural convection, k-omega SST for forced flow, and gravity with a perfect gas or Boussinesq;
  - optional fvDOM or P1 radiation;
  - for forced flow, a fixed flow or a fan curve (`fanPressure`);
  - outputs: residuals, probes, the wall heat flux and the enthalpy flux through every open boundary (the energy
    balance), per-region temperatures, and `foamToVTK`.

  Limits: the board is one isotropic solid with its in-plane effective conductivity, so through-thickness
  conduction is over-stated. Parts are boxes. Fan curves are idealised (uniform, no swirl). The mesh is only as good
  as the geometry. Runs take minutes to hours, so they go to the CPU queue by default. **No CFD run was made where
  this was written:** the sandbox could not install OpenFOAM. The dictionaries were checked against ESI's own v2412
  `cpuCabinet` and `multiRegionHeaterRadiation` tutorials and are unit-tested. The real-run test
  (`TRACE_THERMAL_CFD_TESTS=1` with OpenFOAM present) is skipped otherwise.

### Validation

The 2.5D grid and CalculiX solvers were checked against closed forms (`test/tools/thermal`, `thermal.validate`) at
two mesh sizes each. Each cell gives the error against the closed form:

| Case | Closed form | 2.5D coarse / fine | CalculiX coarse / fine |
| --- | --- | --- | --- |
| slab: 2-layer board, 1D through the thickness (2 / 1 mm cells) | q'' (t/k + 1/h) = 26.25 K | 0.0 % / 0.0 % | 0.0 % / 0.0 % |
| fin: 100 mm strip heated at one end, adiabatic tip (2 / 1 mm) | Incropera table 3.4, 53.18 K | +0.002 % / +0.0005 % | -1.29 % / -0.64 % |
| plate: 300 mm, 10 mm disc source (5 / 2.5 mm) | infinite-plate Bessel solution, 7.131 K | -1.74 % / -0.30 % | -0.67 % / +0.14 % |

The tolerances asserted by the tests are 0.5 % for the slab and 3 % for the fin and the plate. The energy balance
closes to about 1e-8 in the 2.5D model and to better than 0.1 % in CalculiX.

The hot-board fixture is 1 W in a SOT-223 regulator on a 50 x 50 mm, 2-layer board, at 50 °C, with natural
convection and radiation. Without copper the board under U1 reaches 164 °C (2.5D) or 156 °C (CalculiX), Tj is
174 °C, and the check **fails**. With a pour on both layers and a 4 x 4 array of 0.3 mm vias the board reaches
92.8 °C (2.5D) or 88.0 °C (CalculiX), Tj is 102.8 °C against a derated limit of 105 °C, and the check **passes**. The
two solvers' rises above ambient differ by 7 % on the bare board (114.2 against 105.9 K) and 11 % on the poured one
(42.8 against 38.0 K). The 2.5D model is the warmer, so it errs on the safe side. The difference comes from the model
forms: sheets against bricks, linearised against exact radiation, and edge films. The `examples/sensor-node` envelope `bench` and budget
`nominal` (`tools/setup-db.ts`) run on the real board. R1, R2 and R4 pass. D2 is **unknown**, because its datasheet
gives no junction figures, and the check says so rather than guessing.

### Credits

The thermal workflow follows Antmicro's open-source thermal simulation work: geometry to CalculiX `ccx`, film
coefficients solved for self-consistency (`find_coef.sh`), heater and thermocouple validation, a vacuum case, CSV,
plots and run comparison (`tpost`), Markdown reports (`tpre report`), and ParaView, glTF and Blender visualisation.
See [Open source thermal simulation, analysis and visualization](https://antmicro.com/blog/2025/03/open-source-thermal-simulation-analysis-and-visualization)
and [antmicro/thermal-simulation-scripts](https://github.com/antmicro/thermal-simulation-scripts) (Apache-2.0).
trace does not run their FreeCAD-based `tpre`/`tpost`. It builds its models from the KiCad board directly, and the
optional `pipeline: 'antmicro'` mode is left as future work. Enclosures use build123d rather than FreeCAD; see [Enclosures](#enclosures).

## Enclosures

A board's case is a build123d script in the project repository, rebuilt from the board, and its fit check is the
layout gate's evidence for "The board fits its enclosure, or each clash is waived" (`layout.fit`). The design and the
choice of build123d over FreeCAD are in [docs/enclosure-cad.md](docs/enclosure-cad.md); the build contract between the
TypeScript tools and the Python engine is [docs/enclosure-build.md](docs/enclosure-build.md). The Implementation
specialist runs the tools; a person works through the **Case design** skill.

A project's case lives in `mechanical/`:

| Path | What |
| --- | --- |
| `mechanical/case.json` | The settings: the board, the process and material, walls, clearances, openings, quantity, and a reason for each value changed from the recommendation |
| `mechanical/case.py` | The case script, from the printed two-part shell template: `build(board, settings)` returns the base and lid; edit it to change the shape |
| `mechanical/<name>.step` | A handed-in case, when a person hands one in instead of the script |
| `mechanical/out/` | What `mech.build` writes: `case.step`, `case-base` and `case-lid` (or `case-case` for a handed-in file) as STEP, STL and 3MF, `fit.json`, `case.jsonld`, and `order.json` and `order.md` from `mech.order` |

The board facts come from the `.kicad_pcb` alone (the images have no KiCad 3D model library): the Edge.Cuts outline
and cutouts, the holes, and each part's courtyard box. A part's height is its footprint's `Height` field (mm), else
the common-package table in `src/tools/mech/heights.ts`, else 5 mm, reported as assumed. Set a `Height` field in KiCad
on any part whose height matters to the case.

| Tool | What it does |
| --- | --- |
| `mech.board` | The board facts the engine reads, with the heights that are assumed |
| `mech.init` | Writes `case.json` (the recommendation) and `case.py` (the template); refuses to overwrite without `replace: true` |
| `mech.settings` | Every value with its recommendation and reason; changes values and per-part clearances, refusing a change away from the recommendation without a reason |
| `mech.build` | Runs the engine (a `cad-script` job for a changed `case.py`, then a `cad` job), writes `mechanical/out/`, and checks the fit and the process's design rules; status pass only when both pass. Measures `clashes`, `gap_violations` and `assumed_heights`; `stages` says where each job ran |
| `mech.fit` | The latest build's fit, and whether it is stale: the board, `case.json`, `case.py` or the handed-in file changed since |
| `mech.hand_in` | Takes a STEP (the case body) or a `case.py` from the repository, then builds |
| `mech.capabilities` | JLC3DP's printing rules and JLCCNC's machining rules as stored, their source pages and whether they are stale |
| `mech.capabilities_check` | Fetches each source page and reports, figure by figure, whether the page still states it (`same`, `changed`, `unreadable`); changes nothing |
| `mech.order` | Writes the order sheet (service, process, material, finish, quantity, files to upload, the fit run, the upload page) for a person to submit and pay; it never places an order |

**The fit check.** A clash is any overlap over 0.001 mm³ between a part's envelope (its box, as tall as its height;
through-hole leads 2 mm under the far face) or the board and a case part, named by part and volume. The gaps are the
board's edge to the wall against `clearance.edge_mm` (default 0.5 mm), each top-side part to the lid against its own
clearance or `above_tallest_mm` (default 1.0 mm), and bottom-side parts and leads to the floor against `below_mm`
(default 1.0 mm). A connector within 1.5 mm of the outline gets an opening in the wall unless it is listed in
`openings.skip`. Give a part more room (a mating face, a heatsink) with `mech.settings clearance=[{ref, mm, reason}]`.

**Process rules.** The recommendation is MJF PA12-HP at JLC3DP: strong, isotropic nylon, printed without supports,
which fits small enclosures within its 370 × 276 × 360 mm build. The rules come from JLC3DP's
[3D printing design guideline](https://jlc3dp.com/help/article/3d-printing-design-guideline) and
[service page](https://jlc3dp.com/capabilities/3d-printing-service), and JLCCNC's
[machining guideline](https://jlccnc.com/help/article/CNC-Machining-Design-Guideline), read on 29 October 2026 and
kept in `src/tools/mech/capabilities.ts` with each source. They cover the minimum wall by part size, build size,
smallest hole, assembly clearance, and for CNC the wall and internal-corner radius. Screws go into pilot holes
(self-tapping): JLC3DP recommends M6 as the smallest printed thread.

**Keeping the rules current.** JLC3DP publishes no data feed, so trace's own CI re-reads the three pages every day
(`.github/workflows/capabilities.yml`, `scripts/capabilities-sync.mjs`, `src/tools/mech/capsync.ts`) and decides
figure by figure:

| What the page says | What happens |
| --- | --- |
| Every figure as stored | Nothing, until the table was last confirmed 30 days ago: then a pull request moves its date on (no figure changes, no case build goes stale) and merges itself once CI passes |
| A figure in the same words with other numbers, of a kind trace writes back (build sizes, walls, holes, tolerances, CNC walls, lead time) | A pull request from `capabilities/sync` writes it to `src/tools/mech/capabilities.updates.ts`, applied on top of the reviewed table, with the stored and new figure side by side. A person reviews and merges it; case builds made with the old figures go stale when it does |
| Anything else: a page or label that cannot be read, a figure reworded, one the engine computes in code (the CNC corner radius), or two figures for one row that disagree | One issue labelled `capabilities`, updated daily and closed when every figure is confirmed again. The table keeps the last reviewed figure, and its date does not move, so it still goes stale after 90 days |

A case build is stale when the figures it used change, not when they are only confirmed again. The workflow needs the
repository settings "Allow GitHub Actions to create and approve pull requests" and, for the self-merging date update,
"Allow auto-merge"; without them it says so in its summary and leaves the branch. `mech.capabilities_check` runs the
same comparison on demand and changes nothing.

**Where it runs.** The engine is Python (`python/tracebridge/mech`, `pip install 'python[mech]'`, build123d 0.13.0)
and runs as jobs of two kinds, because `mechanical/case.py` is code that a person, the worker or a pull request wrote
([docs/enclosure-build.md](docs/enclosure-build.md), "Trust"):

| Kind | Runs | In the cloud (nested layout) | On a laptop or in CI |
| --- | --- | --- | --- |
| `cad-script` | The case script, when `case.py` differs byte for byte from the template: the board facts and settings in, one STEP per part and `claims.json` out | The project's **cad function** (`<prefix>-cad-<hash>`): the tools image on a role with no S3 and no credentials that reach anything; the worker presigns URLs for the job's files (20 minutes) and sends only those | A local child process, as any repository code `tracectl check` runs |
| `cad` | trace's own code: the built-in template (an unchanged `case.py`, or none), the parts a `cad-script` job built, or a handed-in STEP; then the fit, the rules, the files and the records | The tools function, as the other job kinds | Local |

`mech.build` runs one `cad` job for the template or a handed-in file, and a `cad-script` job followed by a `cad` job
otherwise; its answer's `stages` say where each ran. The script's parts are claims: the `cad` job reads them strictly and
measures the geometry itself. The flat layout has no cad function, so there a custom `case.py` builds only on a laptop or
in CI; in the cloud `mech.build` refuses it and says so, while the template or a handed-in STEP builds anywhere. Locally the engine runs with `TRACE_PYTHON` (else
`python3`) and `PYTHONPATH` at the repository's `python/`. `tracectl check` builds the case when `mechanical/case.json`
exists and fails on a failing fit; without build123d it says so and skips the case. In CI it builds the case only when
the workflow sets `TRACE_CHECK_MECH=1`, which the KiCad build template does for pushes and for pull requests from the
repository itself, and never for a fork's (`0`, with the reason in `TRACE_CHECK_MECH_WHY`); unset in CI, the case is
skipped and the line says why. The template installs build123d only in repositories that have a case.

**Changing a case.** The three routes from the design all end in `mech.build`. A person edits `case.py` or the
settings and pushes. In chat, the specialist changes the settings or delegates a script edit to the worker. A handed-in
file goes through `mech.hand_in`. A handed-in STEP no longer follows the board, and its wall thickness is not measured
(that rule row says so). Rebuild from the script to follow the board again.

## Specialist agents

Every job the loop starts (an `agent-fix` issue, a `ci-red` PR, a merge conflict, a sweep's items, a person's
`task`) goes to one **specialist**. The specialist investigates and measures with its own tools, and hands
repository changes to the **worker**, the generic agent with a shell and git, which runs only when a specialist
delegates to it. The worker's prompt, guardrails and job runner are unchanged.

| Kind | Specialist | What it does | Its trace tools (besides the shared ones) |
| --- | --- | --- | --- |
| `verify` | Verification | Turns specifications into requirements and a test plan, runs simulation, formal and rule checks against the plan, and closes functional and code coverage. It owns failing tests, testbenches, formal properties, coverage gaps and ERC. | `verify.*` (requirements, plan, run, coverage, report, verilator, cocotb, formal), `sim.*`, `kicad.erc`, `kicad.drc`, `protocol.*` but `pullup` (model, spec, spec_extract, check, compat, diagram, testbench, bus_analog); `hil.*` and `protocol.capture` only when hardware is allowed |
| `impl` | Implementation | Runs FPGA synthesis, place and route, timing closure and bitstreams, PCB placement, floor planning, routing and length matching, and the board's enclosure (see [Enclosures](#enclosures)). It owns timing failures, constraint files, unrouted nets and DRC. It renders the result for visual review. | `fpga.*`, `pcb.autoroute`, `pcb.placement_check`, `pcb.length_match`, `pcb.floorplan`, `kicad.drc`, `kicad.net_length`, `render.board`, `protocol.compat`, `protocol.check`, `protocol.diagram` (interface timing budgets), `mech.*` |
| `ams` | Analog & Mixed-Signal | Keeps analog specs and judges circuits against them: corners, Monte Carlo yield, op-amp stability, noise and ADC/digital co-simulation. It also chooses parts from the datasheet library. | `ams.*`, `sim.spice`, `sim.sweep`, `sim.measure`, `sim.kicad_spice`, `calc.*`, `datasheets.*`, `parts.*`, `protocol.bus_analog`, `protocol.pullup` |
| `emc` | EMC & Simulation | Runs EMI rule prechecks and emission estimates, sets up openEMS models (region, stackup, ports, boundary conditions, mesh) and runs them, and checks signal integrity from S-parameters. | `emc.*`, `calc.impedance`, `calc.trace_width`, `calc.via`, `kicad.board`, `kicad.net`, `protocol.bus_analog`, `protocol.pullup` (edge rates of the bus as built) |
| `render` | Rendering | Renders boards and models, and makes turntables. This was the rendering agent; it is kept as a specialist of its own, not folded into `impl`, because people ask for renders directly. | `render.*` |
| `thermal` | Thermal | Keeps the design inside its thermal envelope: the envelope and part limits, the power budget, Tj per part across ambient corners with a derating margin, board models (2.5D, CalculiX, OpenFOAM CFD) for hot spots and copper/via needs, derating curves, and bench measurements against the model. See [Thermal specialist](#thermal-specialist). | `thermal.*` (`thermal.measure` only with hardware), `calc.ldo_thermal`/`power`/`trace_width`/`via`/`buck`/`boost`, `sim.spice`, `sim.measure`, `datasheets.*`, `parts.*`; `hil.*` only when hardware is allowed |

Every specialist also has the shared read tools: `kicad.board`/`components`/`net`,
`datasheets.find`/`get`/`text`/`params`, `parts.lookup`, `trace.runs`/`run`/`artifact`, `memory.recall`/`remember`,
and `kb.search`/`kb.status` (offered only when the project has a [knowledge base](#knowledge-base)). Its prompt tells
it to search the knowledge base before it asks a person, and to cite each passage by its path.
It also has `agent.delegate`. Its Claude Code tools are read-only: Read, Glob, Grep and TodoWrite, with no Bash,
Write, Edit or Task. The allowlist is enforced three ways. The Agent SDK's `tools` option sets the built-ins and
`allowedTools` sets the rest. The job sets `TRACE_MCP_TOOLS`, so the MCP server lists only the specialist's tools.
In GitHub Actions (`worker.runner actions`) the same three hold: claude-code-action passes `--tools`,
`--allowedTools` and `--disallowedTools` (Bash, Write, Edit, MultiEdit, NotebookEdit, Task, WebFetch, WebSearch) to
Claude Code, and the install action's MCP config sets `TRACE_MCP_TOOLS` (see [Delegation to the worker](#delegation-to-the-worker)).
`tracectl agent list` shows each specialist, its settings and its tools.

Each specialist's prompt (`src/agents/<kind>/index.ts`, composed by `src/agents/specialist.ts` from the prompt catalog,
see [Managing prompts](#managing-prompts)) has these parts:

- its workflow, step by step, with the tools in order;
- what evidence counts as done: measured, with run ids, never claimed;
- when to stop and ask a person;
- the project's `.trace/rules.md`, read from the default branch and included in full;
- the setting `agents.<kind>.instructions`, a short text that may be empty. The rules win where the two differ.

`tracectl agent prompt <kind>` prints the composed prompt for review, with the prompt overrides in force (`--marked` heads
each part with its id, layer and version). Each specialist has its own memory actor,
`<owner>/<repo>/<kind>`.

### Routing

`src/agents/router.ts` picks the specialist. It tries these in order, and the first that decides wins:

1. **An explicit kind.** This is `tracectl remote task --agent <kind>`, the API's `task` with `agent`, or a route that
   worker-pick already made.
2. **A label** on the issue or PR: `agent:verify`, `agent:impl`, `agent:ams`, `agent:emc`, `agent:render` or `agent:thermal`. The names
   are the settings `labels.agent_<kind>`, and onboarding creates the labels.
3. **The evidence.** The router reads the names and log tails of the failing checks. The summary gate
   `build.required_check` is ignored when other checks failed. It also reads the changed files:
   - `verify`: `.sby`, testbenches and `tests/`, coverage data, HDL;
   - `impl`: `.pcf`, `.lpf`, `.cst`, `.sdc`, `.xdc`, `.kicad_pcb`, autorouter files, and timing, routing or DRC
     failures;
   - `ams`: `.cir`, `.sp`, `.lib`, and an `ams.spec` miss;
   - `emc`: Touchstone `.sNp`, and `emc.precheck` findings;
   - `thermal`: `.thermal` files, temperature logs (`temperature*.csv`, `temp-log*`), `thermal/` folders, power-stage
     schematics and boards (`*ldo*`, `*regulator*`, `*buck*`, `*mosfet*`, `*heatsink*`), and thermal check failures
     or over-temperature in the log (`thermal.check`, `derated_margin`, `junction temperature`, thermal shutdown).

   A rule counts once however many files match it. Keywords in the text break a tie.
4. **Keywords** in the issue, PR or task text (each specialist's `keywords`).
5. **The model**, as a last resort. This is one Agent SDK call with no tools and output constrained to
   `{ kind, reason, confidence }`. It is skipped when an explicit kind is given, and it is off with
   `agents.route_with_model false`. `agents.router_model` picks the model.
6. **The default**, `agents.default` (`verify`).

Only specialists in `agents.enabled` are candidates. Confidence is 1 for an explicit kind or a label, 0.5 to 0.95
for evidence (by its margin over the runner-up), 0.35 to 0.75 for keywords, at most 0.8 from the model, and 0.2 for
the default.

worker-pick (in GitHub Actions) routes each item it claims without the model. It writes the route into the item
(`route: { kind, reason, confidence, source }`), and the claim comment names the specialist and why it was chosen.
For a red PR it claims, it reads the failing GitHub Actions jobs' log tails the way ci-doctor does (at most 5 jobs,
the last 6000 characters of each; a check's `output.summary` is usually empty), and only for the items it claims.
An item that nothing decides goes to the runtime without a route, and the runtime asks the model. The workflow
passes the kind to dispatch (`agent:`), and each matrix job is named after it. The kind, reason, confidence and
source are recorded on the job (`status`) and as span attributes (`trace.agent.kind`, `trace.route.*`). Every
report a specialist posts starts with which specialist acted and why it was routed there.

To force a specialist, do one of these:

- label the issue or PR `agent:<kind>`;
- start the task with `tracectl remote task OWNER/REPO --agent <kind> "…"` (or `agent` in the API's `task`);
- for a dry run, use `tracectl agent route <issue|pr number|"text"> [--labels …] [--files …] [--checks …] [--model]`.

### Delegation to the worker

When a job needs the repository changed, or long mechanical work, the specialist calls
`agent.delegate { brief, acceptance: [criteria], branch? }`.

- **What runs.** The runtime starts a worker job: the existing job runner and the worker's task prompt
  (`src/agents/worker/prompt.ts`). The brief and the numbered acceptance criteria are its request.
- **Where it runs.** The worker runs in the specialist's own checkout, with the specialist's settings from the
  default branch. The runs the specialist recorded are already in that tree. With no branch given, the worker stays
  on the specialist's branch, or gets `claude/<kind>-<job>` if that is the default branch.
- **The wait.** The call blocks: the MCP tool polls the runtime over loopback until the worker ends or
  `agents.delegate_timeout_minutes` (240) passes. It returns the worker's state, its summary and its commits.
  Claude Code waits that long for it: the job sets `MCP_TOOL_TIMEOUT` (milliseconds, the wall-clock limit of one MCP
  call, default about 28 hours) and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (milliseconds; without it a stdio server
  that sends nothing for 30 minutes is cut off) to the wait plus 10 minutes, and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`
  to 0 (code.claude.com/docs/en/env-vars).
- **Stuck delegations.** A worker never outlives its specialist. When the specialist job is aborted, or ends while
  its worker still runs, the runtime aborts the worker job (its AbortController, through `jobs.ts`). When the wait
  times out, `agent.delegate` cancels the worker (`POST /delegate/cancel`) and returns `state: timeout`. Either way
  the delegation is `cancelled`. After a cancelled or failed delegation the specialist may delegate again, still one
  at a time.
- **After it returns.** The specialist checks every acceptance criterion with its own tools before it reports. A
  criterion that fails twice is escalated.
- **Depth 1.** A specialist job holds a per-job token. A delegated worker gets no token, so it is never offered
  `agent.delegate`, and the runtime refuses any token it did not issue. A specialist runs one delegation at a time.
- **Internal only.** `/invocations` and the API never accept a worker task (`agent: 'worker'`).

### How specialists consult each other

A specialist never calls another directly. When a question in another specialist's area blocks its work, or would
materially change it, it raises a **recorded hand-off** with `journey.handoff`, and the answer is recorded too
(`src/core/handoffs.ts`). Marc chose this over direct calls between agents and over the status quo (a person relays):
every consultation is visible, controllable by people, and cannot loop.

- **The request.** The specialist asked (an enabled one, never itself), the question in plain words, the evidence
  (run ids, files, artifacts, datasheet pages; checked against the checkout like `journey.check`'s), what it blocks,
  the asker's recommended answer if it has one, and acceptance: what a good answer contains. A vague request is
  refused with everything that is missing, before anything is written (guard 2).
- **The guards** (guard 1), checked on the same conditional write as the row: a job started by a hand-off raises none
  (depth 1, so A→B→A cannot happen; it is not offered the tool, and its row refuses it too); never to the asking
  specialist itself; at most `agents.handoff_max_per_job` (3) open hand-offs per asking job and
  `agents.handoff_max_per_project` (10) per project; and the same question is never asked again of a specialist that
  declined, failed or could not answer it.
- **Where it lives.** A row of the agents' facts, `projects/<slug>/journey-agent/facts.db` table `handoffs` (who
  asked, from which job, of which specialist, the request, depth, state, and later the receiving job and its answer).
  Agents may write it; the API only reads it.
- **The receiving job.** The asking job's own runtime starts it, the way a sweep starts its items: the tool posts
  `POST /handoff { token, id }` on loopback with the job's token (`src/agents/runtime/handoff.ts`), and the runtime
  reads the request back from the facts and starts a task for the asked specialist, carrying `handoff` (the recorded
  request, depth 1). It is an ordinary queued job of the project: it waits its turn in the project's queue, shows in
  the queue as "Asked by the Thermal specialist: …", and people may Hold, Move up or Cancel it (never Pause: cancelled,
  its asker is told it was not answered). It runs on a branch of its own (`claude/handoff-<id>`), with a header saying
  who asked for what and `journey.handoff_answer` instead of `journey.handoff`. No new permission: the worker's role
  already reaches the project's queue and facts.
- **The answer.** `journey.handoff_answer`, by the job started for that hand-off only (its id and job id): the answer,
  evidence, a confidence and whether the acceptance is met; or `answered: false` with why. A receiving job that ends
  without answering closes its hand-off as failed, with how it ended.
- **Waiting is optional** (guard 3). By default the asker does not wait: it records the hand-off and carries on or
  finishes, and the answer is recorded for its next job (`journey.status` lists the hand-offs it raised, with their
  answers). With `wait_minutes` it waits like `journey.ask`: on the project's events topic (the project's journey
  events rule also sends the writes of `journey-agent/facts.db`), with the declared timer fallback, and never past
  `wait_minutes`. The asker's queue slot is never held for the receiver: each has its own.
- **People.** A contributor or admin may decline a pending hand-off (`handoff.decline { repo, id, reason }`, a reason
  in one line; reviewers refused). The decline is in the journey record, never the agents' facts; a queued receiving
  job is cancelled, or stops at its turn. A running one is cancelled instead.
- **Escalation.** When a hand-off is declined, fails or cannot be answered, the asker sees it in `journey.status` and
  may ask a person (`journey.ask`) instead: it never asks the same specialist again.

**Under `worker.runner actions`** there is no runtime to delegate to, so the workflow's `work` job runs the same
pattern in steps (`src/harness/actions.ts`, `templates/workflows/trace-worker.yml`):

1. `worker-prompt`, then **the specialist**, read only: `--tools Read,Glob,Grep,TodoWrite`, its trace tools in
   `--allowedTools`, the write tools in `--disallowedTools`, and an MCP config limited to its tools
   (`TRACE_MCP_TOOLS`, from the install action's `tools` input). It ends with a structured output (`--json-schema`):
   `{ report, delegate, brief?, acceptance?, branch? }`.
2. `worker-delegate` reads it. When the specialist delegated, **the worker** runs next with the worker's tools (Bash,
   Write, Edit, Task, every trace tool), with the brief and the numbered criteria as its request.
3. **The check**: the specialist again, read only, checks each criterion with its own tools.
4. `worker-report` posts one report on the item, headed with which specialist acted and why, with each criterion met,
   not met or not checked.

One delegation per run: an unmet criterion is retried on the next run. claude-code-action passes `claude_args` to the
CLI as written, and adds GitHub MCP servers of its own only for tools named in `--allowedTools` (none here). Every
Claude step runs with `--setting-sources user`, and the AgentCore runtime with `settingSources: []`: a checkout's
`.claude/settings.json` and `settings.local.json` are never loaded, because their hooks would run commands (even in
the read-only specialist's session), add MCP servers or widen permissions, and a PR's author controls them. On
AgentCore the default branch's `CLAUDE.md` is read by trace and given to Claude as the project's notes; in the Actions
runner the CLI still reads the checked-out tree's `CLAUDE.md` (instructions only, no commands). With `TRACE_MEMORY_ID` (and `TRACE_AWS_ROLE` allowed to use that memory) the steps recall and record
memory under the AgentCore job's actors and session (`<owner>/<repo>/<kind>`, `<owner>/<repo>/worker`, `pr-<n>` or
`issue-<n>`).

### Settings

| Key | Default | What |
| --- | --- | --- |
| `agents.enabled` | all six | the specialists that may be routed to |
| `agents.default` | `verify` | where a job goes when nothing decides |
| `agents.route_with_model` | `true` | ask the model when labels, evidence and keywords do not decide |
| `agents.router_model` | `''` | its model (else `worker.model`, then the runtime's) |
| `agents.delegate_timeout_minutes` | `240` | how long `agent.delegate` waits for the worker |
| `agents.handoff_max_per_job` | `3` | open hand-offs one asking job may have ([How specialists consult each other](#how-specialists-consult-each-other)); 0 turns them off |
| `agents.handoff_max_per_project` | `10` | open hand-offs a project may have; 0 turns them off |
| `agents.<kind>.model` | `''` | the specialist's model (else the runtime's `ANTHROPIC_MODEL`, then `worker.model`) |
| `agents.<kind>.max_turns` | `120` | its turn limit (the delegated worker keeps `worker.max_turns`) |
| `agents.<kind>.instructions` | `''` | project instructions for that specialist, after `.trace/rules.md`: a short addendum. Prompt overrides ([Managing prompts](#managing-prompts)) are the full mechanism |

## Agent memory

Each agent has short-term and long-term memory in its project's own Amazon Bedrock AgentCore Memory: one per
repository, named `<prefix>_m_<hash>` and created with the project's other resources (`src/infra/project.ts` and
`src/infra/memory.ts`; the client is `src/agents/runtime/memory.ts`). The stack settings are:

- `memory.enabled` (default true).
- `memory.eventExpiryDays`: how long short-term events are kept. The default is 30 and AgentCore allows 3 to 365.
- `projectSettings`: settings for one project, keyed by `OWNER/REPO` (without `@BRANCH`): `memoryEventExpiryDays`,
  which overrides `memory.eventExpiryDays` for that project (the installer sets it from the "memory days" field
  beside each repository; an empty field means the default), and `generation` (below).

A project's memory lives and dies with the project. With `retainData` true (the default), each memory, its log group
and its log delivery are marked Retain. When the repository is removed from the list, or the stack is deleted, they
stay in the account, outside the stack. With `retainData` false they are deleted, records and all. Each project's
memory id is the output `Project<hash>MemoryId`, and the installer records them on this machine. Moving an
installation to nested stacks deletes every project's memory records (see
[Stack layout and limits](#stack-layout-and-limits)).

**Adding a removed project again.** A removed project can leave names behind in the account: its memory
(`<prefix>_m_<hash>`, kept with `retainData`), its memory's delivery sources and destinations (`<prefix>-m-<hash>-logs`
and `-traces`, kept with it), and its token secret (`<prefix>/github-token/<owner>/<repo>`, deleted, but holding its
name through Secrets Manager's recovery window). Creating them again would fail on the first name in use. So each
project has a `generation` (`projectSettings`, default 0), which goes into those names only when it is above 0
(`<prefix>_m_<hash>_g1`, `<prefix>-m-<hash>-g1-logs`, `<prefix>/github-token/<owner>/<repo>@g1`), so existing names
never change. Before deploying, the installer checks every project the stack does not have yet (from the stack's
resources) against the account: `ListMemories` (a memory's id is `<name>-<suffix>`, in any status),
`DescribeDeliverySources` and `DescribeDeliveryDestinations`, and `DescribeSecret` (which also finds a secret
scheduled for deletion). If any of a generation's names is taken it tries the next, saves the one it settles on with
the answers at once, and says so in the plan and the summary: the old memory is kept and orphaned, with its records,
and the new one starts empty. A project the stack already has keeps its generation; a generation is never lowered.

- **Short term:** events per actor and session. A job records what it was asked, its key trace-tool outcomes and its
  result. A job that continues a session (the same pull request or issue, or the same task branch) is given that
  session's earlier turns.
- **Long term:** three built-in strategies extract records from those events. The semantic strategy keeps facts
  about the project, the summary strategy keeps one summary per session, and the user preference strategy keeps how
  the project wants things done.

Each memory serves one project. The actor and namespace scheme from the time when one memory served every project
is kept, so every record still says whose it is, and the existing checks still hold inside each memory:

| Actor | Who |
| --- | --- |
| `<owner>/<repo>/<agent>` | One agent on one project. The agents are the specialists `verify`, `impl`, `ams`, `emc`, `render` and `thermal` (every job), `worker` (a specialist's delegation, continuing its session) and `local` (a person's own Claude Code). `ci-doctor` and `conflict` hold what was remembered before the specialists. A specialist's recall (at the start of a job, and `memory_recall`) also searches `ci-doctor`, `conflict` and `worker`, read only, ranked after its own records and tagged `legacy` in the prompt block; nothing is migrated (AgentCore cannot copy records). |
| `<owner>/<repo>/person/<hash>` | The person who started a task through the API: their own preferences, inside the project. The hash is part of the sha256 of their email, so the email itself never appears. |

| Strategy | Namespace |
| --- | --- |
| semantic (`trace_facts`) | `/trace/{actorId}/facts/` |
| summary (`trace_sessions`) | `/trace/{actorId}/sessions/{sessionId}/` |
| user preference (`trace_preferences`) | `/trace/{actorId}/preferences/` |

Every namespace therefore starts with its project (`/trace/<owner>/<repo>/`) and then its agent. Names are lower-cased,
and a repository's `_` and `.` are written `_u` and `_d`, because AgentCore allows neither in an id. The mapping is
one-to-one, so no two repositories share a namespace. Sessions are `pr-<n>`, `issue-<n>` or the task's branch.

At the start of a job, its memory is added to the end of the prompt in a fenced block that says it is data, not
instructions. Each item is one line, cut to length, and cannot close the fence. Everything recorded is scrubbed of
tokens and keys and is bounded in size (8000 characters per event, 12 tool outcomes per job). Without
`TRACE_MEMORY_ID` (its project's memory), or when AgentCore fails, a job runs as before without memory.

- **Inside a job:** Claude has the MCP tools `memory_recall` and `memory_remember`. They act only as the job's actor and
  session (`TRACE_MEMORY_ACTOR` and `TRACE_MEMORY_SESSION`, or `TRACE_MEMORY_REPOSITORY` and `TRACE_MEMORY_AGENT`), and
  they are offered only when `TRACE_MEMORY_ID` is set.
- **Through the API:** anyone who can read a project can see its memory with the read-only actions `memory.list` and
  `memory.recall` (optionally for one `agent`). The API learns every project's memory from `TRACE_PROJECT_MEMORIES`
  (`owner/repo=<memory id>`, separated by spaces, the same encoding as `TRACE_WORKER_RUNTIMES`). After the access
  check it reads only the memory of the project asked for. A project with no memory in the installation gets the
  same 403 "no access" as a project you are not assigned to. Person-scoped preferences are shown only to the person
  they belong to, and to admins.
- **In IAM:** each project's worker role may use only its own memory's ARN: `CreateEvent` and `ListEvents` for its
  project's actors (`<owner>/<repo>/*`), and `RetrieveMemoryRecords` and `ListMemoryRecords` under its namespaces
  (`/trace/<owner>/<repo>/*`). The API role may only recall, list and get records under `/trace/`, on each
  project's memory (it gets one to check it before marking it inactive, see below). Each project's GitHub OIDC role has
  its worker's grants on its own memory, for the `worker.runner = actions` fallback, which is told the memory by the
  repository variable `TRACE_MEMORY_ID` (set by the installer). The client draws the same lines as well (see
  [Project isolation](#project-isolation)).
- **Limits:** the API's three lists (`TRACE_WORKER_RUNTIMES`, `TRACE_PROJECT_MEMORIES` and `TRACE_PROJECT_KBS`) are each one environment
  value, at most 5000 characters, and a runtime may have at most 50 environment variables. The stack checks both
  when it is built and refuses an installation that would not fit. Each project is a nested stack of its own, so
  CloudFormation's 500 resources and 200 outputs per stack allow the full 60 projects; an installation still in the
  flat layout holds about 20 (see [Stack layout and limits](#stack-layout-and-limits)).

### Inactive memories

A long-term record can be marked inactive: wrong, stale or no longer wanted. No agent considers it after that. It
is not deleted, and reactivating it brings it back as it was.

```sh
tracectl remote memory list OWNER/REPO [--all]          # --all also lists inactive records, with why, who and when
tracectl remote memory deactivate OWNER/REPO RECORD_ID --reason "the rail is 3V3, not 5V"
tracectl remote memory reactivate OWNER/REPO RECORD_ID
```

These are the API actions `memory.deactivate { repo, recordId, reason }`, `memory.reactivate { repo, recordId }` and
`memory.list { repo, includeInactive }`. Each record that `memory.list` returns has `active`, and an inactive one
also has `inactive: { reason, by, by_you, at }`, where `by` is the person's hash, not their email. On a local
installation that has no API, `tracectl memory list|deactivate|reactivate` does the same with your own AWS credentials
(`TRACE_MEMORY_ID`, with the project taken from `--repo` or the clone's origin).

- **What "not considered" covers:** the recall at the start of a job and the memory block in its prompt (the
  person's own preferences too), the `memory_recall` tool, and the API's `memory.recall` and `memory.list`. Records
  are filtered after they are retrieved. Recall asks AgentCore for as many extra records as there are inactive ones
  under the namespace, up to the API's limit of 100, so the agent still gets its full `topK`. The prompt block drops
  any record that carries a mark, as a second check. Each span records how many records were left out
  (`trace.memory.inactive_filtered`), never which ones. If the marks cannot be read, nothing is handed out unchecked:
  the read fails and a job runs without long-term memory.
- **Who may mark:** anyone with write access on the project (users assigned to it, and admins). Guests cannot mark
  the project's records. The one exception is a person's own preferences (the preference records of their person
  actor `<owner>/<repo>/person/<hash>`): they are shown only to that person, who may turn them off or on with read
  access alone, guests included. Other records of their person actor (facts, session summaries) need write access. Nobody but an admin can mark another person's
  records, because nobody else can see them. Agents cannot mark anything. No tool offers it, and each project's
  worker and GitHub OIDC role is denied writes under its `memory-state` prefix, although it can read it.
- **Checks:** the project access check runs first, before any AWS call. Then the record is looked up in that
  project's own memory, under `/trace/<owner>/<repo>/` (`GetMemoryRecord`, falling back to a listing of the
  project's records). A record id from another project, or one the person cannot see, gets the same 403 "no access".
- **Short-term events are not marked.** AgentCore has no way to update an event. Events are only ever given back
  when a job continues the same session, and they expire after `eventExpiryDays`. Deactivate the long-term record
  that was extracted from them instead. One limit follows from this: a later extraction or consolidation can write a
  new record, with a new id, that says the same thing. That record is active until someone marks it too.
- **Where the marks are:** a small SQLite database per project, beside its data:
  `s3://<bucket>/projects/<owner>/<repo>/memory-state/central.db` (locally
  `$TRACE_HOME/projects/<owner>/<repo>/memory-state`). It is written the same way as the central store, with
  conditional puts that are retried on a conflict. Its tables are `inactive_records` (record id, namespace, reason,
  the hash of who marked it, when) and the append-only audit log `memory_state_log`. The API role may read
  `projects/*/memory-state/*` and write it only with conditional puts. It has nothing else under `projects/` and
  cannot delete there.
- **Why marks live beside the memory, not inside it:** AgentCore records can carry metadata, and
  `RetrieveMemoryRecords` and `ListMemoryRecords` can filter on it. That would need several things this design
  avoids. It needs an indexed key declared on every memory (at most 10 per memory, never removable, not backfilled).
  It needs `BatchUpdateMemoryRecords`, which can also rewrite a record's content and namespaces, granted to the API,
  where today nothing writes records except extraction. The docs leave open whether an update merges or replaces
  metadata, and how a key is removed again, which reactivating would need. Filters have no not-equal, so records that
  never had the key would need `NOT_EXISTS`. And the docs do not say whether batch-written metadata survives
  consolidation. The overlay never changes a record, so reactivating restores it exactly, and it keeps who, why and
  when in an audit log.

**Upgrading from the installation-wide memory.** Earlier versions had one memory for every project
(`<prefix>_memory`, output `MemoryId`). The next deploy removes it, and every project starts with its own, empty
memory. Records are not migrated: AgentCore has no API that copies extracted long-term records from one memory to
another.

- With `retainData` true, the old memory is kept as an orphan with its records. The old template gave it no
  DeletionPolicy, so taking it out in one step would delete it. The installer therefore keeps it in the stack for one
  more deploy: it sees the old `MemoryId` output and sets `memory.legacySharedMemory`. On that deploy the memory is
  unused, no role can reach it, and it is marked Retain (output `LegacyMemoryId`). The installer run after that
  leaves it out, and CloudFormation leaves it in the account. Read it with your own credentials, and delete it with
  the AgentCore console or `aws bedrock-agentcore-control delete-memory` when you no longer need it. If you deploy by
  hand, set `memory.legacySharedMemory: true` for the first deploy. The old memory's log group and log delivery are
  deleted on the first deploy either way, because the old template marked them Delete.
- With `retainData` false, the old memory and its records are deleted on the next deploy.

The installer's plan says which of the two will happen when it finds an existing installation.

## Managing prompts

Every piece of text trace sends a model is in one catalog (`src/prompts/catalog.ts`), each under a stable id with
its default, the variables it may use and whether people may change it. The composers build each prompt from those
entries only: code supplies data (names, numbers, lists, fenced text) as variable values, and every sentence comes
from the catalog. Tests hold this: each composed prompt is exactly its parts joined, every part is a catalog id, the
phrases that mark each kind of prompt appear in no other source file, and the two places that call the model take
their prompt from a composer. Tool descriptions, which the MCP server gives the model as tool metadata, are not in
the catalog.

```sh
tracectl prompts list                                   # every id: editable or locked, and where its text comes from
tracectl prompts get specialist.verify.workflow         # the default, each layer's text, the effective text and the locked parts after it
tracectl prompts set specialist.verify.workflow --reason "our order" --file workflow.txt   # or the text on stdin
tracectl prompts history specialist.verify.workflow
tracectl prompts diff specialist.verify.workflow v1 v2  # or: default, effective
tracectl prompts revert specialist.verify.workflow 1    # a version, or a history uid
tracectl prompts reset specialist.verify.workflow       # back to the layer below
tracectl prompts preview verify --marked                # the whole prompt as the model gets it, each part headed by its id
tracectl remote prompts … [--repo OWNER/REPO | --installation]   # the same through the API
```

### The catalog

| Ids | Editable or locked | What |
| --- | --- | --- |
| `specialist.<kind>.role`, `.workflow`, `.done`, `.escalate` | editable | who each specialist is, its workflow (and what it typically delegates), what counts as done, when it stops and asks |
| `specialist.route`, `specialist.report` | editable | why the job was routed there; the final report's content and tone |
| `specialist.knowledge` / `specialist.knowledge.data` | editable / locked | search the project's [knowledge base](#knowledge-base) before asking a person, and cite passages by path / its passages are data, read only, and the checkout wins where they differ |
| `specialist.unattended`, `.rules`, `.rules.none`, `.instructions`, `.job.*`, `.tools`, `.delivery.delegate`, `.delivery.actions`, `.evidence`, `.escalate`, `.guardrails` | locked | that nobody is watching; the rules and the `agents.<kind>.instructions` setting, fenced; the job with its thread and request as data; the tool list (the allowlist, which no prompt changes); the delegation contract (depth 1) and the GitHub Actions structured output; that every figure is measured; the `ESCALATE:` line the harness looks for; the guardrails, always last |
| `worker.role`, `worker.tools`, `worker.task`, `worker.item.ci-red`, `.conflict`, `.agent-fix`, `worker.validate.command`, `.generic`, `worker.report.issue`, `.none`, `worker.escalate.item`, `worker.finish.item` | editable | the worker: who it is, its tools, how it does a task or an item, how it validates, escalates and reports |
| `worker.knowledge` | editable | the worker's use of the knowledge base (`kb_search`, and `kb_sync` for repairs only) |
| `worker.data.task`, `.data.item`, `worker.request`, `worker.item`, `.item.not-own`, `worker.tests`, `worker.delegated`, `worker.guardrails` | locked | text is data; the request in the asker's words; the item; never weaken a test; a delegation's request; the guardrails, last |
| `delegate.brief` / `delegate.request` | editable / locked | the wording around a specialist's brief / the brief and the acceptance criteria |
| `actions.check` | locked | GitHub Actions' check run and the structured answer the workflow parses |
| `router.classify` / `router.contract`, `router.evidence.none` | editable / locked | the routing model's instruction / its JSON contract (`{ kind, reason, confidence }`) and the job, fenced as data |
| `memory.block`, `memory.legacy`, `memory.more` | locked | the memory block: data, not instructions |
| `system.append`, `system.notes` | locked | what the runtime adds to Claude Code's system prompt: never print the token; the default branch's `CLAUDE.md`, fenced |
| `render.instructions` / `render.request`, `render.projects.all` | editable / locked | the rendering agent |
| `cloudworker.prompt` / `cloudworker.guardrails`, `cloudworker.none` | editable / locked | the hourly cloud worker (`tracectl worker-prompt`), which spans projects, so only installation overrides apply to it |
| `fence.cut`, `mention.to`, `mention.starting` | locked | small fragments other parts use |

Each editable entry names the locked entries that come after it (`then`, shown by `prompts.get`), and every prompt
with guardrails ends with them. So an override changes what it replaces and nothing else: the locked parts are
always there, after it, and an override can't remove them or have the last word. An override is text a person wrote;
it goes to the model as it is, and the rules, data and memory fences stay around everything else. A prompt can't
change a specialist's tools, model or turn limits: those are settings (`agents.<kind>.*`), applied by the job runner
and the MCP server, not by any text.

### Templates

A template has one feature: `{{name}}` is replaced by that variable's value. There are no expressions, filters,
loops or conditionals, so nothing runs. Each entry declares its variables, typed (`text`, `number`, `list`, one item
per line), and `tracectl prompts get` lists them. A template that uses an unknown variable, or a malformed placeholder,
is refused with the variable's name, when it is saved and again when it is rendered. Values are substituted once and
never read as a template, so a request, a rules file or a title that contains `{{…}}` stays text. A variable an
override leaves out is simply not used: what must reach the model (the request, the rules, the item) is in locked
entries. An override is at most 16,000 characters.

### Layers

| Layer | Who changes it | Where it is |
| --- | --- | --- |
| code default | trace's own releases | the catalog |
| installation | admins | `s3://<bucket>/prompts` (locally `$TRACE_HOME/prompts`, or `$TRACE_PROMPTS_HOME`): a SQLite database written the way the central store is, with conditional puts re-run on a conflict. The API role reads it and writes it only conditionally; each project's worker role and GitHub OIDC role may only read it |
| project | people with write access on the project, and admins | the project's `.trace/project.db`, tables `prompts` and `prompt_history`, versioned in git with the repository |

The most specific layer that has an override wins, per id. Jobs read the project's overrides from the default
branch, never from a pull request's tree, the same way they read the settings. A project change through the API is a
commit of `.trace/project.db` on a branch of its own (`trace/prompts-<slug>-<ts>`), never the default branch, and
`.trace/**` is a protected path, so its pull request waits for a person, as `settings.set` does. Locally,
`tracectl prompts set` writes the clone's database and you commit it. `--installation` writes the installation's store
with your own credentials.

Every change (set, reset, revert) is a row in `prompt_history`: the id, the version it made, the text, who (a
person's 16-character hash through the API, the login locally), when and why. A reset is recorded as an override
with no text, so it merges like any change. `tracectl db merge` keeps, per id, the row changed last, and the union of
both histories; two branches can each make a v3 of one id, and their history keeps both, told apart by `uid`.

An override that can't be used is reported, never used: one of an id the catalog no longer has, one of a locked id,
or one that no longer validates (a variable its entry dropped). `prompts.list` and `tracectl prompts list` list them,
the job's log names each one it skipped, and the layer below decides. A layer that can't be read (a step without
`TRACE_HOME`, credentials that can't read `prompts/*`) is left out, and the log says so.

### Provenance

Each job records what its prompts were made of: every part's id, layer, version and the sha256 of its template (12
characters), on the job's record (`job` through the API, `status` on the runtime: `prompts`) and on its span
(`trace.prompt.ids`, `trace.prompt.layers`, `trace.prompt.versions`, `trace.prompt.overridden`). In GitHub Actions the
`worker-prompt` and `worker-delegate` steps log it and output it (`prompts`: `id@layer:version`). The text of a
prompt is never recorded, as with every other prompt and tool argument (see [Observability](#observability)).

### Through the API

| Action | Needs | Does |
| --- | --- | --- |
| `prompts.list { repo? }` | any class (guests too); with `repo`, read on it | every id, editable or locked, and its effective layer and version; the overrides that are not used |
| `prompts.get { id, repo? }` | the same | its default, installation and project text, the effective text and the locked parts that follow it, marked |
| `prompts.preview { repo, target, job? }` | read | a whole prompt (a specialist kind, a prompt's name such as `worker.task` or `router`, or an id) with the overrides, as text and marked; `job` stands for a task (`{ kind: 'task', request }`) or an item |
| `prompts.set { id, text, reason, scope, repo? }` | admin (installation), write (project) | an override, checked (the error names a bad variable) |
| `prompts.reset { id, scope, repo?, reason? }` | the same | back to the layer below |
| `prompts.revert { id, scope, version, repo?, reason? }` | the same | back to an earlier version (a number or a history uid) |
| `prompts.history { id, scope, repo? }` | a user or an admin (installation), write (project) | every change to the id in that layer |
| `prompts.chat {}` | any class | the installation's text of the chat agent's editable entries (`chat.role`), or null for the default: what the web app's backend applies to Ask trace |

The access check comes first, as for every action: a project you are not assigned to and one that does not exist
get the same "no access". The setting `agents.<kind>.instructions` stays as a lightweight addendum after the rules;
overrides are the full mechanism.

**Upgrading.** Workflows written by an earlier `tracectl onboard` do not pass `TRACE_HOME` to the `worker-prompt` and
`worker-delegate` steps, so in GitHub Actions only the project's overrides apply until the workflow is updated
(`templates/workflows/trace-worker.yml`). The runtime reads both layers either way.

## Knowledge base

Each project has an [Amazon Bedrock knowledge base](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)
over its own documents, so an agent can find what the project's docs, rules, design notes, schematics and datasheets
say before it asks a person (`src/infra/knowledge.ts`, `src/tools/kb`). **It exists only in the nested layout**: a flat
installation has no room for its five resources per project (see [Stack layout and limits](#stack-layout-and-limits)),
and the installer's plan says so.

| Per project (its nested stack) | |
| --- | --- |
| `AWS::S3Vectors::Index` | Its vectors, in the installation's one S3 vector bucket (the parent's). float32, cosine, the model's dimensions; `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` non-filterable, as S3 Vectors needs for Bedrock's chunk text. Named by CloudFormation, so a retained index never blocks a new one. |
| `AWS::IAM::Role` and its policy | `<prefix>-kb-<hash>-<region>`, trusted by `bedrock.amazonaws.com` from this account's knowledge bases only. It lists and reads `projects/<owner>/<repo>/kb/*` of the central bucket, uses its own index (`PutVectors`, `GetVectors`, `DeleteVectors`, `QueryVectors`, `GetIndex`), and invokes the embedding model. Nothing else. |
| `AWS::Bedrock::KnowledgeBase` | `<prefix>-kb-<hash>` (`-g<n>` at a [generation](#agent-memory) above 0), type `VECTOR`, storage `S3_VECTORS`. |
| `AWS::Bedrock::DataSource` | `trace-repository`: S3, inclusion prefix `projects/<owner>/<repo>/kb/`, the project's chunking. |

The worker runtime is told `TRACE_KB_ID` and `TRACE_KB_DATA_SOURCE_ID`, and the repository gets the same as Actions
variables. Both are outputs of the project's nested stack only. With `retainData` (the default) the index, the knowledge
base and the data source (whose own `DataDeletionPolicy` is then `RETAIN`) stay in the account when the project or the
stack is removed, like its memory; the documents themselves are in the central bucket, which is kept too.

Stack settings (`knowledgeBase` in `TRACE_INFRA`, and the installer's "Knowledge bases" checkbox):

| Key | Default | |
| --- | --- | --- |
| `knowledgeBase.enabled` | `true` | every project's knowledge base |
| `knowledgeBase.embeddingModel` | `amazon.titan-embed-text-v2:0` | any Bedrock embedding model id in the region |
| `knowledgeBase.dimensions` | `1024` | Titan Text Embeddings V2 makes 256, 512 or 1,024; the stack refuses any other |
| `knowledgeBase.chunking.strategy` | `fixed` | `fixed` (`maxTokens` 300, `overlapPercentage` 20), `semantic` (`maxTokens`, `bufferSize` 0, `breakpointPercentileThreshold` 95) or `hierarchical` (`parentMaxTokens` 1500 over `maxTokens`, `overlapTokens` 60) |
| `projectSettings.<OWNER/REPO>.knowledgeBase` | | the same keys for one project, over the installation's (`{ "enabled": false }` turns one off) |

Changing the model or the dimensions replaces the index and the knowledge base (a new id, which the next installer
run writes into the repository's variables); changing the chunking replaces the data source. The next sync then
ingests everything again. Hierarchical chunking keeps the parent chunk's text as S3 Vectors metadata, so parents of
thousands of tokens can exceed its per-vector metadata limit; the AWS documentation does not recommend hierarchical
chunking with S3 Vectors.

**What is indexed** (`src/tools/kb/content.ts`, settings `knowledge.*` in the project database):

| From | Into `projects/<owner>/<repo>/kb/` | `source`, `kind` |
| --- | --- | --- |
| Repository files matching `knowledge.include` and not `knowledge.exclude` (what `git ls-files` lists). By default: markdown, `.rst`, `.adoc`, `.txt`, HTML under `docs/`, `CLAUDE.md` and `.trace/rules.md`, without `node_modules`, build output, licences and changelogs. Firmware sources only when a glob names them (`tracectl config set knowledge.include '[…, "firmware/**/*.c"]'`). | `repo/<path>`, with `.txt` appended to anything that is not `.md`, `.txt`, `.html` or `.csv` (Bedrock reads those as text) | `repo`; `markdown`, `doc`, `rules`, `claude` or `source` |
| Each KiCad project (`electronics.projects`, else every `.kicad_pro`): its title block, sheets, BOM (quantity, references, value, footprint, MPN, manufacturer, LCSC, description), parts left out, power nets, net labels and the board's nets, written by the KiCad readers trace already has. Raw KiCad files are never uploaded. `knowledge.kicad` | `summary/<path of the .kicad_pro>.md` | `summary`, `kicad` |
| The current datasheet, in the shared library, of every MPN in those BOMs: one object per page of its text, at most `knowledge.max_datasheet_pages`. `knowledge.datasheets` | `datasheets/<part>/<first 16 of its sha256>/p<page>.txt` | `datasheet`, `datasheet` |

Files larger than `knowledge.max_file_kb` (512), empty files, binaries, PDFs, images and the project database are
left out, and the sync lists what it skipped. Every object has its `<key>.metadata.json` sidecar beside it, the form
Bedrock requires for metadata (at most 10 KB): `source`, `kind`, `path`, `commit` (the commit its content was first
synced from), `dir1`…`dir6` (the first 16 hex digits of the sha256 of each enclosing folder), and for a datasheet page
`part`, `mpn`, `sha256` and `page`. `path` and `part` are embedded with each chunk; the rest is for filtering and
citing.

**How sync works** (`src/tools/kb/sync.ts`). `tracectl kb sync` collects the above from the checkout, then:

1. lists the prefix (ListObjectsV2) and compares each object's content hash: a document's is the sha256 of its bytes,
   kept in the object's metadata (`x-amz-meta-trace-sha256`); a sidecar's covers its document and attributes but not
   the commit, so an unchanged document is not uploaded again on every push. The project database's `kb_objects`
   table (`s3_key`, `path`, `hash`, `etag`, `uploaded_at`; `tracectl db merge` keeps the newer row per key) saves the
   HeadObject calls when its row and the listed ETag agree; without rows (a fresh checkout) HeadObject decides;
2. uploads what changed, deletes what is no longer wanted (DeleteObjects);
3. starts an ingestion job (StartIngestionJob) when anything changed, when the data source has never been ingested,
   when its last job failed or was stopped or began before the newest upload `kb_objects` records, or with `--force`. One job runs at a time per data source, so a running one is waited for first. It then polls
   GetIngestionJob until the job is complete, failed or stopped, or `--wait` minutes (15) pass, and reports the job's
   statistics (scanned, indexed, deleted, failed) and failure reasons. A job that outlives the wait carries on;
   `tracectl kb status` shows it.

The sync refuses a checkout that is not the default branch (`--allow-branch` overrides it): the knowledge base holds
the default branch. It runs:

- **on every push to the default branch**, as the `kb-sync` job of `trace-worker.yml`, with the repository's own GitHub
  OIDC role (`TRACE_AWS_ROLE`, `TRACE_KB_ID`, `TRACE_KB_DATA_SOURCE_ID`, `TRACE_HOME`), whatever `worker.runner` says.
  Repositories onboarded before this need `tracectl onboard --refresh` to get the job;
- **by hand**: `tracectl kb sync [--force] [--dry-run] [--wait MINUTES]` in a clone, with your own credentials and those
  variables, or `tracectl remote kb sync OWNER/REPO` (write access), which runs the `kb.sync` tool on the project's own
  worker runtime, on its clone of the default branch;
- **from the worker**: the `kb.sync` tool, for repairs. No specialist has it.

**Using it.** The MCP tools are `kb.search { query, top_k, filter: { source?, kind?, path_prefix? } }` (Retrieve
through `bedrock-agent-runtime`; each hit has its text, score, path, commit and a citation: `path@commit`, or the part,
sha256 and page of a datasheet), `kb.status` (the newest ingestion job and how many documents are in S3) and `kb.sync`.
They are offered only when `TRACE_KB_ID` is set. Every specialist has `kb.search` and `kb.status`, read only; nothing
an agent is given can mark or change the knowledge base, apart from the worker's `kb.sync` of the default branch.
S3 Vectors has no `startsWith` filter, so `path_prefix` is a folder in whole segments (`docs/power`) or one file's exact
path: an equals on that folder's `dir<n>` hash, or on `path`; folders deeper than six levels are filtered on their
first six and narrowed afterwards. From the command line: `tracectl kb search "query" [--source S] [--kind K] [--path P]`
and `tracectl kb status` locally, `tracectl remote kb search OWNER/REPO "query"` through the API (read access). The API's
`kb.search` runs Retrieve itself, on the knowledge base of the project asked for (from `TRACE_PROJECT_KBS`), after the
access check; a project without a knowledge base in the installation gets the same 403 as one you are not assigned to.

AgentCore Gateway can expose a knowledge base to agents as MCP tools, but its knowledge base connector supports only
Bedrock's *managed* knowledge bases, not a vector knowledge base like these (one on S3 Vectors). trace's own MCP server
offers the tools instead, and the agents already reach it.

**Cost.** The vector store is S3 Vectors, which has no running cost when idle, where an OpenSearch Serverless
collection per project would cost hundreds of dollars a month each. At the US East (N. Virginia) prices on the S3
pricing page: storage $0.06 per GB-month (a 1,024-dimension float32 vector is 4 KB, plus its chunk text and metadata),
PUT $0.20 per GB written, queries $2.50 per million plus $0.004 per TB processed for an index under 100,000 vectors.
A project of 10,000 chunks is about 60 MB: under a cent a month to store, and about a cent to write in full. Each sync
embeds only the documents that changed, with the embedding model's per-token price (Titan Text Embeddings V2 on
the Bedrock pricing page; at about 300 tokens a chunk, a full re-embedding of 10,000 chunks is 3 million tokens), and
each search embeds its query. The Bedrock pricing page lists per-call retrieval fees for its managed knowledge bases,
not for a vector knowledge base you run yourself. The documents are ordinary S3 objects in the central bucket, whose
old versions expire after 90 days.

**Limits.** Bedrock reads at most 50 MB per file (trace stops at `knowledge.max_file_kb`); a metadata file is at most
10 KB; S3 Vectors keeps at most 2 KB of filterable metadata, and Bedrock about 1 KB and 35 keys of custom metadata,
per vector (trace writes at most 15 keys, each string cut at 300 characters); S3 Vectors does semantic search only,
not hybrid; one ingestion job runs at a time per data source.

## Observability

Every AgentCore runtime starts Node with the AWS Distro for OpenTelemetry (ADOT) auto-instrumentation
(`node --require …/aws-distro-opentelemetry-node-autoinstrumentation/…/register.js`, in `agent/Dockerfile`). AgentCore
Runtime supplies its OpenTelemetry settings: the service name, the runtime's log group, and the headers that send
metrics to the `bedrock-agentcore` namespace. Spans go to X-Ray, which stores them in CloudWatch Logs (Transaction
Search). Metrics go to CloudWatch as EMF. The code records through the OpenTelemetry API only (`src/core/telemetry.ts`),
so with no SDK loaded (the CLI, local runs, tests) nothing is recorded and nothing changes.

| Span | Where | What it carries |
| --- | --- | --- |
| `invoke_agent trace-worker` / `trace-api` | each `POST /invocations` | the invocation kind or API action, the repository, the outcome; it continues the caller's trace (`traceparent`, `X-Amzn-Trace-Id`, or the payload's `trace` when the request carries no context of that trace) and puts the AgentCore session id into baggage `session.id`, so every span below has it |
| `trace.job <kind>` | each job | job id, kind, repository, agent (the specialist, or `worker` for a delegation, with its parent job id), the route (`trace.agent.kind`, `trace.route.reason`, `trace.route.confidence`, `trace.route.source`), the prompt parts its model calls were built from (`trace.prompt.ids`, `trace.prompt.layers`, `trace.prompt.versions`, in step, and `trace.prompt.overridden`; never the text), the item, who asked (a hash), the outcome |
| `claude.query` | each Agent SDK run | model, Claude's session id, turns, tokens (input, output, cache read and creation), the SDK's cost estimate |
| `chat <model>` | each model response | model, response id, finish reason, the tools it asked for |
| `execute_tool <name>` | each tool Claude used, and each call through the tool registry (the MCP server continues the job's trace) | tool name, where the call came from, the hardware flag, argument names and sizes, result size, duration, outcome |
| `trace.kb.sync`, `trace.kb.search` | each knowledge base sync and search (src/tools/kb) | documents, objects, uploaded, unchanged, deleted, HeadObject calls, the ingestion job's status and its indexed and failed counts; the query's length, `top_k`, the filter's keys and the result count. Never paths, document text or the query |
| `trace.gpu_job <kind>`, `trace.gpu.run <kind>` | each GPU job, and its runner inside AWS Batch (continued from `TRACEPARENT`) | kind, backend, job ids, seconds, exit code |

**One trace from the workflow down.** The workflow's dispatch step (`worker-dispatch`, which has no OpenTelemetry SDK)
makes a W3C trace context itself: a child of any `TRACEPARENT` the workflow set, else a new trace whose id starts with
the time, so it is a valid X-Ray id too. `invoke` (`src/agents/runtime/dispatch.ts`; the API's calls to the workers
too, from their active span) sends it as InvokeAgentRuntime's `traceParent`, `traceState`, `baggage` and `traceId`
(`X-Amzn-Trace-Id`) parameters, and in the payload (`trace`). AgentCore's documentation lists those headers but
does not say they reach the container, so the runtime continues from the payload unless the request already carries
that same trace (`invocationHeaders` in `src/agents/runtime/observe.ts`). The dispatch comment on the item names the
trace id, so workflow → agent → tools → GPU jobs is one trace to search for.

Metrics: `trace.invocations`, `trace.jobs` and `trace.job.duration`, `trace.tool.calls`, `trace.tool.errors` and
`trace.tool.duration`, `gen_ai.client.token.usage` (by token type and model), `trace.claude.cost`, and
`trace.gpu.jobs` and `trace.gpu.duration`. Their dimensions are kinds, agents, tool names and outcomes, never ids.

Per project, each project's own worker also records `trace.project.jobs`, `trace.project.job.duration`,
`trace.project.tool.calls`, `trace.project.tool.duration`, `trace.project.claude.cost`, `trace.project.gpu.jobs` and
`trace.project.gpu.duration`, with two dimensions only: `trace.project` (`project-<8 hex>`, the project's hash, never
its name) and the outcome. The aggregate series above are unchanged; these are separate names, so nothing is counted
twice. The agents' dashboard draws them per project, and Operations names each series' project for the people on it:
contributors and reviewers see their projects' jobs and tool calls; cost is for admins.

What they cost: each combination of dimension values is one CloudWatch custom metric, $0.30 a month (first 10,000;
prorated by the hour, and only for metrics that receive data that month). A project adds at most 15: jobs and job time
by three outcomes (6), tool calls and tool time by two (4), Claude cost (1), remote jobs and their time by two (4). So
at most $4.50 a month for a busy project, and $270 a month at the most projects an installation allows (60), all of
them active every month; typically a few dollars. Metrics arrive as CloudWatch Logs (EMF), so the ingestion is a few
bytes per job and tool call. Reading them is the larger cost at scale: GetMetricData is $0.01 per 1,000 metrics, and
the six per-project widgets return up to 60 x 3 series each, so one Operations refresh at 60 busy projects reads about
1,000 more metrics (1 cent); the page refreshes every 60 seconds while it is visible, slower when it is not.

What is never recorded: prompts, tool arguments and results, file contents, tokens or keys, and email addresses. A
person is a 16-character sha256 of their email, the same hash the agents' memory uses. Every attribute also passes a
guard that truncates it and replaces anything shaped like a credential.

The stack (settings `observability.*`, chosen in the installer's Agents step) adds the following:

- **CloudWatch Transaction Search**, turned on by a custom resource if it is off. It is account-wide. An account that
  already has it is left alone, and deleting the stack never turns it off. `observability.samplingPercent` sets X-Ray's
  trace-indexing rule. When it is unset, the account's own setting is kept (1% unless someone changed it). Every span
  is stored either way.
- The runtime roles' telemetry permissions, which match the AgentCore execution role. Each role can also put the
  resource policy on its own log group.
- Each project memory's `APPLICATION_LOGS`, delivered to its own log group
  (`/aws/vendedlogs/bedrock-agentcore/memory/APPLICATION_LOGS/<memory id>`), and its `TRACES`, delivered to X-Ray.
  The delivery sources and destinations are `<prefix>-m-<hash>-logs` and `<prefix>-m-<hash>-traces`. They follow
  `retainData` like the memory does.
- X-Ray's OTLP endpoint in the GPU job definition.
- The `<prefix>-agents` dashboard: invocations, latency, errors, jobs, tokens, cost, tool calls and GPU jobs. A last row
  shows memory operations, latency and errors across every project's memory with one SEARCH, which matches each
  memory by the project hash in its name.

The stack outputs `DashboardUrl`, `GenAiObservabilityUrl`, `Project<hash>LogGroup` (one per project's worker),
`ApiLogGroup`, `SpansLogGroup` and `Project<hash>MemoryLogGroup` (one per project's memory). When `observability.enabled` is false, the runtimes get `DISABLE_ADOT_OBSERVABILITY=true` and
`OTEL_SDK_DISABLED=true`, and nothing else is created.

**In CloudWatch GenAI Observability** (CloudWatch → GenAI Observability → Bedrock AgentCore), the runtimes (one per
project, and the API) appear as agents with their sessions, traces, latency, errors and token use. A session is one AgentCore runtime session. For
the worker, that is one work item at one head (`trace-<owner>-<repo>-<number>-<sha12>`, from `src/agents/runtime/dispatch.ts`).
Its trace runs from the invocation through the job and Claude's turns down to each tool call, MCP tools included, and
any GPU job.

**To see one session's trace:** open the project's worker agent (`<prefix>_w_<hash>`) in GenAI Observability, choose **Sessions**, and pick the
session id. Alternatively, in CloudWatch → Transaction Search, filter spans on `session.id` (or on `trace.job.id`, the
job id the agent puts in its comment on the issue or PR), then open the trace.

**Locally, or with another OTLP backend:** load the same register module and point the standard OTLP variables at any
OTLP/HTTP collector on port 4318 (the OpenTelemetry Collector, Jaeger, Grafana Tempo):

```sh
OTEL_SERVICE_NAME=trace-local OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_NODE_RESOURCE_DETECTORS=env \
  node --require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register dist/cli.js tool calc.divider vin=12 vout=3.3
```

This sends the tool call's span and its metrics over OTLP. Keep `OTEL_NODE_RESOURCE_DETECTORS=env`: ADOT's default
detectors would record the process's command line, arguments included, as a resource attribute. Leave
`AGENT_OBSERVABILITY_ENABLED` unset there, because it switches ADOT to the AWS endpoints. To run the agent image
outside AgentCore, either set `OTEL_SDK_DISABLED=true` or give it the variables above. Setting
`DISABLE_ADOT_OBSERVABILITY=true` on a runtime turns off AgentCore's defaults, so you can send its telemetry elsewhere.

## Layout

| Path | What |
| --- | --- |
| `src/core` | Settings, SQLite stores, the tool registry, the MCP server, onboarding, access control, the Python bridge client; the journey record and what agents write beside it (`journey.ts`, `agent-facts.ts`, `handoffs.ts`, `job-index.ts`), the guided skills (`skills.ts`), and the cost ledger and price table (`cost.ts`, `prices.ts`) |
| `src/infra` | The CDK stack (Cognito, the central bucket, the image builds, the API runtime, the AWS Batch GPU queue in `gpu.ts`) and, per project, `project.ts` (its worker runtime, roles, token secret and GPU job definition); beside them the web app (`web.ts`, its WAF in `edge.ts`), external access (`external.ts`), the tools functions (`tools.ts`), the build runners (`runner.ts`), the cost read and the order watch (`cost.ts`, `order-watch.ts`), dictation's vocabularies (`voice.ts`) and where trace publishes its images (`release.ts`) |
| `src/installer` | `tracectl install`: the local web installer; `tracectl update-installation` (`update.ts`): the self-update job of trace's own ci workflow |
| `src/prompts` | The prompt catalog (every prompt part's id, default, variables and whether it is locked), the `{{var}}` templates, the layers (installation and project overrides) and their stores, and `tracectl prompts` |
| `src/agents` | The specialists (`verify`, `impl`, `ams`, `emc`, `render`, `thermal`, each in its own folder; `index.ts` lists them), the router, the retained worker's prompt (`worker`), and the runtime (`runtime`: server, jobs, delegation, hand-offs, memory, observability) |
| `src/api`, `src/mcp-remote`, `agent/Dockerfile` | The people-facing API; the external API and the MCP endpoint for connected systems (`service-auth.ts`, `service-policy.ts`, `src/mcp-remote`; [docs/external-access.md](docs/external-access.md)); and the image AgentCore runs |
| `src/web`, `web` | The web app: its backend behind CloudFront (sign-in, `/api/call`, the chat agent at `/api/agui`, voice, Operations, live events) and the React app ([docs/web-build.md](docs/web-build.md), `web/README.md`) |
| `src/login` | `tracectl login`, `tracectl remote …`, `tracectl users …` |
| `src/harness` | The loop's logic, bundled into `harness/dist` for the GitHub actions in `harness/actions` |
| `src/infra/gateway.ts`, `src/core/gateway.ts`, `src/library` | The library gateway: its CDK resources, which calls `tracectl mcp` forwards and how (SigV4, fallback), and the Lambda behind it |
| `src/infra/knowledge.ts`, `src/tools/kb` | Each project's knowledge base: its CDK resources, and what goes in it, the sync, search and the kb tools |
| `src/tools/mech`, `python/tracebridge/mech` | Enclosures: board facts, case settings, JLC3DP's capabilities and the mech tools; the build123d engine they run, as a `cad-script` job (the case script, on the cad function) and a `cad` job (the checks, on the tools function) |
| `src/tools` | The other tools, one folder per area, gathered into one registry by `index.ts`: `calc`, `kicad`, `sim`, `ams`, `emc`, `protocol`, `verify`, `fpga`, `pcb` (the autorouter) and `layout` (the `pcb.*` checks), `render`, `thermal`, `firmware`, `hil`, `datasheets`, `parts`, `design`, `journey`, `agent`, `memory`, `voice`, `runs` |
| `src/gpu`, `agent/Dockerfile.gpu`, `agent/Dockerfile.tools` | GPU and CPU jobs: local, on the project's tools function or on AWS Batch (`runJob`, `runBatch`), the in-container runner, and the two images they run |
| `python/kicad`, `python/orthoroute`, `python/blender`, `python/emc` | Scripts trace runs inside other programs: the autorouters (Freerouting through KiCad's pcbnew, and OrthoRoute's headless mode), the Blender renders, and the openEMS model and scikit-rf checks |
| `python/tracebridge` | The Python bridge, used where Node has no maintained equivalent: PDF tables and figures (pdfplumber), VISA instruments (pyvisa), CAN vendor interfaces (python-can), and the bench emulator's serial console (`ptyrelay.py`, standard library only) |
| `templates` | What onboarding writes: workflows, starter builds, scaffolds, the empty rules |

Develop with `npm ci && npm run check`. The Python bridge has its own setup: `pip install -e 'python[dev]' && pytest python/tests`.
