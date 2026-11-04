# Hosted Kudo MCP endpoint (Streamable HTTP, unsigned only).
# Build from the repository root so the SDK workspace is in context:
#   docker build -f packages/mcp/Dockerfile -t kudo-mcp .
#   docker run -p 3333:3333 kudo-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/plugin-kudo/package.json packages/plugin-kudo/
RUN npm ci --workspace @kudo-dev/sdk --workspace @kudo-dev/mcp --include-workspace-root=false
COPY packages/sdk packages/sdk
COPY packages/mcp packages/mcp
RUN npm run build -w @kudo-dev/sdk && npm run build -w @kudo-dev/mcp \
 && npm prune --omit=dev --workspace @kudo-dev/sdk --workspace @kudo-dev/mcp

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3333 KUDO_MCP_TRUST_PROXY=1
COPY --from=build /app /app
USER node
EXPOSE 3333
CMD ["node", "packages/mcp/dist/bin.js", "--http"]
