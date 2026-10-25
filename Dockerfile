# syntax=docker/dockerfile:1
# Small multi-stage image for a cheap VPS (amd64 or arm64). The image itself is read-only at
# runtime; everything the harness learns or writes lives on the /app/data volume.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
# DuckDB (the sql_query tool) adds about 140 MB; build with WITH_DUCKDB=false to leave it out.
ARG WITH_DUCKDB=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# The dashboard UI is bundled into dist/ui and inlined into every dashboard file.
COPY ui ./ui
COPY scripts ./scripts
RUN npm run build \
  && if [ "$WITH_DUCKDB" = "true" ]; then npm prune --omit=dev; else npm prune --omit=dev --omit=optional; fi

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# python3 serves the bash tool's analysis scripts; tini reaps child processes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HARNESS_ROOT=/app \
    HARNESS_DATA_DIR=/app/data \
    HARNESS_KNOWLEDGE_DIR=/app/data/knowledge \
    HARNESS_SCRAPERS_DIR=/app/data/scrapers \
    HARNESS_LEARNED_SKILLS_DIR=/app/data/skills \
    LOG_FORMAT=json \
    PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY agents ./agents
COPY skills ./skills
COPY config ./config
COPY knowledge ./knowledge-seed
COPY docker/entrypoint.sh /usr/local/bin/harness-entrypoint
RUN chmod 0755 /usr/local/bin/harness-entrypoint \
  && mkdir -p /app/data \
  && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "harness-entrypoint"]
CMD ["node", "dist/index.js"]
