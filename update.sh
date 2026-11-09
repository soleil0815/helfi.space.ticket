#!/bin/sh
# Helfi.Space – manual update (runs with /bin/sh, including dash and on Synology)
# Output is German if the locale is German (LC_ALL / LC_MESSAGES / LANG starting with "de"),
# otherwise English. Usage: see usage() below or ./update.sh --help
#
# Flow: remember the running image as "previous" → pull the new version → replace
# docker-compose.yml if needed (only if unmodified; the old one is kept as docker-compose.yml.alt-<time>) →
# start → wait for the health check → on failure restart the previous version with the matching
# database backup and record it in .env.
# No program files are stored, nothing is unpacked and nothing is built.

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

# Language: the first non-empty of LC_ALL, LC_MESSAGES, LANG decides (POSIX precedence); default English
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in de*) DE=1 ;; *) DE=0 ;; esac

# msg "German" "English" → prints the text for the current language (no newline)
msg() { if [ "$DE" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say() { msg "$1" "$2"; printf '\n'; }
err() { { msg 'FEHLER: ' 'ERROR: '; msg "$1" "$2"; printf '\n'; } >&2; }

usage() {
  msg 'Helfi.Space – Update von Hand

  ./update.sh                 neueste Version (latest) holen und starten
  ./update.sh 1.2.0           bestimmte Version holen, in .env festhalten und starten
  ./update.sh -y              ohne Rückfragen (startet bei Fehler automatisch die vorherige Version)
  ./update.sh --offline helfi-1.2.0.tar.gz   ohne Internet: Image-Datei aus dem Release laden
  ./update.sh --cleanup       nicht mehr gebrauchte Update-Reste anzeigen und nach Rückfrage löschen

Ablauf: laufendes Image als "previous" merken → neue Version holen → docker-compose.yml
bei Bedarf erneuern (nur wenn unverändert; alte bleibt als docker-compose.yml.alt-<Zeit>) →
starten → auf Gesundheitscheck warten → bei Fehlschlag vorherige Version samt passender
Datenbanksicherung wieder starten und in .env festhalten.
Es werden keine Programmdateien abgelegt, nichts entpackt und nichts gebaut.
' 'Helfi.Space – manual update

  ./update.sh                 pull and start the newest version (latest)
  ./update.sh 1.2.0           pull a specific version, record it in .env and start it
  ./update.sh -y              no prompts (on failure the previous version is restarted automatically)
  ./update.sh --offline helfi-1.2.0.tar.gz   without internet: load the image file from the release
  ./update.sh --cleanup       list leftovers from earlier updates and delete them after confirmation

Flow: remember the running image as "previous" → pull the new version → replace docker-compose.yml
if needed (only if unmodified; the old one is kept as docker-compose.yml.alt-<time>) →
start → wait for the health check → on failure restart the previous version with the matching
database backup and record it in .env.
No program files are stored, nothing is unpacked and nothing is built.
'
}

# shellcheck disable=SC2317 # called via trap
cleanup() { if [ -n "$MARKER" ]; then rm -f "$MARKER"; fi; }
trap cleanup EXIT
# dash does not run the EXIT trap on signals → clean up ourselves
trap 'cleanup; err "Abgebrochen." "Aborted."; exit 130' INT TERM HUP

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --offline) shift; OFFLINE="${1:-}"; [ -n "$OFFLINE" ] || { err "--offline braucht eine Image-Datei" "--offline needs an image file"; exit 2; } ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unbekannte Option: $1" "Unknown option: $1"; usage; exit 2 ;;
    *) VERSION="$1" ;;
  esac
  shift
done

valid_version() {
  [ "$1" = latest ] && return 0
  # 1.2.0 or a security update of it: 1.2.0-s1 (same program, newer packages)
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-s[1-9][0-9]*)?$'
}
if [ -n "$VERSION" ] && ! valid_version "$VERSION"; then
  err "Ungültige Version: $VERSION (Beispiel: 1.2.0, 1.2.0-s1 oder latest)" "Invalid version: $VERSION (example: 1.2.0, 1.2.0-s1 or latest)"; exit 2
fi

