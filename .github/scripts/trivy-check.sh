#!/bin/sh
# Evaluates a Trivy JSON report.
#   sh trivy-check.sh <report.json> [<state.tsv>]
# - Secrets found in the image (key, password) always fail – never excepted.
# - Fixable HIGH/CRITICAL vulnerabilities fail, unless they are within their time limit:
#   grace period from the day first seen (CRITICAL 7 days, HIGH 14 days; state from vuln-grace.sh read/update)
#   or an entry in .github/vuln-exceptions.tsv (at most 30 days ahead, with reason). Allowed ones are warnings.
#   Without <state.tsv>: no grace period, only the exceptions file. A state file starting with "#unavailable"
#   (issue could not be read): first seen = publish date of the vulnerability.
# VULN_TODAY (YYYY-MM-DD) and VULN_EXCEPTIONS (path) override the date and the file (tests).
set -eu
f="$1"
st="${2:-}"
dir="$(cd "$(dirname "$0")" && pwd)"
exc="${VULN_EXCEPTIONS:-$dir/../vuln-exceptions.tsv}"
today="${VULN_TODAY:-$(date -u +%Y-%m-%d)}"
[ -s "$f" ] || { echo "::error::Trivy report $f is missing"; exit 1; }

mode=strict
state_text=""
if [ -n "$st" ]; then
  if [ -f "$st" ]; then state_text="$(cat "$st")"; fi
  case "$state_text" in '#unavailable'*) mode=fallback ;; *) mode=state ;; esac
fi
exc_text=""
[ ! -f "$exc" ] || exc_text="$(cat "$exc")"

s="$(jq '[.Results[]?.Secrets[]?] | length' "$f")"
jq -r '.Results[]? | .Target as $t | .Secrets[]? | "::error::Secret in image: \(.Severity) \(.RuleID)\(if .Title then " (\(.Title))" else "" end) in \($t)\(if .StartLine then ":\(.StartLine)" else "" end)"' "$f"

# One line per finding: ALLOW|BLOCK <tab> message
lines="$(jq -r -s -L "$dir" --arg today "$today" --arg mode "$mode" --arg st "$state_text" --arg exc "$exc_text" '
  include "vuln-grace";
  exceptions($exc; $today) as $e
  | state($st) as $s
  | ($e.invalid[] | "WARNEXC\t\(.)"),
    (findings[] | decide(.; $s; $e; $today; $mode)
     | "\(.sev) \(.id) in \(.pkg) \(.installed) → \(.fixed) (\(.targets | join(", ")))" as $what
     | if .allowed then
         "ALLOW\t\($what): allowed until \(.until)"
         + (if .first then " (first seen \(.first), grace \(graceDays(.sev)) days" else " (" end)
         + (if .exception then "\(if .first then "; " else "" end)exception: \(.exception.reason)" else "" end) + ")"
       elif .first then "BLOCK\t\($what): time limit ended \(.until) (first seen \(.first)) – extend in .github/vuln-exceptions.tsv only with a reason"
       else "BLOCK\t\($what)" end)
' "$f")"

n=0; allowed=0
while IFS="$(printf '\t')" read -r kind msg; do
  case "$kind" in
    WARNEXC) echo "::warning title=vuln-exceptions.tsv::$msg" ;;
    ALLOW) allowed=$((allowed + 1)); echo "::warning title=Time-limited exception::$msg" ;;
    BLOCK) n=$((n + 1)); echo "::error::$msg" ;;
  esac
done <<EOF
$lines
EOF

fail=0
[ "$n" = 0 ] || { echo "$n fixable vulnerabilities (HIGH/CRITICAL) without a valid time limit"; fail=1; }
[ "$s" = 0 ] || { echo "$s secrets found in the image"; fail=1; }
[ "$allowed" = 0 ] || echo "$allowed fixable vulnerabilities allowed for a limited time (see warnings and the issue \"vuln-grace\")"
[ "$fail" = 0 ] || exit 1
[ "$allowed" != 0 ] || echo "No fixable HIGH/CRITICAL vulnerabilities, no secrets."
