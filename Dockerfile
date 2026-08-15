# syntax=docker/dockerfile:1.7

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy only directories admitted by the repository's deny-default
# .dockerignore. Its final exclusions keep local env files, Git data, stale
# output, dependencies, and tests outside the BuildKit context.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY infra/scripts/prune-deployed-workspace.mjs ./infra/scripts/prune-deployed-workspace.mjs
COPY infra/scripts/validate-runtime-package.mjs ./infra/scripts/validate-runtime-package.mjs

RUN --mount=type=cache,id=emdo-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build
RUN test -f apps/api/dist/index.js \
    && test -f apps/api/dist/cli/migrate.js \
    && test -f apps/api/dist/cli/bootstrap-owner.js \
    && test -f apps/api/dist/cli/purge-finance-imports.js \
    && test -f apps/api/dist/cli/reconcile-google-oauth-disconnects.js \
    && test -f apps/api/dist/cli/seed-synthetic.js \
    && test -f apps/api/dist/cli/staging-acceptance.js \
    && test -f apps/worker/dist/index.js \
    && test -f apps/worker/dist/cli/migrate-jobs.js \
    && test -f apps/web/dist/index.html
# Release images never carry embedded workspace sources or developer type
# declarations. Keep detailed traces in governed runtime storage, not maps.
RUN find apps/api/dist apps/worker/dist apps/web/dist -type f \
      \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete
RUN --mount=type=cache,id=emdo-pnpm-store,target=/pnpm/store \
    pnpm --filter @emdo/api deploy --prod /opt/emdo/api \
    && pnpm --filter @emdo/worker deploy --prod /opt/emdo/worker
RUN node infra/scripts/prune-deployed-workspace.mjs /opt/emdo/api/node_modules \
    && node infra/scripts/prune-deployed-workspace.mjs /opt/emdo/worker/node_modules
RUN node infra/scripts/validate-runtime-package.mjs /opt/emdo/api \
    && node infra/scripts/validate-runtime-package.mjs /opt/emdo/worker \
    && node infra/scripts/validate-runtime-package.mjs /workspace/apps/web
# Import every API executable module from the pruned production closure. The
# direct-execution guards must not start listeners or perform operations while
# these imports prove the CLI-specific dependency graphs are deployable.
RUN cd /opt/emdo/api \
    && node --input-type=module --eval \
      "await Promise.all([import('./dist/index.js'), import('./dist/cli/migrate.js'), import('./dist/cli/bootstrap-owner.js'), import('./dist/cli/purge-finance-imports.js'), import('./dist/cli/reconcile-google-oauth-disconnects.js'), import('./dist/cli/seed-synthetic.js'), import('./dist/cli/staging-acceptance.js')])"
# Import the worker from its pruned production closure, not workspace modules.
RUN cd /opt/emdo/worker \
    && node --input-type=module --eval \
      "const worker = await import('./dist/index.js'); const runtime = worker.createUnavailableWorkerProviderRuntime(); if (runtime.status.overall !== 'degraded') throw new Error('worker provider fallback smoke failed')"

ARG SOURCE_SHA=unknown
ARG BUILD_CREATED=unknown

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS api
ARG SOURCE_SHA
ARG BUILD_CREATED
LABEL org.opencontainers.image.source="https://github.com/panic80/emdo" \
      org.opencontainers.image.revision="$SOURCE_SHA" \
      org.opencontainers.image.created="$BUILD_CREATED"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10001:10001 /opt/emdo/api/package.json ./package.json
COPY --from=build --chown=10001:10001 /opt/emdo/api/dist ./dist
COPY --from=build --chown=10001:10001 /opt/emdo/api/node_modules ./node_modules
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS worker
ARG SOURCE_SHA
ARG BUILD_CREATED
LABEL org.opencontainers.image.source="https://github.com/panic80/emdo" \
      org.opencontainers.image.revision="$SOURCE_SHA" \
      org.opencontainers.image.created="$BUILD_CREATED"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10002:10002 /opt/emdo/worker/package.json ./package.json
COPY --from=build --chown=10002:10002 /opt/emdo/worker/dist ./dist
COPY --from=build --chown=10002:10002 /opt/emdo/worker/node_modules ./node_modules
USER 10002:10002
EXPOSE 3001
CMD ["node", "dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.29.1-alpine@sha256:27985295bdb22a1ef8f712863210bd5877c0f3006494a593e86b3fe0fa55467e AS web
ARG SOURCE_SHA
ARG BUILD_CREATED
LABEL org.opencontainers.image.source="https://github.com/panic80/emdo" \
      org.opencontainers.image.revision="$SOURCE_SHA" \
      org.opencontainers.image.created="$BUILD_CREATED"
COPY --chown=101:101 infra/compose/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /workspace/apps/web/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
