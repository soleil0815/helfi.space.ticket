#!/bin/sh
# Scans an image for fixable HIGH/CRITICAL vulnerabilities and writes the JSON report; the evaluation is done by
# trivy-check.sh (releases) or scan-issue.sh (published image). Trivy comes from install-trivy.sh (no GitHub Action).
#   sh .github/scripts/trivy-scan.sh <image> <report.json> [platform, e.g. linux/arm64]
set -eu
img="${1:?image}"
out="${2:?report}"
platform="${3:-}"
trivy="${TRIVY:-${RUNNER_TEMP:-/tmp}/trivy/trivy}"
[ -x "$trivy" ] || { echo "::error title=Trivy::$trivy missing – run install-trivy.sh first"; exit 1; }
set -- image --quiet --scanners vuln --severity CRITICAL,HIGH --ignore-unfixed --format json --output "$out"
[ -z "$platform" ] || set -- "$@" --platform "$platform"
# exit code 0: the report decides (trivy-check.sh / scan-issue.sh), a failed scan still stops (set -e)
"$trivy" "$@" "$img"
