# syntax=docker/dockerfile:1.7
# API and worker image (one Dockerfile, choose with --build-arg APP=api|worker).
#
#   docker build -f infrastructure/docker/node-app.Dockerfile --build-arg APP=api -t acra-api .
#   docker build -f infrastructure/docker/node-app.Dockerfile --build-arg APP=worker -t acra-worker .
#   docker build -f infrastructure/docker/node-app.Dockerfile --target migrate -t acra-migrate .
#
# Dependencies come from the workspace lockfile (frozen) and are pruned to production dependencies.
# The generated per-app package.json is not used: it misses packages the bundle loads at runtime
# (@prisma/client runtime, tslib).

ARG NODE_IMAGE=node:24.15.0-alpine3.22

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NX_DAEMON=false NX_NO_CLOUD=true
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /workspace

FROM base AS build
ARG APP=api
COPY package.json pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY libs/database/prisma.config.ts libs/database/prisma.config.ts
COPY libs/database/prisma libs/database/prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm nx build ${APP} --configuration=production --skip-nx-cache

# One-shot migration job: `prisma migrate deploy` against DATABASE_URL.
FROM build AS migrate
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "libs/database/prisma.config.ts"]

FROM build AS prune
RUN pnpm prune --prod --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ARG APP=api
ENV NODE_ENV=production APP=${APP}
WORKDIR /app
COPY --from=prune --chown=node:node /workspace/node_modules ./node_modules
COPY --from=prune --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/dist/apps/${APP} ./dist/apps/${APP}
USER node
# API: 3000 (API_HOST must be 0.0.0.0 in a container). Worker: health/metrics on WORKER_HTTP_PORT.
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:$([ "$APP" = api ] && echo "${API_PORT:-3000}/api" || echo "${WORKER_HTTP_PORT:-3001}")/health/live" >/dev/null || exit 1
CMD ["sh", "-c", "exec node dist/apps/${APP}/main.js"]
