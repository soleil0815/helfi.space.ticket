#!/bin/sh
# Startskript im Container: Rechte des Datenordners setzen, dann ohne root starten.
# PUID/PGID (z. B. auf einer Synology) bestimmen, wem die Dateien in ./data gehören.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA="${HELFI_DATA_DIR:-/data}"

case "$PUID$PGID" in
  ''|*[!0-9]*) echo "PUID/PGID müssen Zahlen sein" >&2; exit 1 ;;
esac
# Nie als root laufen lassen
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "PUID/PGID 0 (root) ist nicht erlaubt – bitte einen normalen Benutzer angeben." >&2
  exit 1
fi

# Neue Dateien (Datenbank, Sicherungen, Schlüssel, Anhänge) nur für den Besitzer
umask 077

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # Nur anpassen, was nicht schon passt. Symbolische Links NIE verfolgen (! -type l, chown -h):
  # sonst könnte ein Link im Datenordner beim Start fremde Dateien übernehmen.
  if ! find "$DATA" ! -type l \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + ; then
    echo "Warnung: Rechte in $DATA ließen sich nicht vollständig setzen (NFS/CIFS?). Bitte PUID/PGID prüfen." >&2
  fi
  chmod 0750 "$DATA" 2>/dev/null || true
  export HOME=/tmp
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
