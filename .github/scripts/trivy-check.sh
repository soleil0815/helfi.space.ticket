#!/bin/sh
# Wertet einen Trivy-JSON-Bericht aus: jede behebbare HIGH/CRITICAL-Lücke und jedes gefundene
# Geheimnis (Schlüssel, Kennwort im Image) als Fehler melden.
set -eu
f="$1"
[ -s "$f" ] || { echo "::error::Trivy-Bericht $f fehlt"; exit 1; }
n="$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$f")"
s="$(jq '[.Results[]?.Secrets[]?] | length' "$f")"
jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? | "::error::\(.Severity) \(.VulnerabilityID) in \(.PkgName) \(.InstalledVersion) → \(.FixedVersion) (\($t))"' "$f"
jq -r '.Results[]? | .Target as $t | .Secrets[]? | "::error::Geheimnis im Image: \(.Severity) \(.RuleID)\(if .Title then " (\(.Title))" else "" end) in \($t)\(if .StartLine then ":\(.StartLine)" else "" end)"' "$f"
fail=0
[ "$n" = 0 ] || { echo "$n behebbare Schwachstellen (HIGH/CRITICAL)"; fail=1; }
[ "$s" = 0 ] || { echo "$s Geheimnisse im Image gefunden"; fail=1; }
[ "$fail" = 0 ] || exit 1
echo "Keine behebbaren HIGH/CRITICAL-Schwachstellen, keine Geheimnisse."
