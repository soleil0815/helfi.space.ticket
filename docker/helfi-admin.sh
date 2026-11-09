#!/bin/sh
# Emergency access from the Docker host (see README, "Locked out?"):
#   docker compose exec helfi helfi-admin list | reset <name> | create <name>
# "docker compose exec" runs as root – switch to PUID/PGID first, so no file in ./data ever belongs to root.
set -e
umask 077
APP="${HELFI_APP_DIR:-/app}"
cd "$APP"
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  case "$PUID$PGID" in
    ''|*[!0-9]*) echo "PUID/PGID must be numbers" >&2; exit 1 ;;
  esac
  if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
    echo "PUID/PGID 0 (root) is not allowed." >&2
    exit 1
  fi
  export HOME=/tmp
  exec su-exec "$PUID:$PGID" node "$APP/src/cli.js" "$@"
fi
exec node "$APP/src/cli.js" "$@"
