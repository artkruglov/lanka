FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY app-server.mjs worker.mjs check.mjs extract.py ./
RUN mkdir /app/work && chown -R node:node /app/work
USER node
ENV LANKA_PYTHON=python3
CMD ["node", "worker.mjs"]
