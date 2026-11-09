#!/bin/sh
# Differences between two package lists (image-packages.sh) as Markdown for the release notes.
# Usage: sh .github/scripts/package-diff.sh <old list> <new list>
# Exit code 0 = something changed (list printed), 3 = nothing changed.
set -eu
old="${1:?old list}"
new="${2:?new list}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sort -u "$old" > "$tmp/old"
sort -u "$new" > "$tmp/new"
if cmp -s "$tmp/old" "$tmp/new"; then exit 3; fi
comm -13 "$tmp/old" "$tmp/new" > "$tmp/added"
comm -23 "$tmp/old" "$tmp/new" > "$tmp/removed"
if [ -s "$tmp/added" ]; then
  echo "**New or updated:**"
  # shellcheck disable=SC2016 # backticks are Markdown, not a command
  sed 's/^\(.*\)$/- `\1`/' "$tmp/added"
fi
if [ -s "$tmp/removed" ]; then
  [ ! -s "$tmp/added" ] || echo
  echo "**Replaced or removed:**"
  # shellcheck disable=SC2016 # backticks are Markdown, not a command
  sed 's/^\(.*\)$/- `\1`/' "$tmp/removed"
fi
