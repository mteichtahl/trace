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
  execution role, GitHub OIDC role, GitHub token secret and GPU job definition, and the API runtime. A project's
  worker is invoked by that repository's workflows through IAM, and by the API. The API runtime is for people and is
  reached only with a Cognito sign-in. The stack also holds the Cognito user pool.
- **GitHub:** each repository's Actions variables (`TRACE_AWS_ROLE` and `TRACE_AGENT_RUNTIME_ARN`, both its own
  project's, `TRACE_AWS_REGION`, `TRACE_HOME`) and its `TRACE_TOKEN` secret (its project's agent token, encrypted
  with the repository's key), plus the onboarding pull request.
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
| **Memory** | One AgentCore Memory per repository (`<prefix>_m_<hash>`, tagged `trace:project`), its own event expiry, and its own log group and log delivery. The worker is told only its own (`TRACE_MEMORY_ID`) and its role may use only that memory's ARN. On it, the role may still create and list events only for actors `<owner>/<repo>/*`, and recall and list records only under `/trace/<owner>/<repo>/*` (the condition keys `bedrock-agentcore:actorId` and `bedrock-agentcore:namespace`), as defence in depth. The actor comes from `TRACE_PROJECT`, never from the request. The GitHub OIDC role has no memory access. |
| **S3** | Read and write `projects/<owner>/<repo>/*` and `jobs/<owner>/<repo>/*`, and list only those prefixes and `central/*`. Nothing under `access/*`, and nothing of another project. |
| **GPU jobs** | One AWS Batch job definition per project, whose job role reads and writes only that project's `jobs/<owner>/<repo>/*`. A project's role may submit only with its own definition, only jobs tagged `trace:project=<owner>/<repo>`, and may stop only jobs carrying that tag. SubmitJob cannot override a definition's job role. |
| **GitHub OIDC role** | One per repository, trusted only for `repo:OWNER/REPO:ref:refs/heads/BRANCH`. It may invoke only that project's runtime and read and write only that project's prefix (and the central database). |
| **GitHub token** | Each project has its own secret, `<prefix>/github-token/<owner>/<repo>`, and its worker reads only that one. This isolates GitHub access only when you give the project its own fine-grained token limited to that repository. By default the shared token is copied into every project's secret, and the installer's summary says so. A project token is checked: it must see its repository, and the installer warns if it can also see another project's. |

Shared on purpose:

- **The central database** (`central/`: datasheets and the parts database). Every project reads it. Every project
  may also write it, because adding a datasheet is a shared write, but only with a conditional put (`If-Match` or
  `If-None-Match`, which is how the central store always writes) and never a delete. The bucket is versioned.
- **The GPU queue and compute environment**, and the GPU image.
- **The agent image**: every runtime runs the same one.
- **The API runtime.** It is the one component that spans projects. It holds the shared GitHub token, which admins
  need for `settings.get` and `settings.set` on any project. It reads (never writes) the records of every project's
  memory for `memory.list` and `memory.recall`, choosing the memory of the project asked for after the access check,
  and it may invoke every project's worker. It does all of this only after its
  Cognito access check. It runs no model and no agent, and nothing reaches a shell through it: a `task` is handed to
  the project's own worker runtime.

`DescribeJobs` in AWS Batch has no resource-level permissions, so any project's role can describe (not change) any
job on the queue, which includes its command and environment. Job ids, not data, are what that reveals.

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
done by the agent on AgentCore by default; `trace config set worker.runner actions` runs it inside GitHub Actions
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
`TRACE_GPU_REMOTE=always|never` overrides this choice. The installer's Agents step can turn the queue off and sets
its vCPU limit and Spot use (`gpu.enabled`, `gpu.maxVcpus`, `gpu.spot` in the stack settings). The GPU image is
described in `agent/README.md`.

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
like everything else. Requirements, tests and points keep the newer row; results and hits are unioned.

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

The Implementation agent's tools cover two areas:

