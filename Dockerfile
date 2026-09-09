# ---- Build stage ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Build tools in case better-sqlite3 has no prebuilt binary for this platform
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies but keep the compiled better-sqlite3 native binding
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Copy the pruned node_modules (incl. native bindings) and the compiled output
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

# Default channel config (overridable via compose bind mount)
COPY config.json ./config.json

# Named volumes are initialized from this directory, so make it writable by the node user
RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]