#!/bin/sh
# Helfi.Space – Update von Hand (läuft mit /bin/sh, auch dash und auf Synology)
#
#   ./update.sh                 neueste Version (latest) holen und starten
#   ./update.sh 1.2.0           bestimmte Version holen, in .env festhalten und starten
#   ./update.sh -y              ohne Rückfragen (startet bei Fehler automatisch die vorherige Version)
#   ./update.sh --offline helfi-1.2.0.tar   ohne Internet: Image-Datei aus dem Release laden
#
# Ablauf: laufendes Image als "previous" merken → neue Version holen → docker-compose.yml
# bei Bedarf erneuern (alte bleibt als docker-compose.yml.alt) → starten → auf Gesundheitscheck
# warten → bei Fehlschlag vorherige Version wieder starten.
# Es werden keine Programmdateien abgelegt, nichts entpackt und nichts gebaut.

set -u

IMAGE_REPO="${HELFI_IMAGE_REPO:-ghcr.io/soleil0815/helfi.space.ticket}"
SERVICE=helfi
WAIT_SECONDS="${HELFI_UPDATE_WAIT:-120}"
YES=0
OFFLINE=""
VERSION=""

say() { printf '%s\n' "$*"; }
err() { printf 'FEHLER: %s\n' "$*" >&2; }

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --offline) shift; OFFLINE="${1:-}"; [ -n "$OFFLINE" ] || { err "--offline braucht eine Image-Datei"; exit 2; } ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unbekannte Option: $1"; usage; exit 2 ;;
    *) VERSION="$1" ;;
  esac
  shift
done

case "$VERSION" in
  ''|latest) ;;
  *[!0-9.]*|.*|*.) err "Ungültige Version: $VERSION (Beispiel: 1.2.0 oder latest)"; exit 2 ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) err "Ungültige Version: $VERSION (Beispiel: 1.2.0 oder latest)"; exit 2 ;;
esac

# Im Ordner des Skripts arbeiten (dort liegen docker-compose.yml und .env)
cd "$(dirname "$0")" || exit 1

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  err "docker compose wurde nicht gefunden."; exit 1
fi

[ -f docker-compose.yml ] || { err "docker-compose.yml fehlt in $(pwd)"; exit 1; }
[ -f .env ] || { err ".env fehlt – bitte aus .env.example erstellen."; exit 1; }

ask() {
  # ask "Frage" → 0 = ja
  [ "$YES" = 1 ] && return 0
  printf '%s [j/N] ' "$1"
  read -r answer || return 1
  case "$answer" in j|J|ja|Ja|y|Y|yes) return 0 ;; esac
  return 1
}

env_get() {
  sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '"' | tr -d "'"
}

