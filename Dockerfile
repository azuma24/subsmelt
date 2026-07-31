# ---- Build Stage ----
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
# ci, not install: the lockfile is authoritative for a reproducible image.
# --legacy-peer-deps: i18next@26 declares typescript as an OPTIONAL peer at
# "^5 || ^6" while this repo is on typescript@7, which the image's npm 10
# rejects outright. The peer is types-only and the lockfile resolves cleanly.
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# ---- Production Stage ----
FROM node:22-slim
WORKDIR /app

# Install tzdata for timezone support
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Copy node_modules from builder (includes compiled better-sqlite3 native addon)
# then prune dev dependencies without recompiling anything.
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev --legacy-peer-deps

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Create directories
RUN mkdir -p /app/data /app/config

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV CONFIG_DIR=/app/config
ENV MEDIA_DIR=/media
ENV TZ=UTC

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
