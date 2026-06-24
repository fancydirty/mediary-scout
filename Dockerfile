# syntax=docker/dockerfile:1
# media-track self-host image: Next.js app + in-process queue worker
# (started via apps/web/instrumentation.ts). One container = web + worker.

FROM node:22-slim AS builder
WORKDIR /app
# Override for faster installs behind slow/blocked registries, e.g.
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
# Install deps first (cached unless the manifests change), then copy source.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/workflow/package.json packages/workflow/
RUN npm config set registry "$NPM_REGISTRY" && npm ci
COPY . .
# build:web = build:workflow (tsc) + next build apps/web (output: standalone)
RUN npm run build:web

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Standalone traces from the monorepo root → server entry at apps/web/server.js.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# `output: standalone` does NOT bundle public/ — copy it explicitly, else every
# public asset (e.g. /brands/<provider>.svg for the workspace switcher icons) 404s
# and BrandMark falls back to a bare dot (demo on Vercel serves public/ natively).
COPY --from=builder /app/apps/web/public ./apps/web/public
# Admin CLI escape hatch (forgot-password). standalone ships no scripts/ — copy it
# in so `docker compose exec web node scripts/reset-password.mjs <user>` works. The
# script is self-contained (raw pg + scrypt), so it needs no workflow dist (which
# standalone bundles into .next and doesn't expose as a module).
COPY --from=builder /app/scripts/reset-password.mjs ./scripts/reset-password.mjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