# Resolve a relative image file path before changing directory (relative to the calling directory)
case "$OFFLINE" in ''|/*) ;; *) OFFLINE="$(pwd)/$OFFLINE" ;; esac

# Work in the script's directory (docker-compose.yml and .env live there)
cd "$(dirname "$0")" || exit 1

ask() {
  # ask "German question" "English question" → 0 = yes (j/ja and y/yes are accepted in both languages)
  [ "$YES" = 1 ] && return 0
  printf '%s %s ' "$(msg "$1" "$2")" "$(msg '[j/N]' '[y/N]')"
  read -r answer || return 1
  case "$answer" in j|J|ja|Ja|y|Y|yes) return 0 ;; esac
  return 1
}

# --cleanup: remove leftovers from earlier updates. Only deletes what is on the fixed list,
# is a regular file (not a link) directly in this directory and is not itself mounted into a running
# container. Never: directories (data/, backups, mounts), .env, docker-compose.yml, links.
NL='
'
# Never touch names containing a newline: the list is read line by line, so
# ".env.tmp.1<newline>secret.key" would otherwise become "secret.key" (audit)
plain_name() { case "$1" in *"$NL"*) return 1 ;; esac; return 0; }

cleanup_candidates() {
  # 1. Older backup copies of docker-compose.yml (the newest is kept)
  for f in docker-compose.yml.alt-*; do
    plain_name "$f" || continue
    printf '%s\n' "$f" | grep -Eq '^docker-compose\.yml\.alt-[0-9]{8}-[0-9]{6}$' && printf '%s\n' "$f"
  done | sort | sed '$d'
  # 2. Image files from the release (for --offline; no longer needed once loaded)
  for f in helfi-*.tar helfi-*.tar.gz; do
    plain_name "$f" || continue
    printf '%s\n' "$f" | grep -Eq '^helfi-[0-9]+\.[0-9]+\.[0-9]+(-(amd64|arm64))?\.tar(\.gz)?$' && printf '%s\n' "$f"
  done
  # 3. Temporary files of aborted runs (older than one hour, so a running update is not disturbed)
  for f in .docker-compose.neu.* .docker-compose.hashes.* .env.tmp.* .update-start.* docker-compose.yml.tmp; do
    plain_name "$f" || continue
    if [ ! -f "$f" ] || [ -L "$f" ]; then continue; fi
    [ -n "$(find "./$f" -maxdepth 0 -type f -mmin +60 2>/dev/null)" ] && printf '%s\n' "$f"
  done
  # 4. docker-compose.yml.neu if it has already been adopted (identical content)
  if [ -f docker-compose.yml.neu ] && cmp -s docker-compose.yml.neu docker-compose.yml; then
    echo docker-compose.yml.neu
  fi
}

mounted_paths() {
  # Host paths of all mounts of running containers (resolved). Collect first: in a pipeline a failing
  # docker ps/inspect would be ignored and files could be deleted unprotected (audit).
  ids="$(docker ps -q)" || return 1
  raw=""
  for id in $ids; do
    one="$(docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$id")" || return 1
    raw="$raw$one$NL"
  done
  printf '%s' "$raw" | while IFS= read -r m; do
    [ -n "$m" ] || continue
    if [ -d "$m" ]; then (cd -P "$m" 2>/dev/null && pwd -P)
    elif [ -e "$m" ]; then printf '%s/%s\n' "$(cd -P "$(dirname "$m")" 2>/dev/null && pwd -P)" "$(basename "$m")"
    else printf '%s\n' "$m"; fi
  done
}

if [ "$CLEANUP" = 1 ]; then
  [ -f docker-compose.yml ] || { err "docker-compose.yml fehlt in $(pwd) – falscher Ordner?" "docker-compose.yml is missing in $(pwd) – wrong directory?"; exit 1; }
  here="$(pwd -P)"
  if ! docker ps -q >/dev/null 2>&1; then
    err "docker ist nicht erreichbar. Zum Schutz eingebundener Dateien wird nichts gelöscht." "docker is not reachable. To protect mounted files, nothing is deleted."; exit 1
  fi
  mounts="$(mounted_paths)" || { err "Mounts der Container nicht lesbar – nichts gelöscht." "Cannot read the container mounts – nothing deleted."; exit 1; }
  list="$(cleanup_candidates | while IFS= read -r f; do
    case "$f" in */*|''|.|..|.env|docker-compose.yml|data) continue ;; esac
    if [ ! -f "$f" ] || [ -L "$f" ]; then continue; fi
    full="$here/$f"
    # Mounted into a container as a file? (directories are never deleted anyway)
    if printf '%s\n' "$mounts" | grep -Fxq -- "$full"; then
      say "Übersprungen (von einem Container eingebunden): $f" "Skipped (mounted by a container): $f" >&2; continue
    fi
    printf '%s\n' "$f"
  done)"
  if [ -z "$list" ]; then say "Nichts aufzuräumen." "Nothing to clean up."; exit 0; fi
  say "Nicht mehr gebraucht:" "No longer needed:"
  printf '%s\n' "$list" | sed 's/^/  /'
  if ! ask "Diese Dateien löschen?" "Delete these files?"; then say "Nichts gelöscht." "Nothing deleted."; exit 0; fi
  printf '%s\n' "$list" | while IFS= read -r f; do
    [ -n "$f" ] && rm -f -- "$f" && say "Gelöscht: $f" "Deleted: $f"
  done
  exit 0
