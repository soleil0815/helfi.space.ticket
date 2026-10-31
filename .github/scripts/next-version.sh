#!/bin/sh
# Version für ein Release bestimmen.
# Aufruf: sh .github/scripts/next-version.sh <patch|minor|major|tag:v1.2.3>
#   patch/minor/major: höchsten Tag v*.*.* um eins hochzählen
#                      (ohne Tag: Version aus package.json als erste Version)
#   tag:v1.2.3:        Version aus einem von Hand gesetzten Tag übernehmen
# Ausgabe (für $GITHUB_OUTPUT): version=1.2.3 und latest=true|false
set -eu

mode="${1:-}"

is_version() { printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

highest="$(git tag -l 'v*.*.*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' |
  sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"

case "$mode" in
  tag:v*)
    v="${mode#tag:v}"
    is_version "$v" || { echo "Ungültiger Tag: ${mode#tag:}" >&2; exit 1; }
    ;;
  patch|minor|major)
    if [ -z "$highest" ]; then
      v="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
      is_version "$v" || { echo "Keine gültige Version in package.json: $v" >&2; exit 1; }
    else
      old_ifs="$IFS"; IFS=.
      # shellcheck disable=SC2086
      set -- $highest
      IFS="$old_ifs"
      case "$mode" in
        patch) v="$1.$2.$(($3 + 1))" ;;
        minor) v="$1.$(($2 + 1)).0" ;;
        major) v="$(($1 + 1)).0.0" ;;
      esac
    fi
    if [ -n "$(git tag -l "v$v")" ]; then
      echo "Tag v$v gibt es schon" >&2; exit 1
    fi
    highest="$v"
    ;;
  *)
    echo "Aufruf: next-version.sh <patch|minor|major|tag:v1.2.3>" >&2; exit 2 ;;
esac

echo "version=$v"
if [ "$v" = "$highest" ]; then echo "latest=true"; else echo "latest=false"; fi
