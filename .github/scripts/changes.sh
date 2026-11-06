#!/bin/sh
# Which CI jobs does a pull request need? Writes code=… and ad=… (true/false) to $GITHUB_OUTPUT.
#   code: anything besides documentation changed → image build and scan
#   ad:   sign-in/AD code (src/auth, src/lib), dependencies, the Samba test setup or the workflows changed
#         → AD integration test
# Usage: changes.sh BASE_SHA HEAD_SHA   (anything other than a pull request: everything runs)
set -eu

out="${GITHUB_OUTPUT:-/dev/stdout}"
all() { printf 'code=true\nad=true\n' >> "$out"; exit 0; }

base="${1:-}"
head="${2:-}"
if [ -z "$base" ] || [ -z "$head" ]; then all; fi
files="$(git -c core.quotePath=false diff --name-only "$base...$head" 2>/dev/null)" || all
[ -n "$files" ] || all

code=false
ad=false
# one file per line, no globbing (names may contain spaces or *)
nl='
'
IFS="$nl"
set -f
for f in $files; do
  case "$f" in
    README.md|README.en.md|SECURITY.md|LICENSE|docs/*|*.md) ;;
    *) code=true ;;
  esac
  case "$f" in
    src/auth/*|src/lib/*|package.json|package-lock.json|scripts/test-samba-ad.sh|test/integration/*|.github/*) ad=true ;;
  esac
done
set +f
printf 'code=%s\nad=%s\n' "$code" "$ad" >> "$out"
printf 'Changed: code=%s ad=%s\n' "$code" "$ad"