fi

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  err "docker compose wurde nicht gefunden." "docker compose was not found."; exit 1
fi

[ -f docker-compose.yml ] || { err "docker-compose.yml fehlt in $(pwd)" "docker-compose.yml is missing in $(pwd)"; exit 1; }
[ -f .env ] || { err ".env fehlt – bitte aus env.example erstellen." ".env is missing – please create it from env.example."; exit 1; }

env_get() {
  # Strip Windows line endings and quotes
  sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r"' | tr -d "'"
}

env_set() {
  # Set a value in .env (replace the existing line, otherwise append) – the rest of the file stays unchanged
  # Returns non-zero if .env could not be written.
  if grep -q "^$1=" .env; then
    tmp=".env.tmp.$$"
    rm -f "$tmp"
    # The copy contains HELFI_SECRET: create it readable for the owner only (umask in a subshell),
    # write back with cat so .env keeps its own mode and owner (audit)
    if ! (umask 077 && sed "s|^$1=.*|$1=$2|" .env > "$tmp"); then rm -f "$tmp"; return 1; fi
    # If writing back fails, .env may be incomplete: keep the complete copy for the user
    cat "$tmp" > .env || { ENV_KEPT="$tmp"; return 1; }
    rm -f "$tmp"
  else
    # Without a trailing newline the value would be glued to the last line
    if [ -s .env ] && [ "$(tail -c 1 .env | od -An -c | tr -d ' ')" != '\n' ]; then printf '\n' >> .env || return 1; fi
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
ENV_KEPT=""
env_kept_hint() {
  [ -n "$ENV_KEPT" ] && err "Vollständige Kopie der .env (bitte prüfen und zurückkopieren): $ENV_KEPT" \
      "Complete copy of .env (please check and copy it back): $ENV_KEPT"
  return 0
}
env_set_failed() {
  err "HELFI_VERSION konnte nicht in .env geschrieben werden (Rechte? Platz?) – bitte von Hand auf $1 setzen." \
      "Could not write HELFI_VERSION to .env (permissions? disk space?) – please set it to $1 by hand."
  env_kept_hint
}

compose_version_of() {
  sed -n 's/^[[:space:]]*HELFI_COMPOSE_VERSION:[[:space:]]*"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p' "$1" | head -n 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Address the container by its fixed name (also works if the compose project has a different name)
container_id() {
  docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null || dc ps -q "$SERVICE" 2>/dev/null | head -n 1
}

data_dir() {
  # Host path of the data directory (mount on /data) – independent of changes in docker-compose.yml
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$1" 2>/dev/null
}

# 1. Requested version (written to .env only after a successful pull)
OLD_TAG="$(env_get HELFI_VERSION)"
[ -n "$OLD_TAG" ] || OLD_TAG=latest
TAG="${VERSION:-$OLD_TAG}"
TARGET="$IMAGE_REPO:$TAG"

# 2. Remember the running image
PREV_ID=""
PREV_VERSION=""
DATA_DIR=""
CID="$(container_id)"
if [ -n "$CID" ]; then
  PREV_ID="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || true)"
  DATA_DIR="$(data_dir "$CID")"
  if [ -n "$PREV_ID" ]; then
    docker tag "$PREV_ID" "$IMAGE_REPO:previous" >/dev/null 2>&1 && say "Laufende Version gemerkt als $IMAGE_REPO:previous" "Running version saved as $IMAGE_REPO:previous"
    PREV_VERSION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$PREV_ID" 2>/dev/null || true)"
    valid_version "$PREV_VERSION" || PREV_VERSION=""
  fi
fi

# 3. Pull the new version
if [ -n "$OFFLINE" ]; then
  [ -f "$OFFLINE" ] || { err "Datei nicht gefunden: $OFFLINE" "File not found: $OFFLINE"; exit 1; }
  say "Lade Image aus $OFFLINE ..." "Loading image from $OFFLINE ..."
  loaded="$(docker load -i "$OFFLINE" | sed -n 's/^Loaded image: //p' | head -n 1)"
  [ -n "$loaded" ] || { err "In $OFFLINE wurde kein Image gefunden." "No image found in $OFFLINE."; exit 1; }
  if [ -z "$VERSION" ]; then
    # Without a version argument, use the version of the loaded image – otherwise the new image would
    # get the name of the old version from .env, and a later pull would be a downgrade (audit)
    VERSION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$loaded" 2>/dev/null || true)"
    if [ "$VERSION" = latest ] || ! valid_version "$VERSION"; then
      VERSION="${loaded##*:}"
      case "$loaded" in *:*) ;; *) VERSION="" ;; esac
    fi
    if [ "$VERSION" = latest ] || ! valid_version "$VERSION"; then
      err "Version des Images in $OFFLINE nicht erkennbar ($loaded) – nichts geändert." "Cannot determine the image version in $OFFLINE ($loaded) – nothing changed."
      err "Bitte die Version mit angeben, z. B.: ./update.sh --offline $(basename "$OFFLINE") 1.2.0" "Please also give the version, e.g.: ./update.sh --offline $(basename "$OFFLINE") 1.2.0"
      exit 1
    fi
    TAG="$VERSION"; TARGET="$IMAGE_REPO:$TAG"
  else
    # With a version argument: the loaded image must really be that version – otherwise e.g. a 1.3.0
    # image would be tagged :1.2.0 and pinned in .env, and a later pull of the real 1.2.0 would meet
    # a database already migrated by 1.3.0 (audit). Checked before any tag is set.
    label="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$loaded" 2>/dev/null || true)"
    if [ "$VERSION" != latest ] && [ "$label" != latest ] && valid_version "$label" && [ "$label" != "$VERSION" ]; then
      err "Das Image in $OFFLINE ist Version $label, nicht $VERSION – nichts geändert." "The image in $OFFLINE is version $label, not $VERSION – nothing changed."
      err "Bitte die passende Datei oder Version angeben, z. B.: ./update.sh --offline $(basename "$OFFLINE") $label" "Please give the matching file or version, e.g.: ./update.sh --offline $(basename "$OFFLINE") $label"
      exit 1
    fi
  fi
  if [ "$loaded" != "$TARGET" ]; then docker tag "$loaded" "$TARGET" || exit 1; fi
  say "Geladen: $loaded" "Loaded: $loaded"
