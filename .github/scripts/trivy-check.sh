#!/bin/sh
# Evaluates a Trivy JSON report: reports every fixable HIGH/CRITICAL vulnerability and every
# secret found (key, password in the image) as an error.
set -eu
f="$1"
[ -s "$f" ] || { echo "::error::Trivy report $f is missing"; exit 1; }
n="$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$f")"
s="$(jq '[.Results[]?.Secrets[]?] | length' "$f")"
jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? | "::error::\(.Severity) \(.VulnerabilityID) in \(.PkgName) \(.InstalledVersion) → \(.FixedVersion) (\($t))"' "$f"
jq -r '.Results[]? | .Target as $t | .Secrets[]? | "::error::Secret in image: \(.Severity) \(.RuleID)\(if .Title then " (\(.Title))" else "" end) in \($t)\(if .StartLine then ":\(.StartLine)" else "" end)"' "$f"
fail=0
[ "$n" = 0 ] || { echo "$n fixable vulnerabilities (HIGH/CRITICAL)"; fail=1; }
[ "$s" = 0 ] || { echo "$s secrets found in the image"; fail=1; }
[ "$fail" = 0 ] || exit 1
echo "No fixable HIGH/CRITICAL vulnerabilities, no secrets."
