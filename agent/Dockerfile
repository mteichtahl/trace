# The trace agent for Amazon Bedrock AgentCore Runtime (linux/arm64 only).
# Built by AWS CodeBuild from the CDK stack, with the repository root as the context:
#   docker buildx build --platform linux/arm64 -f agent/Dockerfile .
# One image serves both runtimes: TRACE_AGENT_MODE=worker (default) or api. See agent/README.md.
FROM --platform=linux/arm64 ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

# Base tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssh-client jq unzip xz-utils \
      build-essential python3 python3-venv python3-pip ngspice iverilog poppler-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Node 22 (NodeSource), the GitHub CLI (its apt repository) and KiCad 10 (ppa:kicad/kicad-10.0-releases, which builds
# arm64 for noble). The PPA is added by hand: add-apt-repository needs software-properties and a keyserver round trip.
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xFDA854F61C4D0D9572BB95E5245D5502FAD7A805" | gpg --dearmor -o /etc/apt/keyrings/kicad.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/kicad.gpg] https://ppa.launchpadcontent.net/kicad/kicad-10.0-releases/ubuntu noble main" > /etc/apt/sources.list.d/kicad-10.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs gh \
 && (apt-get install -y --no-install-recommends kicad kicad-symbols kicad-footprints \
     || (echo "KiCad 10 from the PPA is not installable here: falling back to Ubuntu's kicad" \
         && rm /etc/apt/sources.list.d/kicad-10.list && apt-get update \
         && apt-get install -y --no-install-recommends kicad kicad-symbols kicad-footprints)) \
 && kicad-cli version \
 && node --version && gh --version \
 && rm -rf /var/lib/apt/lists/*

# --- Blender (the rendering agent: src/render drives bpy scripts in /app/python/blender; Cycles on the CPU, no GPU).
RUN apt-get update && apt-get install -y --no-install-recommends blender && blender --version && rm -rf /var/lib/apt/lists/*
# --- end Blender

# A non-root user owns the app's runtime state; the workspace is /mnt/workspace (AgentCore session storage) when
# mounted, else /tmp/trace-work.
RUN useradd --create-home --uid 10001 --shell /bin/bash trace \
 && install -d -o trace -g trace /tmp/trace-work /home/trace/.trace

WORKDIR /app

# Dependencies first (cached while package*.json are unchanged); scripts skipped until the sources are in.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && npm rebuild \
 && python3 -m venv /opt/trace-venv \
 && /opt/trace-venv/bin/pip install --no-cache-dir '/app/python[pdf]' \
 && { test -d /app/python/blender || echo "note: /app/python/blender is not in the build context yet"; } \
 && ln -s /app/dist/cli.js /usr/local/bin/trace && chmod +x /app/dist/cli.js \
 && chown -R trace:trace /app

ENV PATH=/opt/trace-venv/bin:$PATH \
    TRACE_PYTHON=/opt/trace-venv/bin/python \
    TRACE_CLI=/app/dist/cli.js \
    HOME=/home/trace \
    NODE_ENV=production \
    PORT=8080

USER trace
EXPOSE 8080
CMD ["node", "/app/dist/agent/main.js"]
