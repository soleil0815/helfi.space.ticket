#!/bin/sh
# Determine the version for a release.
# Usage: sh .github/scripts/next-version.sh <patch|minor|major|tag:v1.2.3>
#   patch/minor/major: increment the highest tag v*.*.* by one
#                      (no tag yet: the version from package.json is the first version)
#   tag:v1.2.3:        take the version from a manually set tag
# Output (for $GITHUB_OUTPUT): version=1.2.3 and latest=true|false
set -eu

mode="${1:-}"

# No leading zeros: "08" would be an (invalid) octal number in $((...)), "010" would give 8 (audit)
VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
is_version() { printf '%s\n' "$1" | grep -Eq "$VERSION_RE"; }

highest="$(git tag -l 'v*.*.*' | sed 's/^v//' | grep -E "$VERSION_RE" |
  sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"

case "$mode" in
  tag:v*)
    v="${mode#tag:v}"
    is_version "$v" || { echo "Invalid tag: ${mode#tag:}" >&2; exit 1; }
    ;;
  patch|minor|major)
    if [ -z "$highest" ]; then
      v="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
      is_version "$v" || { echo "No valid version in package.json: $v" >&2; exit 1; }
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
      echo "Tag v$v already exists" >&2; exit 1
    fi
    highest="$v"
    ;;
  *)
    echo "Usage: next-version.sh <patch|minor|major|tag:v1.2.3>" >&2; exit 2 ;;
esac

echo "version=$v"
if [ "$v" = "$highest" ]; then echo "latest=true"; else echo "latest=false"; fi
