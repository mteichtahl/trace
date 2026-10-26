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
python3 with a venv holding the bridge (`/app/python[pdf]`), ngspice, iverilog, poppler-utils, ffmpeg, Blender (Ubuntu's package; Cycles renders on the CPU, and the bpy scripts are in `/app/python/blender`, copied in with the repository), and KiCad 10 from
`ppa:kicad/kicad-10.0-releases`. That PPA publishes arm64 builds for noble (10.0.7 as of 2026-10-26). If it can't be
installed, the build falls back to Ubuntu's own `kicad`. The image runs as the non-root user `trace`, and its entry
point is `node --require …/aws-distro-opentelemetry-node-autoinstrumentation/build/src/register.js /app/dist/agents/runtime/main.js`:
ADOT registers the OpenTelemetry SDK first (README "Observability"). The job hands the trace MCP server its trace
context (`TRACEPARENT`) and the same `--require`, so tool calls join the job's trace.

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
pushed to the `<prefix>-gpu` ECR repository. It is based on `nvidia/cuda:12.9.2-runtime-ubuntu24.04` with
`NVIDIA_DRIVER_CAPABILITIES=all` (OptiX needs the graphics libraries), and contains:

- Node 22 and the trace dist; the job's command is `node /app/dist/gpu/runner.js`, which reads the spec from the S3
  object `TRACE_GPU_JOB_URI` names, downloads the inputs, runs the program, and uploads the outputs, both logs
  and the exit record. `TRACE_GPU=1` is set, so a job inside never ships itself again.
- Blender 5.2.3, the official build from download.blender.org (sha256-checked): Cycles on CUDA/OptiX, OpenImageDenoise,
  and its bundled Python with numpy (glTF import).
- Java 25 (Ubuntu's `openjdk-25-jre-headless`) and Freerouting 2.5.0 at `/opt/freerouting/freerouting.jar`
  (sha256-checked). Freerouting is CPU-only; on the GPU host it uses the instance's cores.
- OrthoRoute v1.0.0 (commit f2dd80c) at `/opt/orthoroute`, with a venv at `/opt/orthoroute/venv` holding numpy,
  scipy, psutil and `cupy-cuda12x`. OrthoRoute is the router that uses the GPU.
- KiCad 10 from the PPA: `kicad-cli`, and the `pcbnew` Python module for the Specctra DSN export and SES import.

The compute environment uses the ECS Amazon Linux 2023 NVIDIA AMI on g6/g5/g4dn `.xlarge` instances, scales from
0 vCPUs, and lives in a small VPC with public subnets only (no NAT gateway). Each job asks for 1 GPU, 4 vCPUs and
14 GiB. Its role can read and write only the bucket's `jobs/` prefix.