else
  say "Hole $TARGET ..." "Pulling $TARGET ..."
  if ! HELFI_VERSION="$TAG" dc pull "$SERVICE"; then
    err "Herunterladen fehlgeschlagen – nichts geändert. Ohne Internet: ./update.sh --offline <Image-Datei aus dem Release>" "Download failed – nothing changed. Without internet: ./update.sh --offline <image file from the release>"
    exit 1
  fi
fi
# Record only now: the image is available locally
if [ -n "$VERSION" ]; then
  if ! env_set HELFI_VERSION "$VERSION"; then
    err "HELFI_VERSION konnte nicht in .env geschrieben werden (Rechte? Platz?) – nichts gestartet." \
        "Could not write HELFI_VERSION to .env (permissions? disk space?) – nothing started."
    env_kept_hint
    exit 1
  fi
  say "Version in .env festgehalten: $VERSION" "Version recorded in .env: $VERSION"
fi

NEW_ID="$(docker image inspect -f '{{.Id}}' "$TARGET" 2>/dev/null || true)"
if [ -n "$PREV_ID" ] && [ "$NEW_ID" = "$PREV_ID" ]; then
  say "Helfi.Space ist bereits auf dem neuesten Stand ($TAG)." "Helfi.Space is already up to date ($TAG)."
