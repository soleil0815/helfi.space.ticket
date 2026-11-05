#!/bin/sh
# Smoke test of an image – started with the same hardening as in docker-compose.yml.
# Usage: sh .github/scripts/smoke-test.sh <image>
set -u
IMG="$1"
NAME="helfi-smoke-$$"
DATA="$(mktemp -d)"

fail() {
  echo "::error::$1 | $(docker logs "$NAME" 2>&1 | tail -n 8 | tr '\n' '|')"
  docker rm -f "$NAME" >/dev/null 2>&1
  exit 1
}

out="$(docker run -d --name "$NAME" -p 18080:8080 -v "$DATA:/data" -e HELFI_COMPOSE_VERSION=1 \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
  "$IMG" 2>&1)" || fail "docker run: $out"

i=0
while [ "$i" -lt 45 ]; do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)"
  [ "$s" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Status}}' "$NAME")" = running ] || fail "container is no longer running"
  sleep 2
  i=$((i + 1))
done
docker logs "$NAME"
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || fail "not healthy"
curl -fsS http://localhost:18080/api/bootstrap | grep -q '"setupRequired":true' || fail "bootstrap"
# The setup code banner is bilingual ("Einrichtungscode / setup code"); accept either wording
docker logs "$NAME" 2>&1 | grep -Eq 'Einrichtungscode|[Ss]etup code' || fail "no setup code in the log"
owner="$(sudo stat -c %u "$DATA/helfi.sqlite")"
[ "$owner" = 1000 ] || fail "database is owned by $owner instead of 1000"
mode="$(sudo stat -c %a "$DATA/helfi.sqlite")"
[ "$mode" = 600 ] || fail "database has mode $mode instead of 600"
docker rm -f "$NAME" >/dev/null

# Slim image: no package tools of the Node base image, only one SQLite binary, no sources
extra="$(docker run --rm --entrypoint /bin/sh "$IMG" -c '
  for f in /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg; do
    [ -e "$f" ] && echo "$f"
  done
  ls -d /opt/yarn-* /app/node_modules/better-sqlite3/deps /app/node_modules/better-sqlite3/src 2>/dev/null
  n="$(ls /app/node_modules/better-sqlite3/prebuilds 2>/dev/null | wc -l)"
  [ "$n" -le 1 ] || echo "better-sqlite3: $n prebuilt binaries"
  true' 2>&1)"
[ -z "$extra" ] || fail "left in the image: $(echo "$extra" | tr '\n' ' ')"
echo "Smoke test passed: $IMG"
