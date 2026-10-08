# syntax=docker/dockerfile:1.7
# One image: the API serves the built dashboard from the same origin (no CORS, SSE on one host).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
# Manifests first, so the dependency layer is cached until a lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @calls/web build && pnpm --filter @calls/api build
# Production node_modules for the API only (the shared package is bundled into dist by esbuild).
RUN pnpm --filter @calls/api deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web EVALS_DIR=/app/evals
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/web/dist ./web
RUN mkdir -p /app/evals && chown node:node /app/evals
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]
