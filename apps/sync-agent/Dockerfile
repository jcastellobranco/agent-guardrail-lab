FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lab/sync-agent... build
RUN pnpm --filter @lab/sync-agent --prod deploy --legacy /out
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/ ./
USER node
CMD ["node","dist/server.js"]
