#!/bin/sh
# Version and tag of the next security update: same program as the highest release, only newer packages.
# Usage: sh .github/scripts/security-tag.sh   (needs the git tags and origin/main: fetch-depth 0;
#        gh with GH_TOKEN and GITHUB_REPOSITORY)
# Output (for $GITHUB_OUTPUT): version=1.36.0 and tag=1.36.0-s1 (next free number for this version;
# a new program version starts again at s1)
#
# "Released" means: a git tag v<version> (no leading zeros, no "-s<n>") whose commit is on main AND a published
# (non-draft) GitHub release for that tag. A tag alone is not enough: the CI release reserves the tag before it
# publishes, so a failed release leaves a tag without image and release, and a hand-made tag on another branch
# was never tested. Such tags are skipped (the next lower version is taken). Any other API or git error stops.
set -eu

[ -n "${GITHUB_REPOSITORY:-}" ] || { echo "GITHUB_REPOSITORY is not set" >&2; exit 1; }
git rev-parse --verify -q 'origin/main^{commit}' >/dev/null ||
  { echo "origin/main is missing – check out with fetch-depth 0" >&2; exit 1; }

# Program releases only (no leading zeros, no "-s<n>"), highest first
VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
candidates="$(git tag -l 'v*.*.*' | sed 's/^v//' | grep -E "$VERSION_RE" |
  sort -t. -k1,1nr -k2,2nr -k3,3nr || true)"

v=""
for c in $candidates; do
  rc=0
  git merge-base --is-ancestor "v$c^{commit}" 'origin/main^{commit}' || rc=$?
  case "$rc" in
    0) ;;
    1) echo "Skipped v$c: the tag is not on main" >&2; continue ;;
    *) echo "Cannot check whether v$c is on main (git exit code $rc)" >&2; exit 1 ;;
  esac
  # Only "404 Not Found" means "no release" – any other API error stops (never guess)
  if draft="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/v$c" --jq .draft 2>&1)"; then
    if [ "$draft" = false ]; then v="$c"; break; fi
    echo "Skipped v$c: the GitHub release is a draft" >&2
  else
    case "$draft" in
      *"Not Found"*|*"HTTP 404"*) echo "Skipped v$c: no GitHub release (unfinished or failed release?)" >&2 ;;
      *) echo "Cannot check the GitHub release of v$c: $draft" >&2; exit 1 ;;
    esac
  fi
done
[ -n "$v" ] || { echo "No release yet – publish a program version first" >&2; exit 1; }

n="$(git tag -l "v$v-s*" | sed "s/^v$v-s//" | grep -E '^[1-9][0-9]*$' | sort -n | tail -n 1 || true)"
echo "version=$v"
echo "tag=$v-s$(( ${n:-0} + 1 ))"
