#!/bin/sh
# Startskript im Container: Rechte des Datenordners setzen, dann ohne root starten.
# PUID/PGID (z. B. auf einer Synology) bestimmen, wem die Dateien in ./data gehören.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA="${HELFI_DATA_DIR:-/data}"

case "$PUID$PGID" in
  *[!0-9]*) echo "PUID/PGID müssen Zahlen sein" >&2; exit 1 ;;
esac

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # Nur anpassen, was nicht schon passt (schnell auch bei vielen Anhängen)
  find "$DATA" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  chmod 0750 "$DATA" 2>/dev/null || true
  export HOME=/tmp
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
