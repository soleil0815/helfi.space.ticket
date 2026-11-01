#!/bin/sh
# Helfi.Space – Update von Hand (läuft mit /bin/sh, auch dash und auf Synology)
#
#   ./update.sh                 neueste Version (latest) holen und starten
#   ./update.sh 1.2.0           bestimmte Version holen, in .env festhalten und starten
#   ./update.sh -y              ohne Rückfragen (startet bei Fehler automatisch die vorherige Version)
#   ./update.sh --offline helfi-1.2.0.tar.gz   ohne Internet: Image-Datei aus dem Release laden
#   ./update.sh --cleanup       nicht mehr gebrauchte Update-Reste anzeigen und nach Rückfrage löschen
#
# Ablauf: laufendes Image als "previous" merken → neue Version holen → docker-compose.yml
# bei Bedarf erneuern (nur wenn unverändert; alte bleibt als docker-compose.yml.alt-<Zeit>) →
# starten → auf Gesundheitscheck warten → bei Fehlschlag vorherige Version samt passender
# Datenbanksicherung wieder starten und in .env festhalten.
# Es werden keine Programmdateien abgelegt, nichts entpackt und nichts gebaut.

set -u

IMAGE_REPO="${HELFI_IMAGE_REPO:-ghcr.io/soleil0815/helfi.space.ticket}"
SERVICE=helfi
CONTAINER=helfi
WAIT_SECONDS="${HELFI_UPDATE_WAIT:-120}"
YES=0
OFFLINE=""
CLEANUP=0
VERSION=""
MARKER=""
COMPOSE_REPLACED=0

say() { printf '%s\n' "$*"; }
err() { printf 'FEHLER: %s\n' "$*" >&2; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

# shellcheck disable=SC2317 # wird über trap aufgerufen
cleanup() { if [ -n "$MARKER" ]; then rm -f "$MARKER"; fi; }
trap cleanup EXIT
# dash führt den EXIT-Trap bei Signalen nicht aus → selbst aufräumen
trap 'cleanup; err "Abgebrochen."; exit 130' INT TERM HUP

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --offline) shift; OFFLINE="${1:-}"; [ -n "$OFFLINE" ] || { err "--offline braucht eine Image-Datei"; exit 2; } ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unbekannte Option: $1"; usage; exit 2 ;;
    *) VERSION="$1" ;;
  esac
  shift
done

valid_version() {
  [ "$1" = latest ] && return 0
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}
if [ -n "$VERSION" ] && ! valid_version "$VERSION"; then
  err "Ungültige Version: $VERSION (Beispiel: 1.2.0 oder latest)"; exit 2
fi

# Im Ordner des Skripts arbeiten (dort liegen docker-compose.yml und .env)
cd "$(dirname "$0")" || exit 1

ask() {
  # ask "Frage" → 0 = ja
  [ "$YES" = 1 ] && return 0
  printf '%s [j/N] ' "$1"
  read -r answer || return 1
  case "$answer" in j|J|ja|Ja|y|Y|yes) return 0 ;; esac
  return 1
}

# --cleanup: Reste früherer Updates aufräumen. Gelöscht wird nur, was auf der festen Liste steht,
# als normale Datei (kein Link) direkt in diesem Ordner liegt und nicht selbst in einen laufenden
# Container eingebunden ist. Nie: Ordner (data/, Sicherungen, Mounts), .env, docker-compose.yml, Links.
cleanup_candidates() {
  # 1. Ältere Sicherheitskopien der docker-compose.yml (die neueste bleibt)
  for f in docker-compose.yml.alt-*; do
    printf '%s\n' "$f" | grep -Eq '^docker-compose\.yml\.alt-[0-9]{8}-[0-9]{6}$' && printf '%s\n' "$f"
  done | sort | sed '$d'
  # 2. Image-Dateien aus dem Release (für --offline; nach dem Laden nicht mehr nötig)
  for f in helfi-*.tar helfi-*.tar.gz; do
    printf '%s\n' "$f" | grep -Eq '^helfi-[0-9]+\.[0-9]+\.[0-9]+(-(amd64|arm64))?\.tar(\.gz)?$' && printf '%s\n' "$f"
  done
  # 3. Zwischendateien abgebrochener Läufe (älter als eine Stunde, damit kein laufendes Update gestört wird)
  find . -maxdepth 1 -type f \( -name '.docker-compose.neu.*' -o -name '.docker-compose.hashes.*' \
    -o -name '.env.tmp.*' -o -name '.update-start.*' -o -name 'docker-compose.yml.tmp' \) -mmin +60 2>/dev/null |
    sed 's|^\./||'
  # 4. docker-compose.yml.neu, wenn sie schon übernommen wurde (inhaltsgleich)
  if [ -f docker-compose.yml.neu ] && cmp -s docker-compose.yml.neu docker-compose.yml; then
    echo docker-compose.yml.neu
  fi
}