fi
NEW_VERSION="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$TARGET" 2>/dev/null || true)"

# 4. Take docker-compose.yml from the image if it is newer – but only if the existing
#    file is unmodified (otherwise own changes such as data paths would be lost)
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
      say "docker-compose.yml erneuert (Version ${have:-?} → $want). Die alte liegt als $alt daneben." "docker-compose.yml replaced (version ${have:-?} → $want). The old one is kept as $alt."
    else
      cat "$tmp_compose" > docker-compose.yml.neu
      say "HINWEIS: Die neue Version bringt eine neue docker-compose.yml (Version $want). Deine Datei wurde angepasst" \
          "NOTE: The new version ships a new docker-compose.yml (version $want). Your file has been customized"
      say "         und bleibt deshalb unverändert. Die neue liegt als docker-compose.yml.neu daneben – bitte Änderungen übernehmen." \
          "      and is therefore left unchanged. The new one is saved as docker-compose.yml.neu – please merge the changes."
    fi
  fi
fi
rm -f "$tmp_compose" "$tmp_hashes"

# 5. Start (timestamp: only backups from now on belong to this update)
MARKER=".update-start.$$"
: > "$MARKER"
sleep 1 # busybox find only compares whole seconds
UP_FAILED=0
# Same version as the pull: an HELFI_VERSION exported by the caller must not start another one (audit)
if ! HELFI_VERSION="$TAG" dc up -d "$SERVICE"; then
  # e.g. name in use or docker-compose.yml invalid: the old container may still be running –
  # do not report it as "new version running" then (audit)
  UP_FAILED=1
  err "Start der neuen Version fehlgeschlagen (docker compose up)." "Starting the new version failed (docker compose up)."
fi

# 6. Wait for the health check. $1 = expected image (empty = do not check), $2 = image that does NOT
#    count (the old container). A container still running with another image does not count as started.
LAST_HEALTH=""
wait_healthy() {
  waited=0
  LAST_HEALTH=""
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    cid="$(container_id)"
    if [ -n "$cid" ]; then
      img="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
      if { [ -z "${1:-}" ] || [ "$img" = "$1" ]; } && { [ -z "${2:-}" ] || [ "$img" != "$2" ]; }; then
        state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)"
        health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
        LAST_HEALTH="$health"
        if [ "$health" = "healthy" ] || { [ -z "$health" ] && [ "$state" = "running" ]; }; then return 0; fi
        case "$state" in exited|dead) return 1 ;; esac
        [ "$health" = "unhealthy" ] && return 1
      fi
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# Restore .env and docker-compose.yml to the state before the update (the new version never ran)
restore_files() {
  if [ "$COMPOSE_REPLACED" != 0 ]; then
    cp docker-compose.yml docker-compose.yml.neu
    cp "$COMPOSE_REPLACED" docker-compose.yml
    COMPOSE_REPLACED=0
    say "Vorherige docker-compose.yml wiederhergestellt (neue liegt als docker-compose.yml.neu daneben)." \
      "Previous docker-compose.yml restored (the new one is saved as docker-compose.yml.neu)."
  fi
  if [ -n "$VERSION" ]; then
    if env_set HELFI_VERSION "$OLD_TAG"; then
      say "Version in .env wieder auf $OLD_TAG." "Version in .env set back to $OLD_TAG."
    else
      env_set_failed "$OLD_TAG"
    fi
  fi
}

