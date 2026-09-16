FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agent-harness-runtime
COPY runtime/opencode/package.json runtime/opencode/package-lock.json ./
RUN npm ci --omit=dev
COPY runtime/opencode/plugin.mjs runtime/opencode/coordinator.mjs ./
RUN mkdir -p /workspace /opt/agent-harness-config/opencode && chown node:node /workspace && touch /opt/agent-harness-config/opencode/.gitignore
ENV PATH="/opt/agent-harness-runtime/node_modules/.bin:${PATH}"
USER node
ENTRYPOINT ["node", "/opt/agent-harness-runtime/coordinator.mjs"]
