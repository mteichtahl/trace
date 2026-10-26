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
