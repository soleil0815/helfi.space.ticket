#!/bin/sh
# Version and tag of the next security update: same program as the highest release, only newer packages.
# Usage: sh .github/scripts/security-tag.sh   (needs the git tags: fetch-depth 0)
# Output (for $GITHUB_OUTPUT): version=1.36.0 and tag=1.36.0-s1 (next free number for this version;
# a new program version starts again at s1)
set -eu

# Program releases only (no leading zeros, no "-s<n>")
VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
v="$(git tag -l 'v*.*.*' | sed 's/^v//' | grep -E "$VERSION_RE" |
  sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
[ -n "$v" ] || { echo "No release yet – publish a program version first" >&2; exit 1; }

n="$(git tag -l "v$v-s*" | sed "s/^v$v-s//" | grep -E '^[1-9][0-9]*$' | sort -n | tail -n 1 || true)"
echo "version=$v"
echo "tag=$v-s$(( ${n:-0} + 1 ))"
