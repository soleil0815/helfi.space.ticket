#!/bin/sh
# Keeps the "first seen" dates of fixable HIGH/CRITICAL vulnerabilities in the issue labelled "vuln-grace",
# so trivy-check.sh can allow them for a limited time (CRITICAL 7 days, HIGH 14 days; rules in vuln-grace.jq).
#   sh vuln-grace.sh read   <state.tsv>                       read the state (read-only token is enough)
#   sh vuln-grace.sh update <state.tsv> <report.json> …       add today's findings, update the issue (issues: write)
# Needs GH_TOKEN and GITHUB_REPOSITORY. GitHub errors never stop a release here: read writes "#unavailable"
# (trivy-check.sh then counts from the publish date), update keeps the merged state locally and warns.
# VULN_TODAY, VULN_EXCEPTIONS, VULN_RETRY_DELAY override date, exceptions file and retry pause (tests).
set -eu
LABEL="vuln-grace"
TITLE="Time-limited exceptions: fixable vulnerabilities without a usable fix"
dir="$(cd "$(dirname "$0")" && pwd)"
today="${VULN_TODAY:-$(date -u +%Y-%m-%d)}"
exc="${VULN_EXCEPTIONS:-$dir/../vuln-exceptions.tsv}"
cmd="${1:?read|update}"
out="${2:?state.tsv}"
shift 2

# gh with a few retries (GitHub 5xx happen – the release must not depend on one request)
gh_retry() {
  i=0; d="${VULN_RETRY_DELAY:-5}"
  until gh "$@"; do
    i=$((i + 1)); [ "$i" -lt 4 ] || return 1
    sleep "$d"; d=$((d * 2))
  done
}

# Newest issue with the label (open or closed) → "<number>" and the state block
fetch() {
  gh_retry api "repos/$GITHUB_REPOSITORY/issues?state=all&labels=$LABEL&per_page=1&sort=created&direction=desc" \
    --jq '.[0] // {} | "\(.number // "")\t\(.state // "")\n\(.body // "")"'
}
state_of() { # body on stdin → state lines
  awk '/^<!-- vuln-grace-state/{on=1; next} /^-->/{on=0} on && NF' | tr -d '\r'
}

if ! raw="$(fetch 2>fetch.err)"; then
  echo "::warning title=vuln-grace::Cannot read the issue \"$LABEL\" ($(head -c 300 fetch.err | tr '\n' ' ')) – counting from the publish date of each vulnerability"
  printf '#unavailable\n' > "$out"
  rm -f fetch.err
  exit 0
fi
rm -f fetch.err
head="$(printf '%s\n' "$raw" | head -n 1)"
num="$(printf '%s' "$head" | cut -f1)"
istate="$(printf '%s' "$head" | cut -f2)"
printf '%s\n' "$raw" | tail -n +2 | state_of > "$out"

