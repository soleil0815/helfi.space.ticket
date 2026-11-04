#!/bin/sh
# Container start script: set permissions of the data directory, then start without root.
# PUID/PGID (e.g. on a Synology) determine who owns the files in ./data.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA="${HELFI_DATA_DIR:-/data}"

case "$PUID$PGID" in
  ''|*[!0-9]*) echo "PUID/PGID must be numbers" >&2; exit 1 ;;
esac
# Never run as root
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "PUID/PGID 0 (root) is not allowed – please specify a regular user." >&2
  exit 1
fi

# New files (database, backups, key, attachments) for the owner only
umask 077

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # Only change what does not already match. NEVER follow symbolic links (! -type l, chown -h):
  # otherwise a link in the data directory could take over foreign files at startup.
  if ! find "$DATA" ! -type l \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + ; then
    echo "Warning: could not fully set permissions in $DATA (NFS/CIFS?). Please check PUID/PGID." >&2
  fi
  chmod 0750 "$DATA" 2>/dev/null || true
  export HOME=/tmp
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
