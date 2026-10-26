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

- **GitHub:** the shared agent token, the repositories trace will run, and optionally each project's own agent
  token (see [Project isolation](#project-isolation)).
- **AWS:** a profile (SSO works) or access keys, the region, and confirmation of the account. It checks that Bedrock
  AgentCore and an Anthropic model are available there.
- **Agents:** the model, session limits, and the central bucket.
- **People:** the first administrator, and for everyone else their class (admin, user, guest) and the projects they
  are assigned to.

It then shows the plan and runs it:

- **AWS (CDK):** one stack. It contains the central bucket, the agent image (built by CodeBuild on arm64, so no
  local Docker is needed), and AgentCore runtimes from that image: one worker runtime per project, each with its own
  execution role, GitHub OIDC role, GitHub token secret, memory and GPU and CPU job definitions, and the API runtime. Each
  project's resources are in a nested stack of their own (see [Stack layout](#stack-layout-and-limits)). A project's
  worker is invoked by that repository's workflows through IAM, and by the API. The API runtime is for people and is
  reached only with a Cognito sign-in. The stack also holds the Cognito user pool.
- **GitHub:** each repository's Actions variables (`TRACE_AWS_ROLE`, `TRACE_AGENT_RUNTIME_ARN` and `TRACE_MEMORY_ID`,
  all its own project's, `TRACE_AWS_REGION`, `TRACE_HOME`) and its `TRACE_TOKEN` secret (its project's agent token,
  encrypted with the repository's key), plus the onboarding pull request.
- **The GPU image**, last: the deploy starts its build and does not wait for it (see [GPU jobs](#gpu-jobs-rendering-and-autorouting)),
  so the installer waits for it once everything else is set up, and starts it again if an earlier one failed. A failed
  GPU image leaves GPU and CPU jobs unavailable and everything else installed.
- **People:** Cognito invitations into each person's class group, and project assignments recorded in the central
  database.

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
| **S3** | Read and write `projects/<owner>/<repo>/*` and `jobs/<owner>/<repo>/*`, and list only those prefixes and `central/*`. Nothing under `access/*`, and nothing of another project. |
| **GPU and CPU jobs** | Two AWS Batch job definitions per project (`<prefix>-gpu-<hash>`, and `<prefix>-cpu-<hash>` with the CPU queue), with one job role that reads and writes only that project's `jobs/<owner>/<repo>/*`. A project's role may submit only with its own definitions, only jobs tagged `trace:project=<owner>/<repo>`, and may stop only jobs carrying that tag. SubmitJob cannot override a definition's job role. |
| **GitHub OIDC role** | One per repository, trusted only for `repo:OWNER/REPO:ref:refs/heads/BRANCH`. It may invoke only that project's runtime, read and write only that project's prefix (and the central database), and use only that project's memory, as its worker does. |
| **GitHub token** | Each project has its own secret, `<prefix>/github-token/<owner>/<repo>`, and its worker reads only that one. This isolates GitHub access only when you give the project its own fine-grained token limited to that repository. By default the shared token is copied into every project's secret, and the installer's summary says so. A project token is checked: it must see its repository, and the installer warns if it can also see another project's. |

Shared on purpose:

- **The central database** (`central/`: datasheets and the parts database). Every project reads it. Every project
  may also write it, because adding a datasheet is a shared write, but only with a conditional put (`If-Match` or
  `If-None-Match`, which is how the central store always writes) and never a delete. The bucket is versioned.
- **The GPU and CPU queues and compute environments**, and the GPU image (which both run).
- **The agent image**: every runtime runs the same one.
- **The API runtime.** It is the one component that spans projects. It holds the shared GitHub token, which admins
  need for `settings.get` and `settings.set` on any project. It reads (never writes) the records of every project's
  memory for `memory.list` and `memory.recall`, choosing the memory of the project asked for after the access check,
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
OIDC role, token secret, memory with its log group and log delivery, GPU and CPU job definitions and job role: 18
CloudFormation resources with everything on) are a CloudFormation nested stack of their own, `Project<hash>Stack`
(`src/infra/project.ts` `ProjectNestedStack`). The parent stack holds the shared parts and one
`AWS::CloudFormation::Stack` per project. What a project uses of the parent (the bucket, the agent image and its
repository, the OIDC provider, the GPU and CPU queues, image repository, execution role and log group) reaches its
nested stack as parameters, and the parent waits for Transaction Search before it creates or updates a project (not
for the GPU image: see [GPU jobs](#gpu-jobs-rendering-and-autorouting)).
Inside, the resources are the ones the single stack had, with the same names, IAM and removal policies (with
`retainData`, a removed project's memory, log group and log delivery stay in the account, as before).

| Projects | Parent stack: resources / outputs | Each project's nested stack: resources / outputs / parameters |
| --- | --- | --- |
| 1 | 86 / 19 | 18 / 12 / 11 |
| 24 | 111 / 19 | 18 / 12 / 11 |
| 60 | 148 / 19 | 18 / 12 / 11 |

(Everything on, including the legacy memory's one-deploy output. From 24 projects, CDK moves part of the API role's
policy, which names every project's memory and worker runtime, into managed policies of that role: three at 60, of
the ten a role may have by default.)

CloudFormation allows 500 resources, 200 outputs and 200 parameters per template, and the stack checks all three
when it is built. The parent carries none of a project's outputs, so its output count does not grow with the
projects. Each project's are its nested stack's, under the names they always had (`Project<hash>RuntimeArn`,
`Project<hash>ActionsRoleArn`, `Project<hash>MemoryId`, `Project<hash>GithubSecretArn`,
`Project<hash>GpuJobDefinition`, `Project<hash>LogGroup`, `Project<hash>MemoryLogGroup`), with `Repository`
(`owner/repo`). The installer lists the parent's resources (`ListStackResources`: `DescribeStackResources` returns
only the first 100), takes each `AWS::CloudFormation::Stack` whose logical id is `Project<hash>Stack…`, reads its
outputs with `DescribeStacks` on its physical id, checks its `Repository` output against the hash, and takes only the
outputs named for that hash (`src/installer/aws.ts` `stackOutputs`). The flat layout keeps its outputs in the one
stack, as before. The other limit at 60 is the API's two `owner/repo=<id>` lists (see
[Agent memory](#agent-memory)): very long repository names can reach their 5000 characters first, and the stack says
so when it is built. The output `Layout` says which layout an installation has.

`cdk deploy` uploads each nested template to the CDK bootstrap bucket as a file asset, the same way it already
uploads the agent source and the Lambda code, so the bootstrap the installer runs (version 6 or later) covers it.

**Installations from before nested stacks keep `layout: 'flat'`.** There every project's resources are in the one
stack, and it holds about 24 projects (`cdk synth` refuses more). The installer picks the layout from the deployed
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

Marking an agent memory inactive (`trace remote memory deactivate`) takes write access. A person's own preferences
are the exception: they may mark those with read access alone (see [Inactive memories](#inactive-memories)).

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
done by a specialist agent (see [Specialist agents](#specialist-agents)) on AgentCore by default; `trace config set worker.runner actions` runs it inside GitHub Actions
instead.

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

## GPU jobs: rendering and autorouting

AgentCore runtimes have no GPU. Tools that need one, the Blender renders and the PCB autorouters, run their programs
through `runJob` (`src/gpu/jobs.ts`). A job runs on the local machine when that machine has an NVIDIA GPU or the job
does not need one. Otherwise, when `TRACE_GPU_QUEUE` is set (the stack sets it on each project's worker runtime,
with that project's job definition), the job goes to an AWS Batch queue of GPU instances that scales to zero when
idle. Inputs travel through the central bucket's `jobs/<owner>/<repo>/` prefix (`TRACE_PROJECT`; `jobs/_local/` outside
a project), and outputs and logs come back the same way, so the tool answers the same wherever the job ran. The API
runtime has no GPU queue: GPU work goes through a `task`.
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

## Specialist agents

Every job the loop starts (an `agent-fix` issue, a `ci-red` PR, a merge conflict, a sweep's items, a person's
`task`) goes to one **specialist**. The specialist investigates and measures with its own tools, and hands
repository changes to the **worker**, the generic agent with a shell and git, which runs only when a specialist
delegates to it. The worker's prompt, guardrails and job runner are unchanged.

| Kind | Specialist | What it does | Its trace tools (besides the shared ones) |
| --- | --- | --- | --- |
| `verify` | Verification | Turns specifications into requirements and a test plan, runs simulation, formal and rule checks against the plan, and closes functional and code coverage. It owns failing tests, testbenches, formal properties, coverage gaps and ERC. | `verify.*` (requirements, plan, run, coverage, report, verilator, cocotb, formal), `sim.*`, `kicad.erc`, `kicad.drc`; `hil.*` only when hardware is allowed |
| `impl` | Implementation | Runs FPGA synthesis, place and route, timing closure and bitstreams, and PCB placement, floor planning, routing and length matching. It owns timing failures, constraint files, unrouted nets and DRC. It renders the result for visual review. | `fpga.*`, `pcb.autoroute`, `pcb.placement_check`, `pcb.length_match`, `pcb.floorplan`, `kicad.drc`, `kicad.net_length`, `render.board` |
| `ams` | Analog & Mixed-Signal | Keeps analog specs and judges circuits against them: corners, Monte Carlo yield, op-amp stability, noise and ADC/digital co-simulation. It also chooses parts from the datasheet library. | `ams.*`, `sim.spice`, `sim.sweep`, `sim.measure`, `sim.kicad_spice`, `calc.*`, `datasheets.*`, `parts.*` |
| `emc` | EMC & Simulation | Runs EMI rule prechecks and emission estimates, sets up openEMS models (region, stackup, ports, boundary conditions, mesh) and runs them, and checks signal integrity from S-parameters. | `emc.*`, `calc.impedance`, `calc.trace_width`, `calc.via`, `kicad.board`, `kicad.net` |
| `render` | Rendering | Renders boards and models, and makes turntables. This was the rendering agent; it is kept as a specialist of its own, not folded into `impl`, because people ask for renders directly. | `render.*` |

Every specialist also has the shared read tools: `kicad.board`/`components`/`net`,
`datasheets.find`/`get`/`text`/`params`, `parts.lookup`, `trace.runs`/`run`/`artifact`, `memory.recall`/`remember`.
It also has `agent.delegate`. Its Claude Code tools are read-only: Read, Glob, Grep and TodoWrite, with no Bash,
Write, Edit or Task. The allowlist is enforced three ways. The Agent SDK's `tools` option sets the built-ins and
`allowedTools` sets the rest. The job sets `TRACE_MCP_TOOLS`, so the MCP server lists only the specialist's tools.
`trace agent list` shows each specialist, its settings and its tools.

Each specialist's prompt (`src/agents/<kind>/index.ts`, composed by `src/agents/specialist.ts`) has these parts:

- its workflow, step by step, with the tools in order;
- what evidence counts as done: measured, with run ids, never claimed;
- when to stop and ask a person;
- the project's `.trace/rules.md`, read from the default branch and included in full;
- the setting `agents.<kind>.instructions`, a short text that may be empty. The rules win where the two differ.

`trace agent prompt <kind>` prints the composed prompt for review. Each specialist has its own memory actor,
`<owner>/<repo>/<kind>`.

### Routing

`src/agents/router.ts` picks the specialist. It tries these in order, and the first that decides wins:

1. **An explicit kind.** This is `trace remote task --agent <kind>`, the API's `task` with `agent`, or a route that
   worker-pick already made.
2. **A label** on the issue or PR: `agent:verify`, `agent:impl`, `agent:ams`, `agent:emc` or `agent:render`. The names
   are the settings `labels.agent_<kind>`, and onboarding creates the labels.
3. **The evidence.** The router reads the names and log tails of the failing checks. The summary gate
   `build.required_check` is ignored when other checks failed. It also reads the changed files:
   - `verify`: `.sby`, testbenches and `tests/`, coverage data, HDL;
   - `impl`: `.pcf`, `.lpf`, `.cst`, `.sdc`, `.xdc`, `.kicad_pcb`, autorouter files, and timing, routing or DRC
     failures;
   - `ams`: `.cir`, `.sp`, `.lib`, and an `ams.spec` miss;
   - `emc`: Touchstone `.sNp`, and `emc.precheck` findings.

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
- **After it returns.** The specialist checks every acceptance criterion with its own tools before it reports. A
  criterion that fails twice is escalated.
- **Depth 1.** A specialist job holds a per-job token. A delegated worker gets no token, so it is never offered
  `agent.delegate`, and the runtime refuses any token it did not issue. A specialist runs one delegation at a time.
- **Internal only.** `/invocations` and the API never accept a worker task (`agent: 'worker'`).

**Under `worker.runner actions`** there is no runtime to delegate to. The specialist runs in GitHub Actions with its
own prompt plus the worker's instructions inline, and with Bash, Write, Edit and Task added, so it makes the change
itself.

### Settings

| Key | Default | What |
| --- | --- | --- |
| `agents.enabled` | all five | the specialists that may be routed to |
| `agents.default` | `verify` | where a job goes when nothing decides |
| `agents.route_with_model` | `true` | ask the model when labels, evidence and keywords do not decide |
| `agents.router_model` | `''` | its model (else `worker.model`, then the runtime's) |
| `agents.delegate_timeout_minutes` | `240` | how long `agent.delegate` waits for the worker |
| `agents.<kind>.model` | `''` | the specialist's model (else the runtime's `ANTHROPIC_MODEL`, then `worker.model`) |
| `agents.<kind>.max_turns` | `120` | its turn limit (the delegated worker keeps `worker.max_turns`) |
| `agents.<kind>.instructions` | `''` | project instructions for that specialist, after `.trace/rules.md` |

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
| `<owner>/<repo>/<agent>` | One agent on one project. The agents are the specialists `verify`, `impl`, `ams`, `emc` and `render` (every job), `worker` (a specialist's delegation, continuing its session) and `local` (a person's own Claude Code). `ci-doctor` and `conflict` hold what was remembered before the specialists. |
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
- **Limits:** the API's two lists (`TRACE_WORKER_RUNTIMES` and `TRACE_PROJECT_MEMORIES`) are each one environment
  value, at most 5000 characters, and a runtime may have at most 50 environment variables. The stack checks both
  when it is built and refuses an installation that would not fit. Each project is a nested stack of its own, so
  CloudFormation's 500 resources and 200 outputs per stack allow the full 60 projects; an installation still in the
  flat layout holds about 24 (see [Stack layout and limits](#stack-layout-and-limits)).

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
  the project's records. The one exception is a person's own records (their person actor
  `<owner>/<repo>/person/<hash>`, in practice their preferences): they are shown only to that person, so that person
  may turn them off or on with read access alone, guests included. Nobody but an admin can mark another person's
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

## Observability

Every AgentCore runtime starts Node with the AWS Distro for OpenTelemetry (ADOT) auto-instrumentation
(`node --require …/aws-distro-opentelemetry-node-autoinstrumentation/…/register.js`, in `agent/Dockerfile`). AgentCore
Runtime supplies its OpenTelemetry settings: the service name, the runtime's log group, and the headers that send
metrics to the `bedrock-agentcore` namespace. Spans go to X-Ray, which stores them in CloudWatch Logs (Transaction
Search). Metrics go to CloudWatch as EMF. The code records through the OpenTelemetry API only (`src/core/telemetry.ts`),
so with no SDK loaded (the CLI, local runs, tests) nothing is recorded and nothing changes.

| Span | Where | What it carries |
| --- | --- | --- |
| `invoke_agent trace-worker` / `trace-api` | each `POST /invocations` | the invocation kind or API action, the repository, the outcome; it continues the caller's trace (`traceparent`, `X-Amzn-Trace-Id`) and puts the AgentCore session id into baggage `session.id`, so every span below has it |
| `trace.job <kind>` | each job | job id, kind, repository, agent (the specialist, or `worker` for a delegation, with its parent job id), the route (`trace.agent.kind`, `trace.route.reason`, `trace.route.confidence`, `trace.route.source`), the item, who asked (a hash), the outcome |
| `claude.query` | each Agent SDK run | model, Claude's session id, turns, tokens (input, output, cache read and creation), the SDK's cost estimate |
| `chat <model>` | each model response | model, response id, finish reason, the tools it asked for |
| `execute_tool <name>` | each tool Claude used, and each call through the tool registry (the MCP server continues the job's trace) | tool name, where the call came from, the hardware flag, argument names and sizes, result size, duration, outcome |
| `trace.gpu_job <kind>`, `trace.gpu.run <kind>` | each GPU job, and its runner inside AWS Batch (continued from `TRACEPARENT`) | kind, backend, job ids, seconds, exit code |

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
| `src/agents` | The specialists (`verify`, `impl`, `ams`, `emc`, `render`, each in its own folder; `index.ts` lists them), the router, the retained worker's prompt (`worker`), and the runtime (`runtime`: server, jobs, delegation, memory, observability) |
| `src/api`, `agent/Dockerfile` | The people-facing API, and the image AgentCore runs |
| `src/login` | `trace login`, `trace remote …`, `trace users …` |
| `src/harness` | The loop's logic, bundled into `harness/dist` for the GitHub actions in `harness/actions` |
| `src/tools/calc`, `src/tools/kicad`, `src/tools/pcb`, `src/tools/sim`, `src/tools/datasheets`, `src/tools/parts`, `src/tools/hil`, `src/tools/firmware`, `src/tools/runs` | The tools |
| `src/gpu`, `agent/Dockerfile.gpu` | GPU jobs: local or AWS Batch (`runJob`, `runBatch`), the in-container runner, and its image |
| `python/kicad`, `python/orthoroute` | The scripts the autorouter jobs run: Freerouting through KiCad's pcbnew, and OrthoRoute's headless mode |
| `python/tracebridge` | The only Python, used where Node has no maintained equivalent: PDF tables and figures (pdfplumber), VISA instruments (pyvisa), and CAN vendor interfaces (python-can) |
| `templates` | What onboarding writes: workflows, starter builds, scaffolds, the empty rules |

Develop with `npm ci && npm run check`. The Python bridge has its own setup: `pip install -e 'python[dev]' && pytest python/tests`.
