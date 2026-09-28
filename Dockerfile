# tcop-eval-pi-acp: ACP stdio runtime for the pi coding agent (fork of georgeharker/pi-acp)
FROM node:22-bookworm-slim

ENV HOME=/root \
    PI_ACP=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pi coding agent and its MCP adapter. The adapter must live under /root/.pi/agent/npm/node_modules
# so pi-home.ts can reference it by absolute path without hitting the network at runtime.
RUN npm install -g @earendil-works/pi-coding-agent \
    && pi install npm:pi-mcp-adapter

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build \
    && mkdir -p /opt/pi-eval-acp \
    && cp -r dist node_modules /opt/pi-eval-acp/
