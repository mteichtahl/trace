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

- **GitHub:** the token the agents use, and the repositories trace will run.
- **AWS:** a profile (SSO works) or access keys, the region, and confirmation of the account. It checks that Bedrock
  AgentCore and an Anthropic model are available there.
- **Agents:** the model, session limits, and the central bucket.
- **People:** the first administrator, and for everyone else their class (admin, user, guest) and the projects they
  are assigned to.

It then shows the plan and runs it:

- **AWS (CDK):** one stack. It contains the central bucket, the GitHub token's secret, the agent image (built by
  CodeBuild on arm64, so no local Docker is needed), and two AgentCore runtimes from that image. The worker runtime
  is invoked by the repositories' workflows through IAM. The API runtime is for people and is reached only with a
  Cognito sign-in. The stack also holds the Cognito user pool and the GitHub OIDC role the repositories' workflows
  assume.
- **GitHub:** each repository's Actions variables (`TRACE_AWS_ROLE`, `TRACE_AWS_REGION`, `TRACE_HOME`,
  `TRACE_AGENT_RUNTIME_ARN`) and its `TRACE_TOKEN` secret (encrypted with the repository's key), plus the onboarding
  pull request.
- **People:** Cognito invitations into each person's class group, and project assignments recorded in the central
  database.

Tokens and keys stay in the installer's memory. They are written only to Secrets Manager and GitHub. Every step can
be run again safely, and running the installer again updates an existing installation.

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

The API runtime checks every request against these rules. The repositories' own workflows reach only the worker
runtime, through IAM, so a person's sign-in never acts as the loop, and the loop never acts as a person. Admins manage
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
does not need one. Otherwise, when `TRACE_GPU_QUEUE` is set (the stack sets it on both runtimes), the job goes to an
AWS Batch queue of GPU instances that scales to zero when idle. Inputs travel through the central bucket's `jobs/`
prefix, and outputs and logs come back the same way, so the tool answers the same wherever the job ran.
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

## Agent memory

Each agent has short-term and long-term memory in one Amazon Bedrock AgentCore Memory per installation
(`src/infra/memory.ts`; the client is `src/agent/memory.ts`). Set `memory.enabled` and `memory.eventExpiryDays`
(default 30, from 3 to 365) in the stack settings.

- **Short term:** events per actor and session. A job records what it was asked, its key trace-tool outcomes and its
  result. A job that continues a session (the same pull request or issue, or the same task branch) is given that
  session's earlier turns.
- **Long term:** three built-in strategies extract records from those events. The semantic strategy keeps facts
  about the project, the summary strategy keeps one summary per session, and the user preference strategy keeps how
  the project wants things done.

The actors and namespaces keep projects and agents apart:

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
`TRACE_MEMORY_ID`, or when AgentCore fails, a job runs as before without memory.

- **Inside a job:** Claude has the MCP tools `memory_recall` and `memory_remember`. They act only as the job's actor and
  session (`TRACE_MEMORY_ACTOR` and `TRACE_MEMORY_SESSION`, or `TRACE_MEMORY_REPOSITORY` and `TRACE_MEMORY_AGENT`), and
  they are offered only when `TRACE_MEMORY_ID` is set.
- **Through the API:** anyone who can read a project can see its memory with the read-only actions `memory.list` and
  `memory.recall` (optionally for one `agent`). Person-scoped preferences are shown only to the person they belong
  to, and to admins.
- **In IAM:** both runtime roles may call only `CreateEvent`, `ListEvents`, `RetrieveMemoryRecords` and
  `ListMemoryRecords`, on this memory only. Events are limited to actor ids of the `<owner>/<repo>/<agent>` shape, and
  records to namespaces under `/trace/`. One role serves every project, so the line between projects is drawn by the
  client.

## Observability

Both AgentCore runtimes start Node with the AWS Distro for OpenTelemetry (ADOT) auto-instrumentation
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
- The memory's `APPLICATION_LOGS`, delivered to a log group, and its `TRACES`, delivered to X-Ray.
- X-Ray's OTLP endpoint in the GPU job definition.
- The `<prefix>-agents` dashboard: invocations, latency, errors, jobs, tokens, cost, tool calls and GPU jobs.

The stack outputs `DashboardUrl`, `GenAiObservabilityUrl`, `WorkerLogGroup`, `ApiLogGroup`, `SpansLogGroup` and
`MemoryLogGroup`. When `observability.enabled` is false, the runtimes get `DISABLE_ADOT_OBSERVABILITY=true` and
`OTEL_SDK_DISABLED=true`, and nothing else is created.

**In CloudWatch GenAI Observability** (CloudWatch → GenAI Observability → Bedrock AgentCore), the two runtimes appear
as agents with their sessions, traces, latency, errors and token use. A session is one AgentCore runtime session. For
the worker, that is one work item at one head (`trace-<owner>-<repo>-<number>-<sha12>`, from `src/agent/dispatch.ts`).
Its trace runs from the invocation through the job and Claude's turns down to each tool call, MCP tools included, and
any GPU job.

**To see one session's trace:** open the worker agent in GenAI Observability, choose **Sessions**, and pick the
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
| `src/infra` | The CDK stack (AgentCore runtimes, Cognito, the central bucket, the image builds, GitHub OIDC, the AWS Batch GPU queue in `gpu.ts`) |
| `src/installer` | `trace install`: the local web installer |
| `src/agent`, `src/api`, `agent/Dockerfile` | The image AgentCore runs: the worker, and the people-facing API |
| `src/login` | `trace login`, `trace remote …`, `trace users …` |
| `src/harness` | The loop's logic, bundled into `harness/dist` for the GitHub actions in `harness/actions` |
| `src/calc`, `src/kicad`, `src/pcb`, `src/sim`, `src/datasheets`, `src/parts`, `src/hil`, `src/firmware`, `src/runs` | The tools |
| `src/gpu`, `agent/Dockerfile.gpu` | GPU jobs: local or AWS Batch (`runJob`, `runBatch`), the in-container runner, and its image |
| `python/kicad`, `python/orthoroute` | The scripts the autorouter jobs run: Freerouting through KiCad's pcbnew, and OrthoRoute's headless mode |
| `python/tracebridge` | The only Python, used where Node has no maintained equivalent: PDF tables and figures (pdfplumber), VISA instruments (pyvisa), and CAN vendor interfaces (python-can) |
| `templates` | What onboarding writes: workflows, starter builds, scaffolds, the empty rules |

Develop with `npm ci && npm run check`. The Python bridge has its own setup: `pip install -e 'python[dev]' && pytest python/tests`.
