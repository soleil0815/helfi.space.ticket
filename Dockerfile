# Helfi.Space – container image
# Built by GitHub Actions for linux/amd64 and linux/arm64 (ghcr.io/soleil0815/helfi.space.ticket)

# Base image pinned by digest (reproducible); Dependabot proposes new digests
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS deps
WORKDIR /app
# Build tools only in case better-sqlite3 finds no prebuilt binary
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Keep only what runs: better-sqlite3 ships binaries for 8 platforms plus the SQLite sources;
# only the one for this platform stays (or the self-built one). Tests, docs and examples of the
# packages go too. Then check that the database driver still loads.
COPY docker/prune-modules.sh /tmp/prune-modules.sh
RUN sh /tmp/prune-modules.sh /app/node_modules \
 && node -e "const D=require('better-sqlite3');console.log('SQLite',new D(':memory:').prepare('select sqlite_version() v').get().v)"

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ARG VERSION=dev
LABEL org.opencontainers.image.title="Helfi.Space" \
      org.opencontainers.image.description="Ticket system with Active Directory integration, SSO and email retrieval" \
      org.opencontainers.image.source="https://github.com/soleil0815/helfi.space.ticket" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

# npm, corepack and yarn (all from the Node base image) are not needed at runtime – remove them
# (smaller attack surface, fewer vulnerability findings). apk stays on purpose: scanners read the
# installed packages from its database; the container runs read-only and without root anyway.
RUN apk add --no-cache tini su-exec tzdata \
 && apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
ENV NODE_ENV=production \
    HELFI_DATA_DIR=/data \
    HELFI_PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Current deployment files are shipped in the image – update.sh adopts them when needed
COPY docker-compose.yml env.example update.sh docker/compose-hashes.txt ./deploy/
COPY docker/entrypoint.sh /usr/local/bin/helfi-entrypoint
# Emergency access: docker compose exec helfi helfi-admin …
COPY docker/helfi-admin.sh /usr/local/bin/helfi-admin

RUN chmod 0755 /usr/local/bin/helfi-entrypoint /usr/local/bin/helfi-admin ./deploy/update.sh && mkdir -p /data

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${HELFI_PORT}/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "helfi-entrypoint"]
CMD ["node", "src/server.js"]
