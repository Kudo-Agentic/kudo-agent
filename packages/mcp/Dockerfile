# Hosted Kudo MCP endpoint (Streamable HTTP, unsigned only).
# Build from the repository root so the SDK workspace is in context:
#   docker build -f packages/mcp/Dockerfile -t kudo-mcp .
#   docker run -p 3333:3333 kudo-mcp
# Behind a reverse proxy that sets X-Forwarded-For, add -e KUDO_MCP_TRUST_PROXY=1
# so the rate limit keys on the real client. Never set it without a proxy: the
# caller would choose its own rate-limit key.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/tools/package.json packages/tools/
COPY packages/mcp/package.json packages/mcp/
COPY packages/plugin-kudo/package.json packages/plugin-kudo/
RUN npm ci --workspace @kudo-dev/sdk --workspace @kudo-dev/tools --workspace @kudo-dev/mcp --include-workspace-root=false
COPY packages/sdk packages/sdk
# The private tools package is compiled into the MCP build.
COPY packages/tools packages/tools
COPY packages/mcp packages/mcp
RUN npm run build -w @kudo-dev/sdk && npm run build -w @kudo-dev/mcp \
 && npm prune --omit=dev --workspace @kudo-dev/sdk --workspace @kudo-dev/mcp

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3333
COPY --from=build /app /app
USER node
EXPOSE 3333
CMD ["node", "packages/mcp/dist/bin.js", "--http"]