mounted_paths() {
  # Host-Pfade aller Mounts laufender Container (aufgelöst)
  for id in $(docker ps -q); do
    docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$id"
  done | while IFS= read -r m; do
    [ -n "$m" ] || continue
    if [ -d "$m" ]; then (cd -P "$m" 2>/dev/null && pwd -P)
    elif [ -e "$m" ]; then printf '%s/%s\n' "$(cd -P "$(dirname "$m")" 2>/dev/null && pwd -P)" "$(basename "$m")"
    else printf '%s\n' "$m"; fi
  done
}

if [ "$CLEANUP" = 1 ]; then
  [ -f docker-compose.yml ] || { err "docker-compose.yml fehlt in $(pwd) – falscher Ordner?"; exit 1; }
  here="$(pwd -P)"
  if ! docker ps -q >/dev/null 2>&1; then
    err "docker ist nicht erreichbar. Zum Schutz eingebundener Dateien wird nichts gelöscht."; exit 1
  fi
  mounts="$(mounted_paths)" || { err "Mounts der Container nicht lesbar – nichts gelöscht."; exit 1; }
  list="$(cleanup_candidates | while IFS= read -r f; do
    case "$f" in */*|''|.|..|.env|docker-compose.yml|data) continue ;; esac
    if [ ! -f "$f" ] || [ -L "$f" ]; then continue; fi
    full="$here/$f"
    # Als Datei in einen Container eingebunden? (Ordner werden ohnehin nie gelöscht)
    if printf '%s\n' "$mounts" | grep -Fxq -- "$full"; then
      say "Übersprungen (von einem Container eingebunden): $f" >&2; continue
    fi
    printf '%s\n' "$f"
  done)"
  if [ -z "$list" ]; then say "Nichts aufzuräumen."; exit 0; fi
  say "Nicht mehr gebraucht:"
  printf '%s\n' "$list" | sed 's/^/  /'
  if ! ask "Diese Dateien löschen?"; then say "Nichts gelöscht."; exit 0; fi
  printf '%s\n' "$list" | while IFS= read -r f; do
    [ -n "$f" ] && rm -f -- "$f" && say "Gelöscht: $f"
  done
  exit 0
fi

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  err "docker compose wurde nicht gefunden."; exit 1
fi

[ -f docker-compose.yml ] || { err "docker-compose.yml fehlt in $(pwd)"; exit 1; }
[ -f .env ] || { err ".env fehlt – bitte aus env.example erstellen."; exit 1; }

env_get() {
  # Windows-Zeilenenden und Anführungszeichen entfernen
  sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r"' | tr -d "'"
}

env_set() {
  # Wert in .env setzen (vorhandene Zeile ersetzen, sonst anhängen) – Datei bleibt sonst unverändert
  if grep -q "^$1=" .env; then
    tmp=".env.tmp.$$"
    sed "s|^$1=.*|$1=$2|" .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
  else
    # Fehlt der Zeilenumbruch am Ende, würde der Wert an die letzte Zeile geklebt
    if [ -s .env ] && [ "$(tail -c 1 .env | od -An -c | tr -d ' ')" != '\n' ]; then printf '\n' >> .env; fi
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

compose_version_of() {
  sed -n 's/^[[:space:]]*HELFI_COMPOSE_VERSION:[[:space:]]*"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p' "$1" | head -n 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Container über den festen Namen ansprechen (funktioniert auch, wenn das Compose-Projekt anders heißt)
container_id() {
  docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null || dc ps -q "$SERVICE" 2>/dev/null | head -n 1
}

data_dir() {
  # Host-Pfad des Datenordners (Mount auf /data) – unabhängig von Anpassungen in docker-compose.yml
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$1" 2>/dev/null
}

# 1. Gewünschte Version (wird erst nach erfolgreichem Holen in .env geschrieben)
OLD_TAG="$(env_get HELFI_VERSION)"
[ -n "$OLD_TAG" ] || OLD_TAG=latest
TAG="${VERSION:-$OLD_TAG}"
TARGET="$IMAGE_REPO:$TAG"

# 2. Laufendes Image merken
PREV_ID=""
PREV_VERSION=""
DATA_DIR=""
CID="$(container_id)"
if [ -n "$CID" ]; then
  PREV_ID="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || true)"
  DATA_DIR="$(data_dir "$CID")"
  if [ -n "$PREV_ID" ]; then
    docker tag "$PREV_ID" "$IMAGE_REPO:previous" >/dev/null 2>&1 && say "Laufende Version gemerkt als $IMAGE_REPO:previous"
    PREV_VERSION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$PREV_ID" 2>/dev/null || true)"
    valid_version "$PREV_VERSION" || PREV_VERSION=""
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
  if ! HELFI_VERSION="$TAG" dc pull "$SERVICE"; then
    err "Herunterladen fehlgeschlagen – nichts geändert. Ohne Internet: ./update.sh --offline <Image-Datei aus dem Release>"
    exit 1
  fi
fi
# Erst jetzt festhalten: Das Image ist lokal vorhanden
[ -n "$VERSION" ] && { env_set HELFI_VERSION "$VERSION"; say "Version in .env festgehalten: $VERSION"; }

NEW_ID="$(docker image inspect -f '{{.Id}}' "$TARGET" 2>/dev/null || true)"
if [ -n "$PREV_ID" ] && [ "$NEW_ID" = "$PREV_ID" ]; then
  say "Helfi.Space ist bereits auf dem neuesten Stand ($TAG)."
fi
NEW_VERSION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$TARGET" 2>/dev/null || true)"

# 4. docker-compose.yml aus dem Image übernehmen, wenn sie neuer ist – aber nur, wenn die
#    vorhandene Datei unverändert ist (sonst gingen eigene Anpassungen wie Datenpfade verloren)
tmp_compose=".docker-compose.neu.$$"
tmp_hashes=".docker-compose.hashes.$$"
if docker run --rm --entrypoint cat "$TARGET" /app/deploy/docker-compose.yml > "$tmp_compose" 2>/dev/null && [ -s "$tmp_compose" ]; then
  have="$(compose_version_of docker-compose.yml)"; want="$(compose_version_of "$tmp_compose")"
  if [ -n "$want" ] && [ "${have:-0}" -lt "$want" ]; then
    docker run --rm --entrypoint cat "$TARGET" /app/deploy/compose-hashes.txt > "$tmp_hashes" 2>/dev/null || : > "$tmp_hashes"
    current="$(sha256_of docker-compose.yml)"
    if [ -n "$current" ] && grep -qx "$current" "$tmp_hashes"; then
      alt="docker-compose.yml.alt-$(date +%Y%m%d-%H%M%S)"
      cp docker-compose.yml "$alt"
      cat "$tmp_compose" > docker-compose.yml.tmp && mv docker-compose.yml.tmp docker-compose.yml
      COMPOSE_REPLACED="$alt"
      say "docker-compose.yml erneuert (Version ${have:-?} → $want). Die alte liegt als $alt daneben."
    else
      cat "$tmp_compose" > docker-compose.yml.neu
      say "HINWEIS: Die neue Version bringt eine neue docker-compose.yml (Version $want). Deine Datei wurde angepasst"
      say "         und bleibt deshalb unverändert. Die neue liegt als docker-compose.yml.neu daneben – bitte Änderungen übernehmen."
    fi
  fi
fi
rm -f "$tmp_compose" "$tmp_hashes"

# 5. Starten (Zeitmarke: nur Sicherungen ab jetzt gehören zu diesem Update)
MARKER=".update-start.$$"
: > "$MARKER"
sleep 1 # busybox-find vergleicht nur ganze Sekunden
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
  say "Die neue Version bleibt gestartet (sie hat die Datenbank evtl. schon umgestellt)."
  say "Zurück später mit: ./update.sh -y  nach Eintragen der alten Version in .env – die passende Sicherung"
  say "liegt im Datenordner unter backups/helfi-vor-${NEW_VERSION:-<Version>}-*.sqlite (siehe README)."
  exit 1
fi

# Hat die neue Version die Datenbank schon umgestellt, braucht die alte die Sicherung von davor.
if [ -n "$NEW_VERSION" ]; then
  if [ -z "$DATA_DIR" ] || [ ! -d "$DATA_DIR" ]; then
    err "Datenordner des Containers nicht gefunden – die Datenbank wird NICHT zurückgespielt."
    err "Falls die alte Version nicht startet: Sicherung helfi-vor-$NEW_VERSION-*.sqlite von Hand zurückspielen (README)."
  else
    backup="$(find "$DATA_DIR/backups" -maxdepth 1 -name "helfi-vor-$NEW_VERSION-*.sqlite" -newer "$MARKER" 2>/dev/null | sort | tail -n 1)"
    if [ -n "$backup" ] && [ -f "$DATA_DIR/helfi.sqlite" ]; then
      dc stop "$SERVICE" >/dev/null 2>&1 || true
      stamp="$(date +%Y%m%d-%H%M%S)"
      # Erst vollständig kopieren, dann austauschen – nie ohne Datenbank dastehen
      if cp "$backup" "$DATA_DIR/helfi.sqlite.zurueck" && sync; then
        for ext in "" -wal -shm; do
          [ -f "$DATA_DIR/helfi.sqlite$ext" ] && mv "$DATA_DIR/helfi.sqlite$ext" "$DATA_DIR/helfi.sqlite.fehlgeschlagen-$stamp$ext"
        done
        mv "$DATA_DIR/helfi.sqlite.zurueck" "$DATA_DIR/helfi.sqlite"
        say "Datenbank aus $backup zurückgespielt (fehlgeschlagener Stand: helfi.sqlite.fehlgeschlagen-$stamp)."
        say "Achtung: Was seit dem Update eingegangen ist (z. B. Tickets aus E-Mails), steht nur im fehlgeschlagenen Stand."
      else
        rm -f "$DATA_DIR/helfi.sqlite.zurueck"
        err "Sicherung konnte nicht kopiert werden (Platz?) – Datenbank unverändert."
      fi
    fi
  fi
fi

# Zur alten Version gehört auch die alte docker-compose.yml
if [ "$COMPOSE_REPLACED" != 0 ]; then
  cp docker-compose.yml docker-compose.yml.neu
  cp "$COMPOSE_REPLACED" docker-compose.yml
  say "Vorherige docker-compose.yml wiederhergestellt (neue liegt als docker-compose.yml.neu daneben)."
fi

# Alte Version festhalten, damit Watchtower/Dockhand die defekte nicht sofort wieder holen
if [ -n "$PREV_VERSION" ]; then
  docker tag "$IMAGE_REPO:previous" "$IMAGE_REPO:$PREV_VERSION" || exit 1
  env_set HELFI_VERSION "$PREV_VERSION"
  say "Version in .env auf $PREV_VERSION festgehalten."
else
  docker tag "$IMAGE_REPO:previous" "$TARGET" || exit 1
fi
HELFI_VERSION="${PREV_VERSION:-$TAG}" dc up -d --pull never "$SERVICE" 2>/dev/null || HELFI_VERSION="${PREV_VERSION:-$TAG}" dc up -d "$SERVICE"
if wait_healthy; then
  say "Vorherige Version läuft wieder."
  exit 1
fi
err "Auch die vorherige Version startet nicht. Bitte Protokoll prüfen: docker compose logs $SERVICE"
exit 1
