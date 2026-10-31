# Helfi.Space – Container-Image
# Gebaut von GitHub Actions für linux/amd64 und linux/arm64 (ghcr.io/soleil0815/helfi.space.ticket)

FROM node:22-alpine AS deps
WORKDIR /app
# Werkzeuge nur für den Fall, dass better-sqlite3 kein fertiges Binärpaket findet
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="Helfi.Space" \
      org.opencontainers.image.description="Ticketsystem mit Active-Directory-Anbindung, SSO und E-Mail-Abruf" \
      org.opencontainers.image.source="https://github.com/soleil0815/helfi.space.ticket" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

# npm/corepack werden zur Laufzeit nicht gebraucht – weg damit (weniger Angriffsfläche, weniger Schwachstellen-Funde)
RUN apk add --no-cache tini su-exec tzdata \
 && apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app
ENV NODE_ENV=production \
    HELFI_DATA_DIR=/data \
    HELFI_PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Aktuelle Betriebsdateien liegen im Image – update.sh übernimmt sie bei Bedarf
COPY docker-compose.yml .env.example update.sh docker/compose-hashes.txt ./deploy/
COPY docker/entrypoint.sh /usr/local/bin/helfi-entrypoint

RUN chmod 0755 /usr/local/bin/helfi-entrypoint ./deploy/update.sh && mkdir -p /data

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${HELFI_PORT}/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "helfi-entrypoint"]
CMD ["node", "src/server.js"]