# Expect "no longer the old image" rather than exactly NEW_ID: if image: in docker-compose.yml points to
# an own registry, compose starts an image other than $TARGET – that is still the new version.
NOT_OLD=""
[ -n "$PREV_ID" ] && [ "$NEW_ID" != "$PREV_ID" ] && NOT_OLD="$PREV_ID"
if [ "$UP_FAILED" = 0 ]; then
  say "Warte auf den Start (höchstens ${WAIT_SECONDS}s) ..." "Waiting for startup (at most ${WAIT_SECONDS}s) ..."
  if wait_healthy "" "$NOT_OLD"; then
    say "Helfi.Space läuft (${NEW_VERSION:-$TAG})." "Helfi.Space is running (${NEW_VERSION:-$TAG})."
    exit 0
  fi
  # Still starting (e.g. backup and database migration on large databases): do not abort halfway
  if [ "$LAST_HEALTH" = starting ] && ask "Die neue Version startet noch (z. B. Datenbank-Umstellung). Noch einmal ${WAIT_SECONDS}s warten?" \
       "The new version is still starting (e.g. database migration). Wait another ${WAIT_SECONDS}s?"; then
    say "Warte noch einmal (höchstens ${WAIT_SECONDS}s) ..." "Waiting once more (at most ${WAIT_SECONDS}s) ..."
    if wait_healthy "" "$NOT_OLD"; then
      say "Helfi.Space läuft (${NEW_VERSION:-$TAG})." "Helfi.Space is running (${NEW_VERSION:-$TAG})."
      exit 0
    fi
  fi
  err "Die neue Version ist nicht gesund gestartet. Letzte Protokollzeilen:" "The new version did not start healthy. Last log lines:"
  dc logs --tail 30 "$SERVICE" >&2 2>/dev/null || true
fi

if [ -z "$PREV_ID" ]; then
  err "Es gibt keine vorherige Version zum Zurückgehen." "There is no previous version to go back to."
  [ "$UP_FAILED" = 1 ] && restore_files
  exit 1
fi

if ! ask "Vorherige Version wieder starten?" "Restart the previous version?"; then
  if [ "$UP_FAILED" = 1 ]; then
    restore_files
    say "Die neue Version wurde nicht gestartet. Bitte Meldung oben prüfen (z. B. docker compose config)." "The new version was not started. Please check the message above (e.g. docker compose config)."
    exit 1
  fi
  say "Die neue Version bleibt gestartet (sie hat die Datenbank evtl. schon umgestellt)." \
      "The new version stays running (it may already have migrated the database)."
  say "Zurück später mit: ./update.sh -y  nach Eintragen der alten Version in .env – die passende Sicherung" \
      "To go back later: enter the old version in .env, then ./update.sh -y  – the matching backup"
  say "liegt im Datenordner unter backups/helfi-vor-${NEW_VERSION:-<Version>}-*.sqlite bzw. *.sqlite.gz (siehe README)." \
      "is in the data directory under backups/helfi-vor-${NEW_VERSION:-<version>}-*.sqlite or *.sqlite.gz (see README)."
  exit 1
fi