- **FPGA:** `fpga.synth` (yosys for ice40, ecp5, gowin and xilinx; cell counts by resource), `fpga.pnr` (nextpnr with
  PCF, LPF or CST constraints, seed, placer, per-clock targets and floorplan regions), `fpga.timing` (Fmax against
  target per clock, slack, closure status, and critical paths split into logic and routing), `fpga.closure` (a fixed
  sweep of seeds, placers and options that keeps the best attempt) and `fpga.bitstream` (icepack, ecppack,
  gowin_pack).
- **PCB:** `pcb.placement_check` (courtyard overlaps, parts outside or near the edge, keep-outs, decoupling distance,
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

## Agent memory

Each agent has short-term and long-term memory in its project's own Amazon Bedrock AgentCore Memory: one per
repository, named `<prefix>_m_<hash>` and created with the project's other resources (`src/infra/project.ts` and
`src/infra/memory.ts`; the client is `src/agent/memory.ts`). The stack settings are:

- `memory.enabled` (default true).
- `memory.eventExpiryDays`: how long short-term events are kept. The default is 30 and AgentCore allows 3 to 365.
- `projectSettings`: settings for one project, keyed by `OWNER/REPO` (without `@BRANCH`). Today that is
  `memoryEventExpiryDays`, which overrides `memory.eventExpiryDays` for that project. The installer sets it from the
  "memory days" field beside each repository. An empty field means the default.

A project's memory lives and dies with the project. With `retainData` true (the default), each memory, its log group
and its log delivery are marked Retain. When the repository is removed from the list, or the stack is deleted, they
stay in the account, outside the stack. With `retainData` false they are deleted, records and all. Each project's
memory id is the output `Project<hash>MemoryId`, and the installer records them on this machine.

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
| `<owner>/<repo>/<agent>` | One agent on one project. The agents are `worker` (agent-fix issues, tasks), `ci-doctor` (a red check), `conflict` (a merge conflict), `render` (render tasks) and `local` (a person's own Claude Code). |
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
  (`/trace/<owner>/<repo>/*`). The API role may only recall and list records under `/trace/`, on each project's
  memory. The GitHub OIDC roles have no memory access. The client draws the same lines as well (see
  [Project isolation](#project-isolation)).
- **Limits:** the API's two lists (`TRACE_WORKER_RUNTIMES` and `TRACE_PROJECT_MEMORIES`) are each one environment
  value, at most 5000 characters, and a runtime may have at most 50 environment variables. The stack checks both
  when it is built and refuses an installation that would not fit. CloudFormation's 500 resources per stack is the
  tighter limit in practice: each project adds about 17 resources with memory and observability on (9 without memory),
  so with the defaults one stack holds about 24 projects. `cdk synth` fails with `TooManyResourcesInStack` beyond that.

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
| `trace.job <kind>` | each job | job id, kind, repository, agent (`worker`, `ci-doctor`, `conflict`, `render`), the item, who asked (a hash), the outcome |
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
the worker, that is one work item at one head (`trace-<owner>-<repo>-<number>-<sha12>`, from `src/agent/dispatch.ts`).
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
| `src/agent`, `src/api`, `agent/Dockerfile` | The image AgentCore runs: the worker, and the people-facing API |
| `src/login` | `trace login`, `trace remote …`, `trace users …` |
| `src/harness` | The loop's logic, bundled into `harness/dist` for the GitHub actions in `harness/actions` |
| `src/tools/calc`, `src/tools/kicad`, `src/tools/pcb`, `src/tools/sim`, `src/tools/datasheets`, `src/tools/parts`, `src/tools/hil`, `src/tools/firmware`, `src/tools/runs` | The tools |
| `src/gpu`, `agent/Dockerfile.gpu` | GPU jobs: local or AWS Batch (`runJob`, `runBatch`), the in-container runner, and its image |
| `python/kicad`, `python/orthoroute` | The scripts the autorouter jobs run: Freerouting through KiCad's pcbnew, and OrthoRoute's headless mode |
| `python/tracebridge` | The only Python, used where Node has no maintained equivalent: PDF tables and figures (pdfplumber), VISA instruments (pyvisa), and CAN vendor interfaces (python-can) |
| `templates` | What onboarding writes: workflows, starter builds, scaffolds, the empty rules |

Develop with `npm ci && npm run check`. The Python bridge has its own setup: `pip install -e 'python[dev]' && pytest python/tests`.