env_set() {
  # Wert in .env setzen (vorhandene Zeile ersetzen, sonst anhängen)
  if grep -q "^$1=" .env; then
    tmp=".env.tmp.$$"
    sed "s|^$1=.*|$1=$2|" .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

compose_version_of() {
  sed -n 's/^[[:space:]]*HELFI_COMPOSE_VERSION:[[:space:]]*"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p' "$1" | head -n 1
}

container_id() { dc ps -q "$SERVICE" 2>/dev/null | head -n 1; }

# 1. Version festlegen
if [ -n "$VERSION" ]; then
  env_set HELFI_VERSION "$VERSION"
  say "Version in .env festgehalten: $VERSION"
fi
TAG="$(env_get HELFI_VERSION)"
[ -n "$TAG" ] || TAG=latest
TARGET="$IMAGE_REPO:$TAG"

# 2. Laufendes Image merken
PREV_ID=""
CID="$(container_id)"
if [ -n "$CID" ]; then
  PREV_ID="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || true)"
  if [ -n "$PREV_ID" ]; then
    docker tag "$PREV_ID" "$IMAGE_REPO:previous" >/dev/null 2>&1 && say "Laufende Version gemerkt als $IMAGE_REPO:previous"
  fi
fi

# 3. Neue Version holen
if [ -n "$OFFLINE" ]; then
  [ -f "$OFFLINE" ] || { err "Datei nicht gefunden: $OFFLINE"; exit 1; }
  say "Lade Image aus $OFFLINE ..."
  loaded="$(docker load -i "$OFFLINE" | sed -n 's/^Loaded image: //p' | head -n 1)"
  [ -n "$loaded" ] || { err "In $OFFLINE wurde kein Image gefunden."; exit 1; }
  if [ "$loaded" != "$TARGET" ]; then docker tag "$loaded" "$TARGET" || exit 1; fi
  say "Geladen: $loaded"
else
  say "Hole $TARGET ..."
  if ! dc pull "$SERVICE"; then
    err "Herunterladen fehlgeschlagen. Ohne Internet: ./update.sh --offline <Image-Datei aus dem Release>"
    exit 1
  fi
fi

NEW_ID="$(docker image inspect -f '{{.Id}}' "$TARGET" 2>/dev/null || true)"
if [ -n "$PREV_ID" ] && [ "$NEW_ID" = "$PREV_ID" ]; then
  say "Helfi.Space ist bereits auf dem neuesten Stand ($TAG)."
fi
NEW_VERSION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$TARGET" 2>/dev/null || true)"

# 4. docker-compose.yml aus dem Image übernehmen, wenn sie neuer ist
tmp_compose=".docker-compose.neu.$$"
COMPOSE_REPLACED=0
if docker run --rm --entrypoint cat "$TARGET" /app/deploy/docker-compose.yml > "$tmp_compose" 2>/dev/null && [ -s "$tmp_compose" ]; then
  have="$(compose_version_of docker-compose.yml)"; want="$(compose_version_of "$tmp_compose")"
  if [ -n "$want" ] && [ "${have:-0}" -lt "$want" ]; then
    cp docker-compose.yml docker-compose.yml.alt
    cat "$tmp_compose" > docker-compose.yml
    COMPOSE_REPLACED=1
    say "docker-compose.yml erneuert (Version ${have:-?} → $want). Die alte liegt als docker-compose.yml.alt daneben."
    say "Falls du dort eigene Anpassungen hattest, bitte in die neue Datei übernehmen."
  fi
fi
rm -f "$tmp_compose"

# 5. Starten (Zeitmarke: nur Sicherungen ab jetzt gehören zu diesem Update)
MARKER=".update-start.$$"
: > "$MARKER"
trap 'rm -f "$MARKER"' EXIT
dc up -d "$SERVICE" || err "Start fehlgeschlagen."

# 6. Auf Gesundheitscheck warten
wait_healthy() {
  waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    cid="$(container_id)"
    if [ -n "$cid" ]; then
      state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      if [ "$health" = "healthy" ] || { [ -z "$health" ] && [ "$state" = "running" ]; }; then return 0; fi
      case "$state" in exited|dead) return 1 ;; esac
      [ "$health" = "unhealthy" ] && return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

say "Warte auf den Start (höchstens ${WAIT_SECONDS}s) ..."
if wait_healthy; then
  say "Helfi.Space läuft (${NEW_VERSION:-$TAG})."
  exit 0
fi

err "Die neue Version ist nicht gesund gestartet. Letzte Protokollzeilen:"
dc logs --tail 30 "$SERVICE" >&2 2>/dev/null || true

if [ -z "$PREV_ID" ]; then
  err "Es gibt keine vorherige Version zum Zurückgehen."
  exit 1
fi

if ! ask "Vorherige Version wieder starten?"; then
  say "Nichts geändert. Zurück von Hand: HELFI_VERSION in .env auf die alte Version setzen und ./update.sh starten."
  exit 1
fi

# Hat die neue Version die Datenbank schon umgestellt, braucht die alte die Sicherung von davor.
if [ -n "$NEW_VERSION" ]; then
  backup="$(find data/backups -maxdepth 1 -name "helfi-vor-$NEW_VERSION-*.sqlite" -newer "$MARKER" 2>/dev/null | sort | tail -n 1)"
  if [ -n "$backup" ] && [ -f data/helfi.sqlite ]; then
    dc stop "$SERVICE" >/dev/null 2>&1 || true
    stamp="$(date +%Y%m%d-%H%M%S)"
    mv data/helfi.sqlite "data/helfi.sqlite.fehlgeschlagen-$stamp"
    rm -f data/helfi.sqlite-wal data/helfi.sqlite-shm
    cp "$backup" data/helfi.sqlite
    say "Datenbank aus $backup zurückgespielt (fehlgeschlagener Stand: data/helfi.sqlite.fehlgeschlagen-$stamp)."
  fi
fi

# Zur alten Version gehört auch die alte docker-compose.yml
if [ "$COMPOSE_REPLACED" = 1 ]; then
  cp docker-compose.yml docker-compose.yml.neu
  cp docker-compose.yml.alt docker-compose.yml
  say "Vorherige docker-compose.yml wiederhergestellt (neue liegt als docker-compose.yml.neu daneben)."
fi

docker tag "$IMAGE_REPO:previous" "$TARGET" || exit 1
dc up -d --pull never "$SERVICE" 2>/dev/null || dc up -d "$SERVICE"
if wait_healthy; then
  say "Vorherige Version läuft wieder. Tipp: Version in .env festhalten (HELFI_VERSION=...), bis das Problem geklärt ist."
  exit 1
fi
err "Auch die vorherige Version startet nicht. Bitte Protokoll prüfen: docker compose logs $SERVICE"
exit 1
