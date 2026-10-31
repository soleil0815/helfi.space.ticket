#!/bin/sh
# Nachgebautes "docker" für Tests von update.sh. Protokolliert jeden Aufruf in $FAKE_LOG.
# Steuerung über Umgebung: FAKE_HEALTH_NEW (healthy|unhealthy|exited), FAKE_NEW_VERSION,
# FAKE_IMAGE_COMPOSE (Pfad zur docker-compose.yml "im Image"), FAKE_DIR (Arbeitsordner).
echo "$*" >> "$FAKE_LOG"
phase_file="$FAKE_DIR/.fake-phase"

case "$1" in
  compose)
    shift
    case "$1" in
      version) echo "Docker Compose version v2.99.0"; exit 0 ;;
      ps) echo "cid1"; exit 0 ;;
      pull) exit 0 ;;
      logs) echo "(fake logs)"; exit 0 ;;
      stop) exit 0 ;;
      up)
        if echo "$*" | grep -q -- "--pull never"; then
          echo old > "$phase_file"
        else
          echo new > "$phase_file"
          # neue Version sichert die Datenbank beim Start (wie das echte Programm)
          if [ -n "${FAKE_NEW_VERSION:-}" ] && [ -d "$FAKE_DIR/data/backups" ]; then
            printf sicherung-neu > "$FAKE_DIR/data/backups/helfi-vor-$FAKE_NEW_VERSION-2026-10-31T12-00-00.sqlite"
          fi
          [ -f "$FAKE_DIR/data/helfi.sqlite" ] && printf migriert > "$FAKE_DIR/data/helfi.sqlite"
        fi
        exit 0 ;;
    esac
    exit 0 ;;
  inspect)
    fmt="$3"
    case "$fmt" in
      *'.Image'*) echo "sha256:alt" ;;
      *'.State.Health'*)
        if [ "$(cat "$phase_file" 2>/dev/null)" = "new" ]; then
          case "${FAKE_HEALTH_NEW:-healthy}" in healthy) echo healthy ;; unhealthy) echo unhealthy ;; *) echo "" ;; esac
        else echo healthy; fi ;;
      *'.State.Status'*)
        if [ "$(cat "$phase_file" 2>/dev/null)" = "new" ] && [ "${FAKE_HEALTH_NEW:-}" = "exited" ]; then echo exited; else echo running; fi ;;
    esac
    exit 0 ;;
  image)
    case "$4" in
      *'.Id'*) echo "sha256:neu" ;;
      *) echo "${FAKE_NEW_VERSION:-}" ;;
    esac
    exit 0 ;;
  tag) exit 0 ;;
  run)
    if [ -n "${FAKE_IMAGE_COMPOSE:-}" ]; then cat "$FAKE_IMAGE_COMPOSE"; exit 0; fi
    exit 1 ;;
  load)
    echo "Loaded image: ghcr.io/soleil0815/helfi.space.ticket:9.9.9"; exit 0 ;;
esac
exit 0
