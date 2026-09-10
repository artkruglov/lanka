FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=optional --no-audit --no-fund
COPY lib ./lib
COPY components ./components
COPY app ./app
COPY vendor ./vendor
COPY scripts ./scripts
COPY runtime ./runtime
COPY design-packs ./design-packs
COPY db ./db
COPY public ./public
RUN node scripts/build-project-mcp.mjs
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS server
RUN apt-get update && apt-get install -y --no-install-recommends python3 poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.project-runtime ./.project-runtime
COPY --from=build /app/public ./public
COPY --from=build /app/db ./db
COPY --from=build /app/design-packs ./design-packs
COPY runtime/extract.py ./runtime/extract.py
RUN mkdir -p /var/lib/lanka && chown node:node /var/lib/lanka
ENV NODE_ENV=production LANKA_PYTHON=python3
USER node
EXPOSE 4318
CMD ["node", ".project-runtime/self-hosted-server.mjs", "--config", "/run/secrets/lanka.json"]
