# Shared rules for time-limited exceptions of fixable HIGH/CRITICAL vulnerabilities
# (used by trivy-check.sh and vuln-grace.sh via `jq -L .github/scripts 'include "vuln-grace"; …'`).
#
# A finding that no build can fix yet (e.g. the fixed Node version has no Docker image yet) must not stop
# every release. So a finding is allowed for a grace period counted from the day it was FIRST SEEN:
#   CRITICAL 7 days, HIGH 14 days. Afterwards it blocks releases again.
# Longer only by an entry in .github/vuln-exceptions.tsv: ID, package (* = any), until (YYYY-MM-DD,
# at most 30 days ahead), reason. Secrets are never excepted (trivy-check.sh).
#
# State (first seen) lives in the issue labelled "vuln-grace" (vuln-grace.sh), one TSV line per finding:
#   ID  package  first-seen  last-seen  severity  fixed-version

def graceDays($sev): if $sev == "CRITICAL" then 7 else 14 end;
def addDays($d; $n): ($d + "T00:00:00Z" | fromdateiso8601) + ($n * 86400) | strftime("%Y-%m-%d");
def isDate: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");

# TSV text → array of field arrays (blank lines and # comments ignored)
def tsv: split("\n") | map(sub("\r$"; "")) | map(select(length > 0 and (startswith("#") | not)) | split("\t"));

# Findings of Trivy reports (array of reports) – one per ID + package, deduplicated across architectures
def findings: [ .[] | .Results[]? | .Target as $t | .Vulnerabilities[]?
    | { id: .VulnerabilityID, pkg: .PkgName, sev: .Severity, installed: .InstalledVersion, fixed: .FixedVersion,
        published: ((.PublishedDate // "")[0:10]), target: $t } ]
  | group_by([.id, .pkg]) | map(.[0] + { targets: (map(.target) | unique) });

# Exceptions file → { valid: [...], invalid: [message] }
def exceptions($text; $today):
  ($text | tsv) as $rows
  | addDays($today; 30) as $max
  | { valid: [ $rows[] | select(length >= 4 and (.[2] | isDate) and .[2] >= $today and .[2] <= $max and (.[3] | length) > 0)
               | { id: .[0], pkg: .[1], until: .[2], reason: .[3] } ],
      invalid: [ $rows[]
               | if length < 4 or (.[3] | length) == 0 then "\(.[0] // "?"): needs ID, package, date and a reason"
                 elif (.[2] | isDate | not) then "\(.[0]): date \(.[2]) is not YYYY-MM-DD"
                 elif .[2] > $max then "\(.[0]): until \(.[2]) is more than 30 days ahead – not accepted"
                 else empty end ] };

# State text → { "ID\tpkg": {first, last, sev, fixed} }
def state($text): [ $text | tsv[] | select(length >= 4) | { key: "\(.[0])\t\(.[1])", value: { first: .[2], last: .[3], sev: (.[4] // ""), fixed: (.[5] // "") } } ] | from_entries;

# Decision for one finding $f. $mode: "state" (first seen from $st, unknown = today),
# "fallback" (state unreadable: first seen = publish date of the vulnerability, else today), "strict" (no grace)
def decide($f; $st; $exc; $today; $mode):
  ($st["\($f.id)\t\($f.pkg)"].first) as $known
  | (if $mode == "strict" then null
     elif $known then $known
     elif $mode == "fallback" and ($f.published | isDate) then $f.published
     else $today end) as $first
  | (if $first then addDays($first; graceDays($f.sev)) else null end) as $grace
  | ([ $exc.valid[] | select(.id == $f.id and (.pkg == $f.pkg or .pkg == "*")) ] | max_by(.until)) as $e
  | ([ $grace, $e.until ] | map(select(. != null)) | max) as $until
  | $f + { first: $first, grace: $grace, exception: $e, until: $until, allowed: ($until != null and $today <= $until) };
