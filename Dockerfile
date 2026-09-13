# Production image for the Kinvo API.
#
# Distinct from docker-compose.yml, which is local development only and runs
# Postgres, Redis, and MinIO. This packages the API itself and nothing else.
#
# Debian slim rather than Alpine: argon2 is a native module and ships prebuilt
# binaries for glibc. On musl it has to compile from source, which needs a
# toolchain in the final image and roughly triples the build time.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Dependencies first: this layer is cached unless the lockfile changes, so a
# code-only change skips reinstalling everything.
COPY package.json package-lock.json ./

# `npm ci` runs the postinstall that generates the Prisma client, which needs
# the schema present.
COPY prisma ./prisma
COPY prisma.config.ts ./

# tsconfig.json MUST be here before `prisma generate`.
#
# The Prisma 7 client generator reads it to decide whether to emit CommonJS or
# ESM. Without it, it defaults to ESM, tsc then compiles that into dist, and the
# container dies at startup with "exports is not defined in ES module scope" —
# while the local build, where tsconfig is always present, works perfectly.
COPY tsconfig.json tsconfig.build.json ./

RUN npm ci --ignore-scripts \
  && npm rebuild argon2 \
  && npx prisma generate

COPY src ./src

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

# Signals reach Node properly through tini, so the graceful shutdown in
# server.ts actually runs instead of the container being killed outright.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# Production dependencies only. --ignore-scripts skips the postinstall, so the
# generated client is copied from the builder rather than regenerated here.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild argon2 \
  && npm cache clean --force

# Only the compiled output. The generated Prisma client is TypeScript source
# that tsc has already compiled into dist/generated, and there is no query
# engine binary to carry because Prisma 7 connects through @prisma/adapter-pg.
COPY --from=builder /app/dist ./dist

# The base image ships a `node` user. Running as root would mean a container
# escape starts with root on the host.
USER node

EXPOSE 3000

# The orchestrator restarts an unhealthy container. /health is liveness only and
# deliberately checks no dependency — a Postgres blip must not kill a healthy API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