# If the new version has already migrated the database, the old one needs the backup from before.
if [ -n "$NEW_VERSION" ]; then
  bdir="$DATA_DIR/backups"
  if [ -z "$DATA_DIR" ] || [ ! -d "$DATA_DIR" ]; then
    err "Datenordner des Containers nicht gefunden – die Datenbank wird NICHT zurückgespielt." \
        "Data directory of the container not found – the database will NOT be restored."
    err "Falls die alte Version nicht startet: Sicherung helfi-vor-$NEW_VERSION-*.sqlite(.gz) von Hand zurückspielen (README)." \
        "If the old version does not start: restore the backup helfi-vor-$NEW_VERSION-*.sqlite(.gz) by hand (README)."
  elif [ ! -r "$DATA_DIR" ] || [ ! -x "$DATA_DIR" ] || { [ -d "$bdir" ] && { [ ! -r "$bdir" ] || [ ! -x "$bdir" ]; }; }; then
    err "Der Datenordner $DATA_DIR bzw. seine Sicherungen sind für diesen Benutzer nicht lesbar –" \
        "The data directory $DATA_DIR or its backups are not readable for this user –"
    err "die Datenbank wird NICHT zurückgespielt. Bitte mit sudo ausführen (sudo ./update.sh -y) oder" \
        "the database will NOT be restored. Please run with sudo (sudo ./update.sh -y) or"
    err "die Sicherung helfi-vor-$NEW_VERSION-*.sqlite(.gz) von Hand zurückspielen (README)." \
        "restore the backup helfi-vor-$NEW_VERSION-*.sqlite(.gz) by hand (README)."
  else
    # Stop first, then search: otherwise the new version could finish its backup during the search
    # and migrate the database (audit). The previous version is restarted afterwards anyway.
    dc stop "$SERVICE" >/dev/null 2>&1 || true
    # Take the OLDEST complete backup since this update started (in restart loops, later ones may
    # already be partly migrated). .part or an accompanying -journal/-wal = not finished.
    backup=""; partial=""
    # Helfi.Space keeps this backup unpacked for a day; packed (.sqlite.gz) it is accepted too
    found="$(find "$bdir" -maxdepth 1 \( -name "helfi-vor-$NEW_VERSION-*.sqlite" -o -name "helfi-vor-$NEW_VERSION-*.sqlite.gz" -o -name "helfi-vor-$NEW_VERSION-*.sqlite.part" -o -name "helfi-vor-$NEW_VERSION-*.sqlite.gz.part" \) -newer "$MARKER" 2>/dev/null | sort)"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if [ "${f%.part}" != "$f" ] || [ -e "$f-journal" ] || [ -e "$f-wal" ]; then
        partial="$f"
      elif [ -z "$backup" ]; then
        backup="$f"
      fi
    done <<EOF_BACKUPS
$found
EOF_BACKUPS
    if [ -z "$backup" ] && [ -z "$partial" ]; then
      say "Keine Sicherung helfi-vor-$NEW_VERSION-*.sqlite(.gz) aus diesem Update gefunden – die neue Version hat die" \
          "No backup helfi-vor-$NEW_VERSION-*.sqlite(.gz) found from this update – so the new version has not"
      say "Datenbank demnach nicht umgestellt. Datenbank bleibt unverändert." \
          "migrated the database. The database stays unchanged."
    elif [ -z "$backup" ]; then
      # Aborted during the backup: migration only starts afterwards, so the database is unchanged
      err "Die Sicherung $partial ist unvollständig (Start wurde während der Sicherung abgebrochen)." \
          "The backup $partial is incomplete (startup was aborted during the backup)."
      err "Sie wird NICHT zurückgespielt; die Datenbank wurde noch nicht umgestellt und bleibt unverändert." \
          "It will NOT be restored; the database has not been migrated yet and stays unchanged."
    elif [ ! -r "$backup" ]; then
      err "Sicherung $backup ist nicht lesbar – Datenbank NICHT zurückgespielt. Bitte mit sudo ausführen." \
          "Backup $backup is not readable – database NOT restored. Please run with sudo."
    elif [ ! -f "$DATA_DIR/helfi.sqlite" ]; then
      err "$DATA_DIR/helfi.sqlite fehlt – nichts zurückgespielt. Sicherung: $backup" \
          "$DATA_DIR/helfi.sqlite is missing – nothing restored. Backup: $backup"
    else
      stamp="$(date +%Y%m%d-%H%M%S)"
      # Copy completely first, then swap – never be left without a database.
      # umask 077: the database holds password hashes – readable by the owner only, like the backup
      # (gzip -dc > file would otherwise create it with the shell's umask, e.g. 0644)
      restore_err=""
      case "$backup" in
        *.gz) restore() {
                if ! command -v gzip >/dev/null 2>&1; then
                  restore_err=1
                  err "gzip fehlt – die gepackte Sicherung $backup lässt sich nicht entpacken." "gzip is missing – the packed backup $backup cannot be unpacked."
                  return 1
                fi
                if ! (umask 077; gzip -dc "$backup" > "$DATA_DIR/helfi.sqlite.zurueck"); then
                  restore_err=1
                  err "Die gepackte Sicherung $backup ließ sich nicht entpacken (gzip -dc; beschädigt oder kein Platz?)." \
                      "The packed backup $backup could not be unpacked (gzip -dc; damaged or out of disk space?)."
                  return 1
                fi
              } ;;
        *) restore() { (umask 077; cp "$backup" "$DATA_DIR/helfi.sqlite.zurueck"); } ;;
      esac
      if restore && sync; then
        for ext in "" -wal -shm; do
          [ -f "$DATA_DIR/helfi.sqlite$ext" ] && mv "$DATA_DIR/helfi.sqlite$ext" "$DATA_DIR/helfi.sqlite.fehlgeschlagen-$stamp$ext"
        done
        mv "$DATA_DIR/helfi.sqlite.zurueck" "$DATA_DIR/helfi.sqlite"
        say "Datenbank aus $backup zurückgespielt (fehlgeschlagener Stand: helfi.sqlite.fehlgeschlagen-$stamp)." \
            "Database restored from $backup (failed state: helfi.sqlite.fehlgeschlagen-$stamp)."
        say "Achtung: Was seit dem Update eingegangen ist (z. B. Tickets aus E-Mails), steht nur im fehlgeschlagenen Stand." \
            "Caution: anything received since the update (e.g. tickets from emails) exists only in the failed state."
      else
        rm -f "$DATA_DIR/helfi.sqlite.zurueck"
        if [ -n "$restore_err" ]; then
          err "Datenbank unverändert." "Database unchanged."
        else
          err "Sicherung konnte nicht kopiert werden (Platz? Rechte?) – Datenbank unverändert." \
              "Could not copy the backup (disk space? permissions?) – database unchanged."
        fi
      fi
    fi
  fi
