#!/bin/sh
# ZAP scan of the running program – part of the monthly code audit (same in all programs).
# Starts the image in a throwaway container (hardened as in docker-compose.yml, test data only), completes the
# initial setup with a random throwaway admin (nobody logs in with it – ZAP scans WITHOUT login), then runs ZAP:
# spider, passive and active scan (zap-full-scan.py) against this container only – never against real servers.
#   sh .github/scripts/zap-scan.sh <image> <report directory>
# Env: ZAP_IMAGE (required, pinned by digest), ZAP_MINUTES (active scan limit, default 25)
# Report: zap-report.html / .json / .md in the report directory. Findings do not fail (the code audit evaluates
# them); a scan that could not run does. Known false positives: .zap/rules.tsv (IGNORE with reason).
set -eu
IMG="${1:?image}"
OUT="${2:?report directory}"
ZAP="${ZAP_IMAGE:?ZAP_IMAGE (pinned image) missing}"
MINUTES="${ZAP_MINUTES:-25}"
NET="helfi-zap-$$"
APP="helfi-zap-app"
PORT=18090
DATA="$(mktemp -d)"

cleanup() {
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() {
  # container log without the setup code (throwaway, but it does not belong in a public log)
  echo "::error title=ZAP scan::$1 | $(docker logs "$APP" 2>&1 | grep -viE 'setup code|Einrichtungscode' | tail -n 8 | tr '\n' '|')"
  exit 1
}

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"   # absolute: docker -v would take a relative name for a named volume
chmod 777 "$OUT"   # ZAP writes its reports as its own user
[ ! -f .zap/rules.tsv ] || cp .zap/rules.tsv "$OUT/rules.tsv"
docker network create "$NET" >/dev/null
docker run -d --name "$APP" --network "$NET" -p "127.0.0.1:$PORT:8080" -v "$DATA:/data" \
  -e HELFI_COMPOSE_VERSION=1 -e "HELFI_BASE_URL=http://$APP:8080" \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
  "$IMG" >/dev/null || fail "docker run"

i=0
while [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)" != healthy ]; do
  [ "$(docker inspect -f '{{.State.Status}}' "$APP")" = running ] || fail "container is no longer running"
  i=$((i + 1))
  [ "$i" -le 45 ] || fail "not healthy"
  sleep 2
done

# Initial setup with a throwaway admin: random password, never stored or printed
code="$(docker logs "$APP" 2>&1 | sed -n 's/.*[Ss]etup code: *\([^ ]*\).*/\1/p' | tail -n 1)"
[ -n "$code" ] || fail "no setup code in the log"
pw="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
body="$(printf '{"token":"%s","username":"zap-admin","password":"%s","language":"de","projectKey":"IT","projectName":"Helpdesk"}' "$code" "$pw")"
unset pw
curl -fsS -o /dev/null -H 'Content-Type: application/json' -H 'X-Helfi-Request: 1' \
  --data "$body" "http://127.0.0.1:$PORT/api/setup" || fail "initial setup failed"
unset body

# ZAP: spider (max. 5 min), passive and active scan (max. $MINUTES min), no login. Exit codes of
# zap-full-scan.py: 0 = no warnings, 1 = FAIL rules, 2 = warnings, 3 = scan error.
set -- zap-full-scan.py -t "http://$APP:8080" -m 5 -I \
  -r zap-report.html -J zap-report.json -w zap-report.md \
  -z "-config scanner.maxScanDurationInMins=$MINUTES"
[ ! -f "$OUT/rules.tsv" ] || set -- "$@" -c rules.tsv
rc=0
docker run --rm --network "$NET" -v "$OUT:/zap/wrk:rw" "$ZAP" "$@" || rc=$?
[ "$rc" -le 2 ] || fail "ZAP could not run the scan (exit code $rc)"
[ -s "$OUT/zap-report.json" ] || fail "ZAP wrote no report"
echo "ZAP image: $(docker image inspect -f '{{join .RepoDigests " "}}' "$ZAP" 2>/dev/null)"

# Summary: alerts per risk level (High/Medium/Low/Informational)
summary="$(jq -r '[.site[]?.alerts[]? | (.riskdesc | split(" ")[0])] | group_by(.) | map("\(.[0]): \(length)") | join(", ")' "$OUT/zap-report.json")"
echo "ZAP findings: ${summary:-none}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ZAP scan (no login): ${summary:-no findings}"
    echo
    jq -r '.site[]?.alerts[]? | "- **\(.riskdesc | split(" ")[0])** – \(.name) (rule \(.pluginid), \(.count) occurrences)"' "$OUT/zap-report.json"
  } >> "$GITHUB_STEP_SUMMARY"
fi
