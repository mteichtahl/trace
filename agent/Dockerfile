# The trace agent for Amazon Bedrock AgentCore Runtime (linux/arm64 only).
# Built by AWS CodeBuild from the CDK stack, with the repository root as the context:
#   docker buildx build --platform linux/arm64 -f agent/Dockerfile .
# One image serves both runtimes: TRACE_AGENT_MODE=worker (default) or api. See agent/README.md.
#
# Three stages, so the image AgentCore runs holds each file once (AgentCore Runtime refuses an image over 2 GB:
# "maxImageSizeMb limit exceeded"):
#   tools  the system packages every stage needs: the tools the agents run here, and the compilers the build uses
#   build  npm ci with the dev dependencies, the build, the prune, and the Python venv; left behind
#   final  tools, with the built /app and the venv copied in, already owned by the trace user (a `chown -R` in a
#          layer of its own would store every file of /app a second time)
FROM --platform=linux/arm64 ubuntu:24.04 AS tools

ARG DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

# Base tools. build-essential and verilator: the mixed-signal co-simulation (src/tools/ams/mixed.ts) builds a
# Verilator model into ngspice's d_cosim in this process, so both stay here. Everything larger (KiCad, Blender, the FPGA
# and formal tools, CalculiX, ffmpeg) is in the tools image (agent/Dockerfile.tools), which each project's tools
# function runs: AgentCore Runtime refuses an image over 2 GB, and the build checks this one is under it
# (src/infra/images.ts AGENT_IMAGE_MAX_BYTES).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssh-client jq unzip xz-utils \
      build-essential python3 python3-venv python3-pip ngspice verilator poppler-utils \
 && verilator --version \
 && rm -rf /var/lib/apt/lists/*

# Node 22 (NodeSource) and the GitHub CLI (its apt repository).
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs gh \
 && node --version && gh --version \
 && rm -rf /var/lib/apt/lists/*

# A non-root user owns the app's runtime state; the workspace is /mnt/workspace (AgentCore session storage) when
# mounted, else /tmp/trace-work.
RUN useradd --create-home --uid 10001 --shell /bin/bash trace \
 && install -d -o trace -g trace /tmp/trace-work /home/trace/.trace

# ------------------------------------------------------------------ build: the app and its Python venv
FROM tools AS build
WORKDIR /app

# Dependencies first (cached while package*.json are unchanged); scripts skipped until the sources are in.
# agent/package-lock.json and agent/npmrc: copies scripts/stage-image.mjs makes (npm never packs the originals, so an
# installed trace has only these)
COPY package.json agent/package-lock.json agent/npmrc ./
RUN mv npmrc .npmrc
RUN npm ci --ignore-scripts
# Python.h, for a dependency pip may have to build from source (the venv below); the build stage's only
RUN apt-get update && apt-get install -y --no-install-recommends python3-dev && rm -rf /var/lib/apt/lists/*

COPY . .
# build:image: everything `npm run build` makes but the installer page (scripts/bundle-ui.mjs), which only `tracectl
# install` serves, and which needs the web app's components (web/src), left out of the image's source
# The Claude Agent SDK installs its native binary for both C libraries of this platform; Ubuntu's is glibc, and the
# SDK takes the glibc one first there, so the musl one (about 270 MB) is never run. The CDK (aws-cdk-lib and the CLI,
# about 210 MB) is what the installer deploys with, from a laptop or CodeBuild, never from a runtime:
# scripts/check-imports.mjs fails the build if anything a runtime loads imports it.
RUN npm run build:image \
 && npm prune --omit=dev \
 && npm rebuild \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl \
 && rm -rf node_modules/aws-cdk-lib node_modules/aws-cdk node_modules/@aws-cdk node_modules/constructs \
 && node scripts/check-imports.mjs dist/agents/runtime/main.js dist/cli.js dist/gpu/runner.js \
 && test -x node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude \
 && chmod +x /app/dist/cli.js \
 && python3 -m venv /opt/trace-venv \
 && /opt/trace-venv/bin/pip install --no-cache-dir '/app/python[pdf]'

# ------------------------------------------------------------------ final: what AgentCore runs
FROM tools
WORKDIR /app
COPY --from=build --chown=trace:trace /app /app
# the venv at the same path it was made at (its scripts name /opt/trace-venv/bin/python)
COPY --from=build /opt/trace-venv /opt/trace-venv
RUN ln -s /app/dist/cli.js /usr/local/bin/tracectl && ln -s tracectl /usr/local/bin/trace

ENV PATH=/opt/trace-venv/bin:$PATH \
    TRACE_PYTHON=/opt/trace-venv/bin/python \
    TRACE_CLI=/app/dist/cli.js \
    TRACE_TOOLS_ELSEWHERE=1 \
    HOME=/home/trace \
    NODE_ENV=production \
    PORT=8080

USER trace
EXPOSE 8080
# AgentCore observability: the ADOT auto-instrumentation (@aws/aws-distro-opentelemetry-node-autoinstrumentation, a
# pinned dependency) registers the OpenTelemetry SDK before the agent starts. AgentCore Runtime supplies its OTEL_*
# settings (AGENT_OBSERVABILITY_ENABLED, OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_LOGS_HEADERS, …): spans go to
# X-Ray (CloudWatch Transaction Search), metrics to CloudWatch as EMF. To run the image anywhere else without
# exporting, set OTEL_SDK_DISABLED=true. See the README's "Observability".
RUN test -f /app/node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/build/src/register.js
CMD ["node", "--require", "/app/node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/build/src/register.js", "/app/dist/agents/runtime/main.js"]