fi

# The old version also goes with the old docker-compose.yml
if [ "$COMPOSE_REPLACED" != 0 ]; then
  cp docker-compose.yml docker-compose.yml.neu
  cp "$COMPOSE_REPLACED" docker-compose.yml
  say "Vorherige docker-compose.yml wiederhergestellt (neue liegt als docker-compose.yml.neu daneben)." \
      "Previous docker-compose.yml restored (the new one is saved as docker-compose.yml.neu)."
fi

# Pin the old version so Watchtower/Dockhand do not immediately pull the broken one again
if [ -n "$PREV_VERSION" ]; then
  RUN_TAG="$PREV_VERSION"
  docker tag "$IMAGE_REPO:previous" "$IMAGE_REPO:$RUN_TAG" || exit 1
  if env_set HELFI_VERSION "$RUN_TAG"; then
    say "Version in .env auf $RUN_TAG festgehalten." "Version pinned to $RUN_TAG in .env."
  else
    env_set_failed "$RUN_TAG"
  fi
else
  # Old image without a version label: reset .env to the state before the update, do not leave it
  # on the broken new version (audit)
  RUN_TAG="$OLD_TAG"
  docker tag "$IMAGE_REPO:previous" "$IMAGE_REPO:$RUN_TAG" || exit 1
  env_set HELFI_VERSION "$RUN_TAG" || env_set_failed "$RUN_TAG"
  say "WARNUNG: Die vorherige Version hat keine Versionsangabe im Image. .env steht wieder auf $RUN_TAG." \
      "WARNING: The previous version has no version label in the image. .env is back on $RUN_TAG."
  if [ "$RUN_TAG" = latest ]; then
    say "         Watchtower/Dockhand oder das nächste Update holen damit wieder die neueste (fehlerhafte) Version –" \
        "         Watchtower/Dockhand or the next update will therefore pull the newest (broken) version again –"
    say "         bitte eine funktionierende Version in .env festhalten (HELFI_VERSION=1.2.3)." \
        "         please pin a working version in .env (HELFI_VERSION=1.2.3)."
  fi
fi
HELFI_VERSION="$RUN_TAG" dc up -d --pull never "$SERVICE" 2>/dev/null || HELFI_VERSION="$RUN_TAG" dc up -d "$SERVICE"
if wait_healthy "$PREV_ID"; then
  say "Vorherige Version läuft wieder." "Previous version is running again."
  exit 1
fi
err "Auch die vorherige Version startet nicht. Bitte Protokoll prüfen: docker compose logs $SERVICE" \
    "The previous version does not start either. Please check the log: docker compose logs $SERVICE"
exit 1
