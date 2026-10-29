# trace agent (Bedrock AgentCore Runtime)

The container the repositories' worker items run in, instead of claude-code-action in GitHub Actions
(setting `worker.runner`: `agentcore`, the default, or `actions`). The trace-worker workflow's `pick` job claims items as
before; its `dispatch` job (task `worker-dispatch`) sends each item here with InvokeAgentRuntime and comments
"Dispatched to the trace agent on AgentCore (job …)" on it.

One image, two runtimes, selected by `TRACE_AGENT_MODE`:

- `worker` (default): IAM-authenticated, invoked only by the workflows. `src/agents/runtime/server.ts`.
- `api`: Cognito-JWT-authenticated, for people. `src/api/server.ts` (`start()`), which reuses the job machinery
  in-process (`startJob`, `jobStatus` and the payload schemas from `src/agents/runtime/jobs.ts`).

## Contract (worker mode, 0.0.0.0:8080)

- `GET /ping` returns `{"status":"Healthy"}`, or `"HealthyBusy"` while any job runs, so the session is kept alive.
- `POST /invocations` takes JSON (zod, `src/agents/runtime/schemas.ts`):
  - `{ "kind": "work-item", "repository": "owner/repo", "item": WorkItem, "runUrl"?: url }` (WorkItem is the
    harness's `{kind: ci-red|conflict|agent-fix, number, sha, ref, own, title}`)
  - `{ "kind": "sweep", "repositories": ["owner/repo", …] }`: the hourly backstop. Runs worker-pick for each
    repository whose `worker.runner` is agentcore (same `<!-- trace-claim -->` and attempt markers, so nothing is
    claimed twice), then starts one work-item job per claimed item.
  - `{ "kind": "task", "repository", "request", "requestedBy", "branch"?, "issue"? }`: a person's request, done on
    `claude/task-<slug>` off the default branch and pushed (the PR opens itself).
  - `{ "kind": "status", "jobId"? }` returns `{ jobs: [...], busy }`.

  Work starts in the background, and the answer comes back at once as `{ "accepted": true, "jobId" }`. A second
  invocation for an item that is already running gets `{ "accepted": false, "jobId": <running job>, "reason" }`.
- SIGTERM aborts Claude in every running job, posts their failure comments and exits.

Per item, the job reads the GitHub token from Secrets Manager. The token reaches git only as an `http.extraHeader`
passed through `GIT_CONFIG_*` environment variables, never in argv, a URL or a config file, and it is redacted from
the logs. The job then clones the default branch (its `.trace/project.db` supplies the settings), checks out the
item's branch, and sets the git identity and the `trace-db` merge driver. Next it runs Claude through the Agent SDK
with the harness's `promptFor` prompt, the trace MCP server and `bypassPermissions` (the container is the sandbox),
using `worker.max_turns` and a timeout below the 8-hour `maxLifetime`. If Claude left no comment, the job posts a
final one (`<!-- trace-agent-done: <jobId> -->`), including any failure reason. Clones are deleted afterwards, except
under `/mnt/workspace`, where they are kept and fetched next time.

## Environment

| variable | |
|---|---|
| `AWS_REGION` | region for Secrets Manager and Bedrock |
| `TRACE_GITHUB_SECRET_ARN` | Secrets Manager secret whose string is the GitHub token (`{"token": …}` also accepted) |
| `CLAUDE_CODE_USE_BEDROCK=1` | Claude through Bedrock |
| `ANTHROPIC_MODEL` | the model (else `worker.model`, else the SDK's default) |
| `TRACE_HOME` | the central trace database (directory or `s3://bucket/prefix`) |
| `TRACE_WORKSPACE` | optional; clones go here (default `/mnt/workspace/trace` when mounted, else `/tmp/trace-work`) |
| `TRACE_AGENT_MODE` | `worker` (default) or `api` |
| `TRACE_JOB_TIMEOUT_S` | optional; Claude's time limit per job (default 27000 s, capped at 28200 s) |
| `AGENT_OBSERVABILITY_ENABLED` | `true` (set by the stack): ADOT exports for AgentCore observability. AgentCore Runtime itself supplies `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS` and the rest of ADOT's defaults; the agent logs one `telemetry:` line at start saying whether they are there |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `false` (set by the stack): no prompts or completions on spans |
| `DISABLE_ADOT_OBSERVABILITY`, `OTEL_SDK_DISABLED` | `true` (set by the stack when `observability.enabled` is false): no telemetry |

The workflows need these repository variables: `TRACE_AWS_ROLE` (allowed `bedrock-agentcore:InvokeAgentRuntime`),
`TRACE_AWS_REGION` and `TRACE_AGENT_RUNTIME_ARN`.

## The image

`agent/Dockerfile`, built for linux/arm64 with the repository root as the context. AWS CodeBuild builds it from the
CDK stack, so no local Docker is needed. It contains Ubuntu 24.04, Node 22 (NodeSource), git, the GitHub CLI,
python3 with a venv holding the bridge (`/app/python[pdf]`), ngspice, Verilator with g++ (the mixed-signal
co-simulation builds a Verilator model into ngspice's `d_cosim` in this process: `src/tools/ams/mixed.ts`) and
poppler-utils. The image runs as the non-root user `trace`, and its entry point is
`node --require …/aws-distro-opentelemetry-node-autoinstrumentation/build/src/register.js /app/dist/agents/runtime/main.js`:
ADOT registers the OpenTelemetry SDK first (README "Observability"). The job hands the trace MCP server its trace
context (`TRACEPARENT`) and the same `--require`, so tool calls join the job's trace.

**At most 2 GB.** AgentCore Runtime refuses a larger image ("maxImageSizeMb limit exceeded"; the limit is not
adjustable), so the build fails first when the image is over `AGENT_IMAGE_MAX_BYTES` (2,000,000,000 bytes unpacked,
`src/infra/images.ts`), printing its largest layers. To stay under it the image leaves out the CDK (aws-cdk-lib and
the CLI, about 210 MB: only the installer deploys, never a runtime; `scripts/check-imports.mjs` fails the build if
anything a runtime loads imports it), the Agent SDK's musl binary, and the large programs, which are in the tools
image below. `TRACE_TOOLS_ELSEWHERE=1` says so: a job for one of them goes to the project's tools function, else to
the queue.

## The tools image and the tools function

`agent/Dockerfile.tools` (linux/arm64) holds what the agent image cannot: KiCad 10 with its symbol and footprint
libraries (`ppa:kicad/kicad-10.0-releases`, falling back to Ubuntu's `kicad`), Blender (Ubuntu's package, Cycles on the
CPU, with the bpy scripts in `/app/python/blender`), Verilator, Yosys, nextpnr (ice40, ECP5, Gowin), the IceStorm and
Trellis packers, z3 and SymbiYosys, iverilog with cocotb 2.1.0 and apycula 0.10.0 in a venv, CalculiX ccx 2.21 and
ffmpeg, with Node 22 and the job runner. About 4–5 GB; Lambda takes images up to 10 GB.

Each project has its own **tools function** running it (`src/infra/tools.ts`, nested layout only): an AWS Lambda
function `<prefix>-tools-<hash>`, arm64, 15 minutes, `tools.memoryMb` (4096) and `tools.ephemeralMb` (10240) of `/tmp`.
Its role reads and writes the project's `jobs/<slug>/` and its own log group, nothing else, and the project's worker
may invoke it and no other function. `runJob` (`src/gpu/jobs.ts backendFor`) sends it the job kinds it has
(`FUNCTION_KINDS`: kicad, ffmpeg, blender, verilator, cocotb, formal, yosys, nextpnr, fpga-pack, calculix) when
`TRACE_TOOLS_FUNCTION` is set, unless the job wants the queue (a GPU render with a GPU queue, or `remote`). A job runs
over the same S3 protocol as a Batch job (`jobs/<slug>/<id>/`): `src/gpu/function.ts` stages it and invokes the
function synchronously with the spec's address; `src/gpu/lambda.ts`, a small custom runtime, runs `src/gpu/runner.ts`
on it. A job gets at most 840 s (`FUNCTION_MAX_SECONDS`), so the upload still fits in Lambda's 900 s.

kicad-cli goes through it as kind `kicad` (`src/tools/kicad/remote.ts`): the project's KiCad files under its
repository (its sheets, rules, library tables and the libraries they name, 3D and SPICE models; at most 1 GB, no
backups, hidden folders or node_modules) travel as one archive, `src/gpu/kicad-job.ts` runs kicad-cli on the unpacked
copy, and the output comes back where the caller asked, with the job's folders replaced by the caller's in its text
files. A render's frames become the turntable video as an `ffmpeg` job the same way.

In the flat layout the tools functions are all in one nested stack of their own, `ToolsStack`
(`src/infra/tools.ts FlatToolsStack`, with the tools image's build): the flat stack has no room for four more
resources per project, but has for that one, except at 20 flat projects with everything on. There, the stack is left
out and those jobs go to the queue (`agent/Dockerfile.gpu` has the same programs), or are unavailable without
`gpu.enabled`; moving to the nested layout gives each project its function.

What a call costs is in the project's ledger as kind `tools` (`src/core/cost.ts`): Lambda's billed duration (from
the call's REPORT line, a cold start included) x the function's memory and its `/tmp` over 512 MB, and the call, at
Lambda's arm64 prices (`cost.prices.tools` overrides them). Its job's span (`trace.gpu.run <kind>`) goes to X-Ray as
the Batch jobs' do, in the worker's trace, under the service `<prefix>-tools`.

An input of 1 MB or more (a KiCad project's archive, usually) is stored once a week by its content under
`jobs/<slug>/cache/` (`src/gpu/protocol.ts`): a call that sends the same bytes again looks for it instead of uploading
it, and a warm function keeps it in its `/tmp` (at most 3 GB), so it isn't downloaded again either.

## The GPU job image

AgentCore runtimes have no GPU, so heavy jobs go to AWS Batch: `runJob` (`src/gpu/jobs.ts`) runs a job here when
this machine has a GPU (or the job does not want one), and otherwise, when `TRACE_GPU_QUEUE` is set, ships it with
`runBatch` (`src/gpu/batch.ts`). The stack sets these on both runtimes:

| variable | |
|---|---|
| `TRACE_GPU_QUEUE` | the Batch job queue's ARN |
| `TRACE_GPU_JOB_DEFINITION` | the job definition's name (its latest revision is used) |
| `TRACE_GPU_BUCKET` | the central bucket; jobs are staged under `jobs/<project>/<id>/` (`in/`, `out/`, `log/`, `exit`), expired after 7 days |
| `TRACE_GPU_REMOTE` | optional: `always` ships every job, `never` runs every job here |
| `TRACE_GPU_QUEUE_WAIT_S` | optional: how long a job may wait for an instance before it is terminated (default 1800 s) |
| `TRACE_CPU_QUEUE` | the CPU job queue's ARN: jobs that don't want a GPU go here (else to the GPU queue) |
| `TRACE_CPU_JOB_DEFINITION` | the project's CPU job definition |
| `TRACE_GPU_JOB_MAX_VCPUS` / `TRACE_CPU_JOB_MAX_VCPUS` | the cap for a job's `vcpus` hint on each queue; without it the hint is ignored |

`agent/Dockerfile.gpu` is built for linux/amd64 by CodeBuild (the same custom resource as the agent image) and
pushed to the `<prefix>-gpu` ECR repository. It is based on `nvcr.io/nvidia/cuda:12.9.2-runtime-ubuntu24.04` (NVIDIA's registry: no Docker Hub pull limit) with
`NVIDIA_DRIVER_CAPABILITIES=all` (OptiX needs the graphics libraries), and contains:

- Node 22 and the trace dist; the job's command is `node /app/dist/gpu/runner.js`, which reads the spec from the S3
  object `TRACE_GPU_JOB_URI` names, downloads the inputs, runs the program, and uploads the outputs, both logs
  and the exit record. `TRACE_GPU=1` is set, so a job inside never ships itself again.
- Blender 5.2.3, the official build from download.blender.org or its official mirrors (sha256-checked): Cycles on CUDA/OptiX, OpenImageDenoise,
  and its bundled Python with numpy (glTF import).
- Java 25 (Ubuntu's `openjdk-25-jre-headless`) and Freerouting 2.5.0 at `/opt/freerouting/freerouting.jar`
  (sha256-checked). Freerouting is CPU-only; on the GPU host it uses the instance's cores.
- OrthoRoute v1.0.0 (commit f2dd80c) at `/opt/orthoroute`, with a venv at `/opt/orthoroute/venv` holding numpy,
  scipy, psutil and `cupy-cuda12x`. OrthoRoute is the router that uses the GPU.
- KiCad 10 from the PPA: `kicad-cli`, and the `pcbnew` Python module for the Specctra DSN export and SES import.
- ffmpeg, and the verification and FPGA tools: every kind the tools image runs, so a job too long for the tools
  function, or from a project without one, runs here.
- CalculiX ccx 2.21 (`calculix-ccx 2.21-1`) for the thermal FEM path (runJob kind `calculix`).
- ESI-OpenCFD OpenFOAM v2412 (`openfoam2412 2412.260127-1` and `-common`, from dl.openfoam.com for noble/amd64,
  with Open MPI) for the thermal CFD path (runJob kind `openfoam`: `chtMultiRegionSimpleFoam`/`chtMultiRegionFoam`,
  snappyHexMesh, splitMeshRegions, foamToVTK). `OPENFOAM_BASHRC` points at its `etc/bashrc`. **Image size:** about
  320 MB installed for OpenFOAM itself (the .deb is 65 MB), plus Open MPI and (PT-)Scotch, roughly 0.4 GB more image;
  ParaView and the tutorials are not installed. CalculiX adds about 18 MB. The versions are pinned; the package's
  sha256 is in the Dockerfile's comment.

The compute environment uses the ECS Amazon Linux 2023 NVIDIA AMI on g6/g5/g4dn `.xlarge` instances, scales from
0 vCPUs, and lives in a small VPC with public subnets only (no NAT gateway). Each job asks for 1 GPU, 4 vCPUs and
14 GiB. Its role can read and write only the bucket's `jobs/` prefix.
