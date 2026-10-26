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
- **People:** the first administrator, everyone else, and each person's read or write access per project.

It then shows the plan and runs it:

- **AWS (CDK):** one stack. It contains the central bucket, the GitHub token's secret, the agent image (built by
  CodeBuild on arm64, so no local Docker is needed), and two AgentCore runtimes from that image. The worker runtime
  is invoked by the repositories' workflows through IAM. The API runtime is for people and is reached only with a
  Cognito sign-in. The stack also holds the Cognito user pool and the GitHub OIDC role the repositories' workflows
  assume.
- **GitHub:** each repository's Actions variables (`TRACE_AWS_ROLE`, `TRACE_AWS_REGION`, `TRACE_HOME`,
  `TRACE_AGENT_RUNTIME_ARN`) and its `TRACE_TOKEN` secret (encrypted with the repository's key), plus the onboarding
  pull request.
- **People:** Cognito invitations, and grants recorded in the central database.

Tokens and keys stay in the installer's memory. They are written only to Secrets Manager and GitHub. Every step can
be run again safely, and running the installer again updates an existing installation.

## People and permissions

Everyone signs in with Amazon Cognito (`trace login`). Each person holds **read** or **write** on each project:

- **read**: see the project's status, settings, runs and artifacts, and use the read-only tools.
- **write**: everything read allows, plus change settings, give the agents work (`trace remote task`), and use tools
  that record runs.

A person with no grant on a project cannot tell that it exists. Members of `trace-admins` hold write on every project
and are the only ones who grant and revoke: `trace users invite|grant|revoke|grants`. Every request to the API runtime
is checked against these grants. The repositories' own workflows reach only the worker runtime, through IAM, so a
person's sign-in never acts as the loop, and the loop never acts as a person.

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

## Layout

| Path | What |
| --- | --- |
| `src/core` | Settings, SQLite stores, the tool registry, the MCP server, onboarding, access control, the Python bridge client |
| `src/infra` | The CDK stack (AgentCore runtimes, Cognito, the central bucket, the image build, GitHub OIDC) |
| `src/installer` | `trace install`: the local web installer |
| `src/agent`, `src/api`, `agent/Dockerfile` | The image AgentCore runs: the worker, and the people-facing API |
| `src/login` | `trace login`, `trace remote …`, `trace users …` |
| `src/harness` | The loop's logic, bundled into `harness/dist` for the GitHub actions in `harness/actions` |
| `src/calc`, `src/kicad`, `src/sim`, `src/datasheets`, `src/parts`, `src/hil`, `src/firmware`, `src/runs` | The tools |
| `python/tracebridge` | The only Python, used where Node has no maintained equivalent: PDF tables and figures (pdfplumber), VISA instruments (pyvisa), and CAN vendor interfaces (python-can) |
| `templates` | What onboarding writes: workflows, starter builds, scaffolds, the empty rules |

Develop with `npm ci && npm run check`. The Python bridge has its own setup: `pip install -e 'python[dev]' && pytest python/tests`.
