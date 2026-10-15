# syntax=docker/dockerfile:1.7

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime

ARG KAB_VERSION=dev
ARG KAB_REVISION=unknown
LABEL org.opencontainers.image.title="Kairoseth Agent Bridge Runtime" \
      org.opencontainers.image.description="Technical runtime for Integración de agentes de IA / AI Integration" \
      org.opencontainers.image.version="${KAB_VERSION}" \
      org.opencontainers.image.revision="${KAB_REVISION}" \
      org.opencontainers.image.source="https://github.com/Emmakex/kairoseth-agent-bridge"

ENV NODE_ENV=production \
    KAB_STATE_DIR=/var/lib/agent-bridge \
    KAB_DEPLOYMENT_MODE=local

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src

RUN mkdir -p /var/lib/agent-bridge \
  && chown --recursive node:node /var/lib/agent-bridge

USER node
VOLUME ["/var/lib/agent-bridge"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/src/cli/agent-bridge-runtime.js", "healthcheck"]

ENTRYPOINT ["node", "dist/src/cli/agent-bridge-runtime.js"]
CMD ["run"]
