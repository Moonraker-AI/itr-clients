# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS="--enable-source-maps"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Drizzle migrations are plain .sql files; tsc doesn't copy them.
# Migration runner reads them from this path at runtime (Cloud Run Job).
COPY --from=builder /app/src/db/migrations ./dist/db/migrations

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
