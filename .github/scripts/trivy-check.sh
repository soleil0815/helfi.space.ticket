#!/bin/sh
# Wertet einen Trivy-JSON-Bericht aus: jede behebbare HIGH/CRITICAL-Lücke als Fehler melden.
set -eu
f="$1"
[ -s "$f" ] || { echo "::error::Trivy-Bericht $f fehlt"; exit 1; }
n="$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$f")"
jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? | "::error::\(.Severity) \(.VulnerabilityID) in \(.PkgName) \(.InstalledVersion) → \(.FixedVersion) (\($t))"' "$f"
[ "$n" = 0 ] || { echo "$n behebbare Schwachstellen (HIGH/CRITICAL)"; exit 1; }
echo "Keine behebbaren HIGH/CRITICAL-Schwachstellen."
