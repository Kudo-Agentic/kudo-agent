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

FROM node:22-slim

# curl for ad-hoc debugging; ca-certificates for HTTPS RPC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Verify this path against the tag you pin:
#   docker run --rm --entrypoint sh ghcr.io/foundry-rs/foundry:latest -c 'command -v cast'
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast

WORKDIR /app

# `npm ci` installs exactly the lockfile, so the same source produces the same
# dependency tree every build. `npm install` would resolve semver ranges afresh
# and quietly change what ends up inside an attested image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
# Every character ships in the image, and AGENT picks one at runtime. Baking a
# single agent in would mean four images and four digests, and the attestation
# would then cover one character instead of the set.
COPY agents ./agents
COPY .claude ./.claude

# Fail the build rather than the first covenant if cast is missing or broken.
RUN cast --version

ENV NODE_ENV=production
EXPOSE 3000
# The local binary, not `npx`: npx falls back to downloading a missing package
# at container start, which would put the agent's own runtime outside the image
# the attestation covers — and would need npm reachable from inside the TEE.
ENTRYPOINT ["./node_modules/.bin/tsx", "src/main.ts"]
