#!/bin/sh
# Nachgebautes "docker" für Tests von update.sh. Protokolliert jeden Aufruf in $FAKE_LOG.
# Steuerung über Umgebung:
#   FAKE_HEALTH_NEW (healthy|unhealthy|exited)  Zustand der neuen Version
#   FAKE_NEW_VERSION / FAKE_PREV_VERSION         Versions-Label des neuen/laufenden Images
#   FAKE_IMAGE_COMPOSE / FAKE_IMAGE_HASHES       Dateien "im Image"
#   FAKE_DATA_DIR                                Host-Pfad des Mounts /data (Standard: $FAKE_DIR/data)
#   FAKE_PULL_FAIL=1                             Herunterladen schlägt fehl
#   FAKE_NO_CONTAINER=1                          kein laufender Container
#   FAKE_MOUNTS                                  weitere eingebundene Host-Pfade (eine Zeile je Pfad)
#   FAKE_DOCKER_DOWN=1                           docker-Daemon nicht erreichbar
#   FAKE_UP_FAIL=1                               "compose up" der neuen Version schlägt fehl (alter Container läuft weiter)
#   FAKE_HEALTH_NEW=starting, FAKE_HEALTHY_AFTER=N  neue Version meldet "starting", ab der N-ten Abfrage "healthy"
#   FAKE_BACKUP_JOURNAL=1                        neue Version hinterlässt eine halbfertige Sicherung (mit -journal)
#   FAKE_BACKUP_PART=1                           … bzw. nur unter dem Zwischennamen .sqlite.part
#   FAKE_LOAD_REF                                Name, den "docker load" meldet (Standard: …:9.9.9)
echo "$* [HELFI_VERSION=${HELFI_VERSION:-}]" >> "$FAKE_LOG"
phase_file="$FAKE_DIR/.fake-phase"
data="${FAKE_DATA_DIR:-$FAKE_DIR/data}"

[ -n "${FAKE_DOCKER_DOWN:-}" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }

case "$1" in
  ps) [ -n "${FAKE_NO_CONTAINER:-}" ] || echo "cid1"; exit 0 ;;
  compose)
    shift
    case "$1" in
      version) echo "Docker Compose version v2.99.0"; exit 0 ;;
      ps) [ -n "${FAKE_NO_CONTAINER:-}" ] || echo "cid1"; exit 0 ;;
      pull) [ -n "${FAKE_PULL_FAIL:-}" ] && exit 1; exit 0 ;;
      logs) echo "(fake logs)"; exit 0 ;;
      stop) exit 0 ;;
      up)
        if [ -n "${FAKE_UP_FAIL:-}" ] && ! echo "$*" | grep -q -- "--pull never"; then echo "yaml: unknown key" >&2; exit 1; fi
        if echo "$*" | grep -q -- "--pull never"; then
          echo old > "$phase_file"
        else
          echo new > "$phase_file"
          # neue Version sichert die Datenbank beim Start (wie das echte Programm)
          if [ -n "${FAKE_NEW_VERSION:-}" ] && [ -d "$data/backups" ]; then
            b="$data/backups/helfi-vor-$FAKE_NEW_VERSION-2026-10-31T12-00-00.sqlite"
            [ -n "${FAKE_BACKUP_PART:-}" ] && b="$b.part"
            printf sicherung-neu > "$b"
            [ -n "${FAKE_BACKUP_JOURNAL:-}" ] && printf halb > "$data/backups/helfi-vor-$FAKE_NEW_VERSION-2026-10-31T12-00-00.sqlite-journal"
          fi
          [ -f "$data/helfi.sqlite" ] && printf migriert > "$data/helfi.sqlite"
          [ -d "$data" ] && printf wal-neu > "$data/helfi.sqlite-wal"
        fi
        exit 0 ;;
    esac
    exit 0 ;;
  inspect)
    fmt="$3"
    case "$fmt" in
      *'.Id'*) [ -n "${FAKE_NO_CONTAINER:-}" ] && exit 1; echo "cid1" ;;
      *'println'*) echo "$data"; [ -n "${FAKE_MOUNTS:-}" ] && printf '%s\n' "$FAKE_MOUNTS" ;;
      *'.Mounts'*) echo "$data" ;;
      *'.Image'*) if [ "$(cat "$phase_file" 2>/dev/null)" = "new" ]; then echo "sha256:neu"; else echo "sha256:alt"; fi ;;
      *'.State.Health'*)
        if [ "$(cat "$phase_file" 2>/dev/null)" = "new" ]; then
          n=$(( $(cat "$FAKE_DIR/.fake-health-n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DIR/.fake-health-n"
          if [ -n "${FAKE_HEALTHY_AFTER:-}" ] && [ "$n" -ge "$FAKE_HEALTHY_AFTER" ]; then echo healthy; exit 0; fi
          case "${FAKE_HEALTH_NEW:-healthy}" in healthy) echo healthy ;; starting) echo starting ;; unhealthy) echo unhealthy ;; *) echo "" ;; esac
        else echo healthy; fi ;;
      *'.State.Status'*)
        if [ "$(cat "$phase_file" 2>/dev/null)" = "new" ] && [ "${FAKE_HEALTH_NEW:-}" = "exited" ]; then echo exited; else echo running; fi ;;
    esac
    exit 0 ;;
  image)
    # image inspect -f FMT REF
    case "$4" in
      *'.Id'*) echo "sha256:neu" ;;
      *) if [ "$5" = "sha256:alt" ]; then echo "${FAKE_PREV_VERSION:-}"; else echo "${FAKE_NEW_VERSION:-}"; fi ;;
    esac
    exit 0 ;;
  tag) exit 0 ;;
  run)
    case "$*" in
      *compose-hashes.txt*) [ -n "${FAKE_IMAGE_HASHES:-}" ] && cat "$FAKE_IMAGE_HASHES" && exit 0; exit 1 ;;
      *docker-compose.yml*) [ -n "${FAKE_IMAGE_COMPOSE:-}" ] && cat "$FAKE_IMAGE_COMPOSE" && exit 0; exit 1 ;;
    esac
    exit 1 ;;
  load)
    echo "Loaded image: ${FAKE_LOAD_REF:-ghcr.io/soleil0815/helfi.space.ticket:9.9.9}"; exit 0 ;;
esac
exit 0