if [ "$cmd" = read ]; then
  echo "Grace state: $(grep -c . "$out" || true) entries$( [ -n "$num" ] && echo " (issue #$num)")"
  exit 0
fi
[ "$cmd" = update ] || { echo "::error::unknown command $cmd"; exit 1; }
[ "$#" -gt 0 ] || { echo "::error::no Trivy report given"; exit 1; }
for f in "$@"; do [ -s "$f" ] || { echo "::error::Trivy report $f is missing"; exit 1; }; done

exc_text=""
[ ! -f "$exc" ] || exc_text="$(cat "$exc")"
old="$(cat "$out")"

# New state: today's findings get last = today (first seen kept or today);
# entries not seen for 30 days are dropped (a finding that comes back within 30 days keeps its date)
jq -r -s -L "$dir" --arg today "$today" --arg st "$old" '
  include "vuln-grace";
  state($st) as $s | addDays($today; -30) as $drop
  | (findings | map({ key: "\(.id)\t\(.pkg)", value: { first: ($s["\(.id)\t\(.pkg)"].first // $today), last: $today, sev: .sev, fixed: .fixed } }) | from_entries) as $now
  | ($s | with_entries(select(.value.last >= $drop))) + $now
  | to_entries | sort_by(.key)[] | "\(.key)\t\(.value.first)\t\(.value.last)\t\(.value.sev)\t\(.value.fixed)"
' "$@" > "$out.new"
mv "$out.new" "$out"

# Issue text: table for people + state block for the scripts
table="$(jq -r -n -L "$dir" --arg today "$today" --rawfile st "$out" --arg exc "$exc_text" '
  include "vuln-grace";
  exceptions($exc; $today) as $e
  | state($st) | to_entries[]
  | (.key | split("\t")) as [$id, $pkg]
  | decide({ id: $id, pkg: $pkg, sev: .value.sev, published: "" } ; { (.key): .value }; $e; $today; "state") as $d
  | "| \(.value.sev) | \($id) | \($pkg) | \(.value.fixed) | \(.value.first) | \($d.until) | "
    + (if .value.last != $today then "not seen since \(.value.last)"
       elif $d.allowed then "allowed\(if $d.exception then " – exception: \($d.exception.reason)" else "" end)"
       else "**blocks releases**" end) + " |"
')"
active="$(jq -r -n --arg today "$today" --rawfile st "$out" '
  [ $st | split("\n")[] | select(length > 0) | split("\t") | select(.[3] == $today) ] | length')"

if [ ! -s "$out" ] && [ -z "$num" ]; then
  echo "No fixable HIGH/CRITICAL vulnerabilities – no exceptions needed."
  exit 0
fi

body="$(printf '%s\n' \
  "Fixable HIGH/CRITICAL vulnerabilities that the build could not fix yet (e.g. the fixed version has no image or package yet). Releases go on with a **warning** until the time limit, afterwards they **block** again." \
  "" \
  "- Time limit: **CRITICAL 7 days, HIGH 14 days** from the day a finding was first seen." \
  "- Longer only with a reason: a line in \`.github/vuln-exceptions.tsv\` (ID, package or \`*\`, until YYYY-MM-DD at most 30 days ahead, reason) – via pull request." \
  "- Secrets in the image are never excepted." \
  "- Kept up to date by CI releases, the security update and the daily image scan; entries not seen for 30 days disappear." \
  "" \
  "| Severity | ID | Package | Fixed in | First seen | Allowed until | Status |" \
  "|---|---|---|---|---|---|---|" \
  "$table" \
  "" \
  "_Updated $today, run: ${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-0}. Do not edit the block below by hand._" \
  "" \
  "<!-- vuln-grace-state" \
  "$(cat "$out")" \
  "-->")"

want=open
[ "$active" != 0 ] || want=closed
if [ -z "$num" ]; then
  gh_retry api -X POST "repos/$GITHUB_REPOSITORY/labels" -f name="$LABEL" -f color=FBCA04 -f description="Time-limited exceptions for vulnerabilities" >/dev/null 2>&1 || true
  if [ "$want" = open ] && num="$(gh_retry api -X POST "repos/$GITHUB_REPOSITORY/issues" -f title="$TITLE" -f body="$body" -f "labels[]=$LABEL" --jq .number)"; then
    echo "Opened issue #$num ($active current findings)"
  elif [ "$want" = open ]; then
    echo "::warning title=vuln-grace::Cannot open the issue \"$LABEL\" – first-seen dates are not saved this time"
  fi
  exit 0
fi
if gh_retry api -X PATCH "repos/$GITHUB_REPOSITORY/issues/$num" -f body="$body" -f state="$want" >/dev/null; then
  [ "$istate" = "$want" ] || echo "Issue #$num is now $want"
  echo "Updated issue #$num ($active current findings)"
else
  echo "::warning title=vuln-grace::Cannot update issue #$num – first-seen dates of new findings are not saved this time"
fi
