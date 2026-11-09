#!/bin/sh
# Turns the Trivy reports of the published image into one issue:
# findings → open it (or update the open one), no findings → close an open one.
# Usage: sh scan-issue.sh <report> [<report> …]   (needs GH_TOKEN, GITHUB_REPOSITORY)
set -eu
TITLE="Published image: fixable vulnerabilities – new release needed"
LABEL="image-scan"
[ "$#" -gt 0 ] || { echo "::error::no Trivy report given"; exit 1; }
for f in "$@"; do [ -s "$f" ] || { echo "::error::Trivy report $f is missing"; exit 1; }; done

# One line per finding (deduplicated across architectures)
list="$(jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? |
  "| \(.Severity) | \(.VulnerabilityID) | \(.PkgName) | \(.InstalledVersion) | \(.FixedVersion) |"' "$@" | sort -u)"
n="$(printf '%s' "$list" | grep -c '^|' || true)"

existing="$(gh api "repos/$GITHUB_REPOSITORY/issues?state=open&labels=$LABEL&per_page=1" --jq '.[0].number // empty')"

if [ "$n" = 0 ]; then
  echo "No fixable HIGH/CRITICAL vulnerabilities in the published image."
  if [ -n "$existing" ]; then
    gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$existing/comments" -f body="The published image is clean again (scan $(date -u +%Y-%m-%d)). Closing." >/dev/null
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/$existing" -f state=closed -f state_reason=completed >/dev/null
    echo "Closed issue #$existing"
  fi
  exit 0
fi

body="$(printf '%s\n' \
  "The daily scan found **$n fixable HIGH/CRITICAL vulnerabilities** in \`ghcr.io/$GITHUB_REPOSITORY:latest\`." \
  "" \
  "They are fixed upstream (Alpine/Node packages or npm dependencies) – a new build picks them up." \
  "**To do:** nothing – the security update on patch day (second Tuesday of the month) picks them up. Urgent: start it now (Actions → Security update → Run workflow → main). If a fix needs a new dependency version: merge the Dependabot PRs and publish a release (Actions → CI → Run workflow)." \
  "" \
  "| Severity | ID | Package | Installed | Fixed in |" \
  "|---|---|---|---|---|" \
  "$list" \
  "" \
  "_Scan of $(date -u +%Y-%m-%d), run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID. This issue is updated daily and closed automatically once the published image is clean._")"

if [ -n "$existing" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/$existing" -f body="$body" >/dev/null
  echo "Updated issue #$existing ($n findings)"
else
  # Label once (ignore "already exists")
  gh api -X POST "repos/$GITHUB_REPOSITORY/labels" -f name="$LABEL" -f color=B60205 -f description="Weekly scan of the published image" >/dev/null 2>&1 || true
  num="$(gh api -X POST "repos/$GITHUB_REPOSITORY/issues" -f title="$TITLE" -f body="$body" -f "labels[]=$LABEL" --jq .number)"
  echo "Opened issue #$num ($n findings)"
fi
# Visible in the run as well
echo "$list" | sed 's/^/::warning::/'
