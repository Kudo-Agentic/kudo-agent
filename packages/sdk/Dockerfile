# One agent's image. Build from the repository root, naming the agent's folder:
#   docker build -f packages/sdk/Dockerfile --build-arg AGENT=agents/shinichi -t kudo-shinichi .
#
# Each agent gets its own image and digest, so its Trust Center report covers
# exactly the code and prompts that agent runs.
#
# cast comes from the official Foundry image rather than being installed at
# runtime: an agent that has to bootstrap its own toolchain fails slowly, mid
# conversation, and produces an image whose attestation says less about what it
# can do.
#
# Pinned by digest, not tag: Foundry's CLI flags drift between releases, and a
# moving tag would mean two builds of this Dockerfile produce different images —
# which is what the Trust Center report is supposed to rule out. This is the
# multi-arch index digest for `stable`, so it resolves on amd64 and arm64 alike.
FROM ghcr.io/foundry-rs/foundry:stable@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46 AS foundry

FROM node:22-slim AS build
ARG AGENT
RUN test -n "$AGENT" || { echo "pass --build-arg AGENT=agents/<name>"; exit 1; }
WORKDIR /app
# `npm ci` installs exactly the lockfile, so the same source produces the same
# dependency tree every build. npm needs every workspace's package.json to read
# the shared lockfile.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/tools/package.json packages/tools/
COPY packages/mcp/package.json packages/mcp/
COPY packages/plugin-kudo/package.json packages/plugin-kudo/
COPY agents/shinichi/package.json agents/shinichi/
COPY agents/megure/package.json agents/megure/
RUN npm ci --workspace packages/sdk --workspace "$AGENT" --include-workspace-root=false
COPY packages/sdk packages/sdk
RUN npm run build -w @kudo-dev/sdk \
 && npm prune --omit=dev --workspace packages/sdk --workspace "$AGENT" --include-workspace-root=false
COPY ${AGENT} ${AGENT}

FROM node:22-slim
ARG AGENT
# curl for ad-hoc debugging; ca-certificates for HTTPS RPC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Verify this path against the tag you pin:
#   docker run --rm --entrypoint sh ghcr.io/foundry-rs/foundry:latest -c 'command -v cast'
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
COPY --from=build /app /app
# Fail the build rather than the first covenant if cast is missing or broken,
# or if the SDK's bundled skills did not ship.
RUN cast --version && test -f /app/packages/sdk/skills/kudo/SKILL.md

WORKDIR /app/${AGENT}
ENV NODE_ENV=production
EXPOSE 3000
# The local binary, not `npx`: npx falls back to downloading a missing package
# at container start, which would put the agent's own runtime outside the image
# the attestation covers — and would need npm reachable from inside the TEE.
ENTRYPOINT ["/app/node_modules/.bin/tsx", "index.ts"]
