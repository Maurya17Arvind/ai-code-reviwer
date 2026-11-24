# syntax=docker/dockerfile:1.7
# Dashboard: static Angular build served by unprivileged nginx (port 8080); /api is proxied to the API.
#
#   docker build -f infrastructure/docker/dashboard.Dockerfile -t acra-dashboard .

ARG NODE_IMAGE=node:24.15.0-alpine3.22

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NX_DAEMON=false NX_NO_CLOUD=true
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY libs/database/prisma.config.ts libs/database/prisma.config.ts
COPY libs/database/prisma libs/database/prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm nx build dashboard --configuration=production --skip-nx-cache

FROM nginxinc/nginx-unprivileged:1.29.3-alpine AS runtime
COPY infrastructure/docker/nginx-dashboard.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/dist/apps/dashboard/browser /usr/share/nginx/html
# API_UPSTREAM (default http://api:3000) is substituted into the template at start-up.
ENV API_UPSTREAM=http://api:3000 TRUSTED_PROXY_CIDR=127.0.0.1/32 NGINX_ENVSUBST_FILTER=API_UPSTREAM|TRUSTED_PROXY_CIDR
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
