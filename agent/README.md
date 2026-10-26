# trace agent (Bedrock AgentCore Runtime)

The container the repositories' worker items run in, instead of claude-code-action in GitHub Actions
(setting `worker.runner`: `agentcore`, the default, or `actions`). The trace-worker workflow's `pick` job claims items as
before; its `dispatch` job (task `worker-dispatch`) sends each item here with InvokeAgentRuntime and comments
"Dispatched to the trace agent on AgentCore (job …)" on it.

One image, two runtimes, selected by `TRACE_AGENT_MODE`:

- `worker` (default): IAM-authenticated, invoked only by the workflows. `src/agent/server.ts`.
- `api`: Cognito-JWT-authenticated, for people. `src/api/server.ts` (`start()`), which reuses the job machinery
  in-process (`startJob`, `jobStatus` and the payload schemas from `src/agent/jobs.ts`).

## Contract (worker mode, 0.0.0.0:8080)

- `GET /ping` returns `{"status":"Healthy"}`, or `"HealthyBusy"` while any job runs, so the session is kept alive.
- `POST /invocations` takes JSON (zod, `src/agent/schemas.ts`):
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

The workflows need these repository variables: `TRACE_AWS_ROLE` (allowed `bedrock-agentcore:InvokeAgentRuntime`),
`TRACE_AWS_REGION` and `TRACE_AGENT_RUNTIME_ARN`.

## The image

`agent/Dockerfile`, built for linux/arm64 with the repository root as the context. AWS CodeBuild builds it from the
CDK stack, so no local Docker is needed. It contains Ubuntu 24.04, Node 22 (NodeSource), git, the GitHub CLI,
python3 with a venv holding the bridge (`/app/python[pdf]`), ngspice, iverilog, poppler-utils, ffmpeg, Blender (Ubuntu's package; Cycles renders on the CPU, and the bpy scripts are in `/app/python/blender`, copied in with the repository), and KiCad 10 from
`ppa:kicad/kicad-10.0-releases`. That PPA publishes arm64 builds for noble (10.0.7 as of 2026-10-26). If it can't be
installed, the build falls back to Ubuntu's own `kicad`. The image runs as the non-root user `trace`, and its entry
point is `node /app/dist/agent/main.js`.
