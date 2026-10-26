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
  logs). They are reachable from the `trace` CLI and, for Claude Code, from the `trace` MCP server.

## Installing

```sh
npm install -g github:mteichtahl/trace#v1      # the `trace` CLI (Node 22.13+)
trace install                                  # opens the installer in your browser
```

The installer is a page served from your own machine (127.0.0.1, with a one-time key in its address). It asks for
and checks the following:

- **GitHub:** the shared agent token, the repositories trace will run (or just [the sample project](#the-sample-project)), and optionally each project's own agent
  token (see [Project isolation](#project-isolation)).
- **AWS:** a profile (SSO works) or access keys, the region, and confirmation of the account. It checks that Bedrock
  AgentCore and an Anthropic model are available there.
- **Builds:** nothing, usually. The build runners reach GitHub through an AWS CodeConnections connection (see
  [Where builds run](#where-builds-run)). The installer reuses one already authorized in the account and region. If
  there is none, the stack creates one, and after the first deploy the installer shows you where to authorize it and
  waits. You can also name an existing connection.
- **Agents:** the model, session limits, and the central bucket.
- **People:** the first administrator, and for everyone else their class (admin, user, guest) and the projects they
  are assigned to.

It then shows the plan and runs it:

- **AWS (CDK):** one stack. It contains the central bucket, the agent image (built by CodeBuild on arm64, so no
  local Docker is needed), and AgentCore runtimes from that image: one worker runtime per project, each with its own
  execution role, GitHub OIDC role, GitHub token secret, memory, knowledge base, GPU and CPU job definitions and CodeBuild
  build runner, and the API runtime. Each
  project's resources are in a nested stack of their own (see [Stack layout](#stack-layout-and-limits)). A project's
  worker is invoked by that repository's workflows through IAM, and by the API. The API runtime is for people and is
  reached only with a Cognito sign-in. The stack also holds the Cognito user pool.
- **GitHub:** each repository's Actions variables (`TRACE_AWS_ROLE`, `TRACE_AGENT_RUNTIME_ARN`, `TRACE_MEMORY_ID`,
  `TRACE_KB_ID`, `TRACE_KB_DATA_SOURCE_ID` and `TRACE_CODEBUILD_PROJECT`, all its own project's, `TRACE_AWS_REGION`, `TRACE_HOME`) and its `TRACE_TOKEN` secret (its project's agent token,
  encrypted with the repository's key), plus the onboarding pull request.
- **The GPU image**, last: the deploy starts its build and does not wait for it (see [GPU jobs](#gpu-jobs-rendering-and-autorouting)),
  so the installer waits for it once everything else is set up, and starts it again if an earlier one failed. A failed
  GPU image leaves GPU and CPU jobs unavailable and everything else installed.
- **People:** Cognito invitations into each person's class group, and project assignments recorded in the central
  database.

### The sample project

On the GitHub step you can also choose **Install the sample project**. It is a small sensor board, from intent to
fabrication files, in a repository of its own (`<your login>/trace-sample` unless you name another). It is the quickest
way to see the whole system work before you bring your own design, and it is the only repository you need to choose.

- **Before the deploy,** the installer creates the repository if it does not exist and commits the sample's files
  (`templates/sample`) onto its default branch. An existing repository is used as it is: files are added or updated,
  nothing is deleted. Creating one needs a token that may create repositories (a fine-grained token with
  Administration read and write on your account, or the admin token); otherwise create it yourself, empty, and run the
  installer again.
- **From then on it is a project like any other:** its own runtime, roles, memory, knowledge base and build runner,
  and you can assign people to it. It is put under trace straight away, without the held onboarding pull request,
  and its project database starts with the sample's requirements, test plan, specifications and thermal data.
- **The tour,** last, opens one task per step of the journey (define, architect, capture, prove, layout, sign-off,
  release, bring-up), each labelled for the agent that takes it. Together they run every agent and every tool, every
  simulation included: circuit (ngspice), mixed-signal, logic, formal and coverage, FPGA synthesis and place and
  route, protocols, thermal (2.5D, CalculiX and CFD), electromagnetic (openEMS), autorouting (Freerouting and
  OrthoRoute), rendering (Blender), firmware, and hardware in the loop on an emulated bench
  (`trace hil emulate`). Tasks that need GPU or CPU jobs are left out when GPU jobs are off. The tour runs on AWS
  like any other work and costs what that work costs; untick **Start the tour** to install the sample without it.
  Running the installer again opens only the tasks that are missing.

`test/installer/sample-tour.test.ts` keeps the tour complete: a tool, agent or kind of remote job added without a
tour task fails it.

Tokens and keys stay in the installer's memory. They are written only to Secrets Manager and GitHub. Every step can
be run again safely, and running the installer again updates an existing installation. Adding or removing a
repository and running the installer again adds or removes that project's runtime, roles, secret and job
definition.

## Project isolation

Each project's agent runs Claude with Bash, so it can use its runtime's AWS credentials directly. The line between
projects is therefore drawn in IAM, not only in code (`src/infra/project.ts`):

| Isolated per project | How |
| --- | --- |
| **Worker runtime** | One AgentCore runtime per repository (`<prefix>_w_<hash>`, tagged `trace:project`), with its own execution role and `TRACE_PROJECT=owner/repo`. It refuses, with a 403 that is logged, any invocation or job for another repository. |
| **Memory** | One AgentCore Memory per repository (`<prefix>_m_<hash>`, tagged `trace:project`), its own event expiry, and its own log group and log delivery. The worker is told only its own (`TRACE_MEMORY_ID`) and its role may use only that memory's ARN. On it, the role may still create and list events only for actors `<owner>/<repo>/*`, and recall and list records only under `/trace/<owner>/<repo>/*` (the condition keys `bedrock-agentcore:actorId` and `bedrock-agentcore:namespace`), as defence in depth. The actor comes from `TRACE_PROJECT`, never from the request. The GitHub OIDC role has the same grants on the same memory, for the `worker.runner = actions` fallback (the repository variable `TRACE_MEMORY_ID`). |
| **S3** | Read and write `projects/<owner>/<repo>/*` and `jobs/<owner>/<repo>/*`, and list only those prefixes and `central/*`. Read, never write, `prompts/*` (the installation's prompt overrides, see [Managing prompts](#managing-prompts)). Nothing under `access/*`, and nothing of another project. |
| **GPU and CPU jobs** | Two AWS Batch job definitions per project (`<prefix>-gpu-<hash>`, and `<prefix>-cpu-<hash>` with the CPU queue), with one job role that reads and writes only that project's `jobs/<owner>/<repo>/*`. A project's role may submit only with its own definitions, only jobs tagged `trace:project=<owner>/<repo>`, and may stop only jobs carrying that tag. SubmitJob cannot override a definition's job role. |
| **Knowledge base** | One Amazon Bedrock knowledge base per repository (`<prefix>-kb-<hash>`, nested layout only), with its own service role (`<prefix>-kb-<hash>-<region>`) that reads only `projects/<owner>/<repo>/kb/*` and its own S3 Vectors index, and invokes only the embedding model. The worker role and the OIDC role may `bedrock:Retrieve` and start, get and list ingestion jobs on that knowledge base's ARN only. See [Knowledge base](#knowledge-base). |
| **Library gateway** | Off by default (`gateway.enabled`). When on, each worker role may `bedrock-agentcore:InvokeGateway` on the installation's one library gateway and nothing else of it; the gateway serves only the shared datasheets and parts tools. See [Library gateway](#library-gateway). |
| **GitHub OIDC role** | One per repository, trusted only for `repo:OWNER/REPO:ref:refs/heads/BRANCH`. It may invoke only that project's runtime, read and write only that project's prefix (and the central database), and use only that project's memory and knowledge base, as its worker does. |
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
- **The agent image**: every runtime runs the same one.
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
| 1 | 87 / 19 | 23 / 15 / 12 |
| 24 | 113 / 19 | 23 / 15 / 12 |
| 60 | 150 / 19 | 23 / 15 / 12 |

(Everything on, including the legacy memory's one-deploy output. The knowledge bases add the vector bucket to the
parent, and to each nested stack five resources, its two outputs `Project<hash>KnowledgeBaseId` and
`Project<hash>KnowledgeBaseDataSourceId`, the knowledge base id the parent reads for the API, and the vector bucket's
parameter. From 24 projects, CDK moves part of the API role's policy, which names every project's memory, worker
runtime and knowledge base, into managed policies of that role: three at 24 and four at 60, of the ten a role may have
by default.)

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

Everyone signs in with Amazon Cognito (`trace login`). Each person is in one of three classes:

| Class | What they can do |
| --- | --- |
| **admin** | Everything, on every project. This includes inviting people, setting classes and assigning projects. |
| **user** | Read and write, only on the projects they are assigned to. |
| **guest** | Read only, only on the projects they are assigned to. |

- **Read** means seeing a project's status, settings, runs and artifacts, and using the read-only tools.
- **Write** also allows changing settings, giving the agents work (`trace remote task`), and using the tools that
  record runs.

A person's class is their Cognito group (`trace-admins`, `trace-users`, `trace-guests`), so it travels inside their
signed token. Someone in none of these groups can do nothing. Project assignments live in the central database.
Someone not assigned to a project cannot tell that it exists.

The API runtime checks every request against these rules. Each repository's own workflows reach only that project's
worker runtime, through IAM, so a person's sign-in never acts as the loop, and the loop never acts as a person. Admins manage
people with:

```sh
trace users invite EMAIL --class user|guest|admin
trace users class EMAIL guest
trace users assign EMAIL OWNER/REPO
trace users unassign EMAIL OWNER/REPO
trace users list
trace users assignments
```

The installer sets up the first admin and anyone else you list, with their classes and projects.

Changing a project's prompts takes write access on it, and the installation's prompts only an admin can change;
guests can list, read and preview them (see [Managing prompts](#managing-prompts)).

Marking an agent memory inactive (`trace remote memory deactivate`) takes write access. A person's own preferences
are the exception: they may mark those with read access alone (see [Inactive memories](#inactive-memories)).

## Where builds run

Every build, test and automation job runs on AWS, in the installation's own account. GitHub-hosted runners are
never used, by trace's own repository or by any repository it manages.

The workflows stay in GitHub Actions, so pull requests show their checks as usual, but each job runs on an
[AWS CodeBuild-hosted runner](https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner.html): GitHub
queues the job, CodeBuild receives the queued event, starts a fresh build container in your account, and that
container runs the job and is discarded.

- **One runner project per repository**, `<prefix>-ci-<hash>`, made by the stack. Its workflows name it through the
  repository variable `TRACE_CODEBUILD_PROJECT`, which the installer sets:
  `runs-on: [codebuild-${{ vars.TRACE_CODEBUILD_PROJECT }}-${{ github.run_id }}-${{ github.run_attempt }}, <job>]`.
- **No GitHub token is stored for it.** CodeBuild reaches GitHub through an AWS CodeConnections connection (the AWS
  Connector for GitHub app). Grant that app access to every repository trace manages.
- **One connection per account and region.** A person authorizes it once, in the AWS console. After that every
  installation and `npm run deploy:ci` in the same account and region reuses it, and says which one it used. Nothing
  needs it up front:
  1. The installer looks for a connection that is already authorized. If it finds one, it deploys once, with the
     runners.
  2. If there is none, the stack creates `<prefix>-github` and the first deploy goes ahead without the runners.
     CodeBuild can't attach a runner to a connection nobody has authorized yet.
  3. The installer then shows the link to the AWS console, what to choose there ("Update pending connection", which
     installs the AWS Connector for GitHub app), and the time of its next check. It checks every 15 seconds for up to
     30 minutes. If it gives up, run it again and it carries on from there.
  4. Once the connection is authorized, it deploys again. That only adds each repository's runner and its GitHub
     webhook.

  A connection the stack created is kept if the stack is deleted, because other installations may be using it.
- **No AWS access comes with it.** The runner's own role may write its logs and use the connection, nothing else.
  Jobs reach AWS exactly as before, through their repository's GitHub OIDC role.
- **No fallback.** If `TRACE_CODEBUILD_PROJECT` is missing or the runner project doesn't exist, jobs wait in the queue
  rather than run on GitHub. `trace doctor owner/repo` reports it, and running the installer again fixes it.
- **Bigger machines:** `runners.computeType` sets every job's default size (large unless changed); a job can ask for
  another with an `instance-size:` label. `runners.privileged` turns on Docker for jobs that build containers.

trace's own repository builds the same way, on the runner project `trace-ci`. Deploy it once per account, before
its first pull request can be checked:

```sh
npm run deploy:ci
```

It works the same way as the installer. It reuses an authorized connection (`trace-ci-github` first, then an
installation's). If there is none, it creates `trace-ci-github`, shows you where to authorize it, waits, and then adds
the runner. To use a particular connection, set `TRACE_CONNECTION_ARN`. Anything after `--` goes to `cdk deploy`.

A guard test fails the build if any workflow here or in `templates/` names a runner other than a CodeBuild one.

## Putting another repository under trace

```sh
trace onboard owner/repo --apply-settings      # an existing repository: opens a held PR with what it adds
trace new owner/board --template kicad         # a new one: created, scaffolded and pushed
trace doctor owner/repo                        # what is still missing, and how to fix each item
```

Onboarding adds the following:

| What | Why |
| --- | --- |
| `.trace/project.db` | The project's own SQLite database. It holds the detected settings and, later, every tool run. |
| `.trace/rules.md` | **Empty.** You write the rules. Agents treat them as the authority on what to do and when to ask you. |
| `.github/workflows/trace-*.yml` | Four thin workflows that call this repository's actions: `prs`, `ci`, `worker`, `deploy`. |
| `.gitattributes` | Makes `project.db` merge row by row (`trace db merge`) instead of conflicting as a binary file. |
| `CLAUDE.md` section | A pointer to the rules and the tools. It is appended; nothing already there is replaced. |

Settings are changed with `trace config set <key> <value>` (`trace config keys` lists them all). Each workflow has a
kill switch, a repository variable set to `false`: `TRACE_PRS`, `TRACE_CI`, `TRACE_WORKER`, `TRACE_DEPLOY`. Work is
done by a specialist agent (see [Specialist agents](#specialist-agents)) on AgentCore by default; `trace config set worker.runner actions` runs it as a GitHub Actions job instead, which
still runs on the project's CodeBuild runner in AWS.

## Data

Everything is stored in SQLite. There are no JSON or YAML data files.

- **Project database** (`.trace/project.db`): one per project. It holds settings plus the run record: every
  simulation, check, build and capture, with its measurements and artifacts stored as blobs. Use `trace runs`,
  `trace run <id>` and `trace artifact <id> <name>` to read it.
- **Central database** (`$TRACE_HOME/central.db`): one for everything. It holds the datasheet library (PDFs by
  sha256, page text, version history) and the parts database (stock, prices, lifecycle). Every project reads and
  writes the same one. Figures taken from a datasheet are cited by part number, sha256 and page.
- **Cache** (`~/.cache/tracekit/cache.db`): disposable data such as parsed boards and field-solver results.

The only YAML is what GitHub requires (workflow and action files). The only JSON is what Node requires
(`package.json`, `tsconfig.json`).

## Tools

```sh
trace tools                                   # every tool
trace tool calc.divider vin=12 vout=3.3       # run one
trace tool kicad.drc project=hw/board.kicad_pro
claude mcp add trace -- trace mcp             # give Claude Code all of them
```

Tools that drive real hardware (instruments, buses, flashing a target) are refused, and hidden from MCP, unless
`TRACE_HARDWARE=1`. Run them only on a machine wired to the bench. Configure the bench with `trace config set` for
`hil.instruments`, `hil.serial` and `hil.can`. Every power supply must have voltage and current limits.

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

**How a call gets there.** The agent's MCP configuration does not change: `trace mcp` stays its one server. With
`TRACE_GATEWAY_URL` set (the stack sets it on every worker), `trace mcp` forwards these calls to the gateway as MCP
`tools/call` on `library___<tool>`, signed with SigV4 by the runtime's own credentials (the gateway's inbound auth is
`AWS_IAM`; an MCP client's remote configuration takes static headers only, so the signing has to be done here).
Parts calls carry the project's `parts.providers` and `parts.currency`, since the Lambda has no project. The Lambda
(`src/library/lambda.ts`) answers in an envelope that `trace mcp` unwraps, so a forwarded call reads the same as one run
in-process, and refuses any `file`, `path` or `library` whoever sends it.

**When a call fails.** Only a failure that means the call never ran counts as unreachable: the session could not be
opened, the connection was refused, or the gateway answered 401, 403, 429 or 503. A read then runs in the worker
instead, and `trace mcp` says so on stderr; a write (`datasheets.add`, `.acknowledge`, `parts.fetch_datasheet`)
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

**Distributor keys.** `MOUSER_API_KEY`, `DIGIKEY_CLIENT_ID`/`_SECRET` and `NEXAR_CLIENT_ID`/`_SECRET` go in one
Secrets Manager secret, `<prefix>/library-keys` (output `LibraryKeysSecretArn`), as a JSON object. The installer writes
the ones you give and keeps the ones you leave empty. Only the Lambda's role reads it, so no agent, which has Bash and
its role's credentials, can. Without the gateway, a worker has no distributor keys and `parts.lookup` asks LCSC only.

**Resources** (`src/infra/gateway.ts`, in the parent stack):

| Resource | What it may do |
| --- | --- |
| `<prefix>-library` gateway | `AWS_IAM` inbound auth, MCP. Its role (`<prefix>-gateway-<region>`) may only invoke the Lambda. |
| `library` target | Lambda target, `GATEWAY_IAM_ROLE` credentials, its tool schema generated from the tools' zod inputs without their local inputs. Gateway's schema has no enums or bounds, so they are kept in each field's description; the Lambda validates with the full zod schema. |
| `<prefix>-library` Lambda | Node 22 on arm64, 2 GB, 10 minutes (a 2,000-line BOM check asks the providers line by line). Role `<prefix>-library-<region>`: read `central/*`, write it only with a conditional put, read the keys secret. Nothing of `projects/`, `jobs/`, `access/` or `prompts/`. |
| `<prefix>/library-keys` secret | Written by the installer, never by CloudFormation. |

**Cost.** Gateway calls are $0.005 per 1,000, and tool indexing $0.02 per 100 tools a month (11 tools), at
[AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/); the Lambda is billed per call. Nothing runs
while idle.

**Not yet tried on a real deploy.** Everything above is tested offline: the bundle CloudFormation ships is built and
run against a local store, and the client is run against a local MCP server that checks every request's SigV4
signature. Still to confirm on AWS:

- that the gateway accepts the generated tool schema and lists `library___<tool>` as expected;
- that `bedrock-agentcore:InvokeGateway` on the gateway ARN is all a worker role needs to call it with SigV4;
- that the `nodejs22.x` Lambda runtime has `node:sqlite` without a flag (Node 22.13 and later);
- how the gateway wraps the Lambda's answer (`trace mcp` unwraps the envelope only when it finds it, and passes
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
`requirements`, `test_items`, `test_results`, `coverage_points` and `coverage_hits`, and `trace db merge` merges them
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
| `ams.spec` | Analog specs in the project database (table `ams_specs`): min/typ/max, unit, conditions and source per spec set and measure. `trace db merge` keeps the newer row. |
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

The table is `protocol_specs` (key: device, protocol, parameter), registered with `ensureProjectSchema`. `trace db
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

`trace db merge` merges the five thermal tables by key, keeping the newer row.

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
optional `pipeline: 'antmicro'` mode is left as future work.

## Specialist agents

Every job the loop starts (an `agent-fix` issue, a `ci-red` PR, a merge conflict, a sweep's items, a person's
`task`) goes to one **specialist**. The specialist investigates and measures with its own tools, and hands
repository changes to the **worker**, the generic agent with a shell and git, which runs only when a specialist
delegates to it. The worker's prompt, guardrails and job runner are unchanged.

| Kind | Specialist | What it does | Its trace tools (besides the shared ones) |
| --- | --- | --- | --- |
| `verify` | Verification | Turns specifications into requirements and a test plan, runs simulation, formal and rule checks against the plan, and closes functional and code coverage. It owns failing tests, testbenches, formal properties, coverage gaps and ERC. | `verify.*` (requirements, plan, run, coverage, report, verilator, cocotb, formal), `sim.*`, `kicad.erc`, `kicad.drc`, `protocol.*` but `pullup` (model, spec, spec_extract, check, compat, diagram, testbench, bus_analog); `hil.*` and `protocol.capture` only when hardware is allowed |
| `impl` | Implementation | Runs FPGA synthesis, place and route, timing closure and bitstreams, and PCB placement, floor planning, routing and length matching. It owns timing failures, constraint files, unrouted nets and DRC. It renders the result for visual review. | `fpga.*`, `pcb.autoroute`, `pcb.placement_check`, `pcb.length_match`, `pcb.floorplan`, `kicad.drc`, `kicad.net_length`, `render.board`, `protocol.compat`, `protocol.check`, `protocol.diagram` (interface timing budgets) |
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
`trace agent list` shows each specialist, its settings and its tools.

Each specialist's prompt (`src/agents/<kind>/index.ts`, composed by `src/agents/specialist.ts` from the prompt catalog,
see [Managing prompts](#managing-prompts)) has these parts:

- its workflow, step by step, with the tools in order;
- what evidence counts as done: measured, with run ids, never claimed;
- when to stop and ask a person;
- the project's `.trace/rules.md`, read from the default branch and included in full;
- the setting `agents.<kind>.instructions`, a short text that may be empty. The rules win where the two differ.

`trace agent prompt <kind>` prints the composed prompt for review, with the prompt overrides in force (`--marked` heads
each part with its id, layer and version). Each specialist has its own memory actor,
`<owner>/<repo>/<kind>`.

### Routing

`src/agents/router.ts` picks the specialist. It tries these in order, and the first that decides wins:

1. **An explicit kind.** This is `trace remote task --agent <kind>`, the API's `task` with `agent`, or a route that
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
- start the task with `trace remote task OWNER/REPO --agent <kind> "…"` (or `agent` in the API's `task`);
- for a dry run, use `trace agent route <issue|pr number|"text"> [--labels …] [--files …] [--checks …] [--model]`.

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
| `<owner>/<repo>/<agent>` | One agent on one project. The agents are the specialists `verify`, `impl`, `ams`, `emc` and `render` (every job), `worker` (a specialist's delegation, continuing its session) and `local` (a person's own Claude Code). `ci-doctor` and `conflict` hold what was remembered before the specialists. A specialist's recall (at the start of a job, and `memory_recall`) also searches `ci-doctor`, `conflict` and `worker`, read only, ranked after its own records and tagged `legacy` in the prompt block; nothing is migrated (AgentCore cannot copy records). |
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
trace remote memory list OWNER/REPO [--all]          # --all also lists inactive records, with why, who and when
trace remote memory deactivate OWNER/REPO RECORD_ID --reason "the rail is 3V3, not 5V"
trace remote memory reactivate OWNER/REPO RECORD_ID
```

These are the API actions `memory.deactivate { repo, recordId, reason }`, `memory.reactivate { repo, recordId }` and
`memory.list { repo, includeInactive }`. Each record that `memory.list` returns has `active`, and an inactive one
also has `inactive: { reason, by, by_you, at }`, where `by` is the person's hash, not their email. On a local
installation that has no API, `trace memory list|deactivate|reactivate` does the same with your own AWS credentials
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
trace prompts list                                   # every id: editable or locked, and where its text comes from
trace prompts get specialist.verify.workflow         # the default, each layer's text, the effective text and the locked parts after it
trace prompts set specialist.verify.workflow --reason "our order" --file workflow.txt   # or the text on stdin
trace prompts history specialist.verify.workflow
trace prompts diff specialist.verify.workflow v1 v2  # or: default, effective
trace prompts revert specialist.verify.workflow 1    # a version, or a history uid
trace prompts reset specialist.verify.workflow       # back to the layer below
trace prompts preview verify --marked                # the whole prompt as the model gets it, each part headed by its id
trace remote prompts … [--repo OWNER/REPO | --installation]   # the same through the API
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
| `cloudworker.prompt` / `cloudworker.guardrails`, `cloudworker.none` | editable / locked | the hourly cloud worker (`trace worker-prompt`), which spans projects, so only installation overrides apply to it |
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
per line), and `trace prompts get` lists them. A template that uses an unknown variable, or a malformed placeholder,
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
`trace prompts set` writes the clone's database and you commit it. `--installation` writes the installation's store
with your own credentials.

Every change (set, reset, revert) is a row in `prompt_history`: the id, the version it made, the text, who (a
person's 16-character hash through the API, the login locally), when and why. A reset is recorded as an override
with no text, so it merges like any change. `trace db merge` keeps, per id, the row changed last, and the union of
both histories; two branches can each make a v3 of one id, and their history keeps both, told apart by `uid`.

An override that can't be used is reported, never used: one of an id the catalog no longer has, one of a locked id,
or one that no longer validates (a variable its entry dropped). `prompts.list` and `trace prompts list` list them,
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

The access check comes first, as for every action: a project you are not assigned to and one that does not exist
get the same "no access". The setting `agents.<kind>.instructions` stays as a lightweight addendum after the rules;
overrides are the full mechanism.

**Upgrading.** Workflows written by an earlier `trace onboard` do not pass `TRACE_HOME` to the `worker-prompt` and
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
| Repository files matching `knowledge.include` and not `knowledge.exclude` (what `git ls-files` lists). By default: markdown, `.rst`, `.adoc`, `.txt`, HTML under `docs/`, `CLAUDE.md` and `.trace/rules.md`, without `node_modules`, build output, licences and changelogs. Firmware sources only when a glob names them (`trace config set knowledge.include '[…, "firmware/**/*.c"]'`). | `repo/<path>`, with `.txt` appended to anything that is not `.md`, `.txt`, `.html` or `.csv` (Bedrock reads those as text) | `repo`; `markdown`, `doc`, `rules`, `claude` or `source` |
| Each KiCad project (`electronics.projects`, else every `.kicad_pro`): its title block, sheets, BOM (quantity, references, value, footprint, MPN, manufacturer, LCSC, description), parts left out, power nets, net labels and the board's nets, written by the KiCad readers trace already has. Raw KiCad files are never uploaded. `knowledge.kicad` | `summary/<path of the .kicad_pro>.md` | `summary`, `kicad` |
| The current datasheet, in the shared library, of every MPN in those BOMs: one object per page of its text, at most `knowledge.max_datasheet_pages`. `knowledge.datasheets` | `datasheets/<part>/<first 16 of its sha256>/p<page>.txt` | `datasheet`, `datasheet` |

Files larger than `knowledge.max_file_kb` (512), empty files, binaries, PDFs, images and the project database are
left out, and the sync lists what it skipped. Every object has its `<key>.metadata.json` sidecar beside it, the form
Bedrock requires for metadata (at most 10 KB): `source`, `kind`, `path`, `commit` (the commit its content was first
synced from), `dir1`…`dir6` (the first 16 hex digits of the sha256 of each enclosing folder), and for a datasheet page
`part`, `mpn`, `sha256` and `page`. `path` and `part` are embedded with each chunk; the rest is for filtering and
citing.

**How sync works** (`src/tools/kb/sync.ts`). `trace kb sync` collects the above from the checkout, then:

1. lists the prefix (ListObjectsV2) and compares each object's content hash: a document's is the sha256 of its bytes,
   kept in the object's metadata (`x-amz-meta-trace-sha256`); a sidecar's covers its document and attributes but not
   the commit, so an unchanged document is not uploaded again on every push. The project database's `kb_objects`
   table (`s3_key`, `path`, `hash`, `etag`, `uploaded_at`; `trace db merge` keeps the newer row per key) saves the
   HeadObject calls when its row and the listed ETag agree; without rows (a fresh checkout) HeadObject decides;
2. uploads what changed, deletes what is no longer wanted (DeleteObjects);
3. starts an ingestion job (StartIngestionJob) when anything changed, when the data source has never been ingested,
   when its last job failed or was stopped or began before the newest upload `kb_objects` records, or with `--force`. One job runs at a time per data source, so a running one is waited for first. It then polls
   GetIngestionJob until the job is complete, failed or stopped, or `--wait` minutes (15) pass, and reports the job's
   statistics (scanned, indexed, deleted, failed) and failure reasons. A job that outlives the wait carries on;
   `trace kb status` shows it.

The sync refuses a checkout that is not the default branch (`--allow-branch` overrides it): the knowledge base holds
the default branch. It runs:

- **on every push to the default branch**, as the `kb-sync` job of `trace-worker.yml`, with the repository's own GitHub
  OIDC role (`TRACE_AWS_ROLE`, `TRACE_KB_ID`, `TRACE_KB_DATA_SOURCE_ID`, `TRACE_HOME`), whatever `worker.runner` says.
  Repositories onboarded before this need `trace onboard --refresh` to get the job;
- **by hand**: `trace kb sync [--force] [--dry-run] [--wait MINUTES]` in a clone, with your own credentials and those
  variables, or `trace remote kb sync OWNER/REPO` (write access), which runs the `kb.sync` tool on the project's own
  worker runtime, on its clone of the default branch;
- **from the worker**: the `kb.sync` tool, for repairs. No specialist has it.

**Using it.** The MCP tools are `kb.search { query, top_k, filter: { source?, kind?, path_prefix? } }` (Retrieve
through `bedrock-agent-runtime`; each hit has its text, score, path, commit and a citation: `path@commit`, or the part,
sha256 and page of a datasheet), `kb.status` (the newest ingestion job and how many documents are in S3) and `kb.sync`.
They are offered only when `TRACE_KB_ID` is set. Every specialist has `kb.search` and `kb.status`, read only; nothing
an agent is given can mark or change the knowledge base, apart from the worker's `kb.sync` of the default branch.
S3 Vectors has no `startsWith` filter, so `path_prefix` is a folder in whole segments (`docs/power`) or one file's exact
path: an equals on that folder's `dir<n>` hash, or on `path`; folders deeper than six levels are filtered on their
first six and narrowed afterwards. From the command line: `trace kb search "query" [--source S] [--kind K] [--path P]`
and `trace kb status` locally, `trace remote kb search OWNER/REPO "query"` through the API (read access). The API's
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
| `src/core` | Settings, SQLite stores, the tool registry, the MCP server, onboarding, access control, the Python bridge client |
| `src/infra` | The CDK stack (Cognito, the central bucket, the image builds, the API runtime, the AWS Batch GPU queue in `gpu.ts`) and, per project, `project.ts` (its worker runtime, roles, token secret and GPU job definition) |
| `src/installer` | `trace install`: the local web installer |
| `src/prompts` | The prompt catalog (every prompt part's id, default, variables and whether it is locked), the `{{var}}` templates, the layers (installation and project overrides) and their stores, and `trace prompts` |
| `src/agents` | The specialists (`verify`, `impl`, `ams`, `emc`, `render`, each in its own folder; `index.ts` lists them), the router, the retained worker's prompt (`worker`), and the runtime (`runtime`: server, jobs, delegation, memory, observability) |
| `src/api`, `agent/Dockerfile` | The people-facing API, and the image AgentCore runs |
| `src/login` | `trace login`, `trace remote …`, `trace users …` |
| `src/harness` | The loop's logic, bundled into `harness/dist` for the GitHub actions in `harness/actions` |
| `src/infra/gateway.ts`, `src/core/gateway.ts`, `src/library` | The library gateway: its CDK resources, which calls `trace mcp` forwards and how (SigV4, fallback), and the Lambda behind it |
| `src/infra/knowledge.ts`, `src/tools/kb` | Each project's knowledge base: its CDK resources, and what goes in it, the sync, search and the kb tools |
| `src/tools/calc`, `src/tools/kicad`, `src/tools/pcb`, `src/tools/sim`, `src/tools/protocol`, `src/tools/datasheets`, `src/tools/parts`, `src/tools/hil`, `src/tools/firmware`, `src/tools/runs` | The tools |
| `src/gpu`, `agent/Dockerfile.gpu` | GPU jobs: local or AWS Batch (`runJob`, `runBatch`), the in-container runner, and its image |
| `python/kicad`, `python/orthoroute` | The scripts the autorouter jobs run: Freerouting through KiCad's pcbnew, and OrthoRoute's headless mode |
| `python/tracebridge` | The only Python, used where Node has no maintained equivalent: PDF tables and figures (pdfplumber), VISA instruments (pyvisa), and CAN vendor interfaces (python-can) |
| `templates` | What onboarding writes: workflows, starter builds, scaffolds, the empty rules |

Develop with `npm ci && npm run check`. The Python bridge has its own setup: `pip install -e 'python[dev]' && pytest python/tests`.
