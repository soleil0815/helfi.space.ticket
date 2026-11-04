#!/bin/sh
# Starts a test Active Directory (Samba AD DC) for the integration tests.
# Only for test machines/CI (needs root and the packages samba, samba-ad-dc, samba-ad-provision).
#
#   sudo scripts/test-samba-ad.sh
#   HELFI_TEST_LDAP_HOST=dc01.firma.local npm run test:integration
set -eu

DIR="${SAMBA_TEST_DIR:-/tmp/helfi-samba-ad}"
PY="$(command -v python3.12 || command -v python3)"
SAMBA_TOOL="$(command -v samba-tool)"
tool() { "$PY" "$SAMBA_TOOL" "$@"; }

grep -q 'dc01.firma.local' /etc/hosts || echo '127.0.0.1 dc01.firma.local dc01' >> /etc/hosts
rm -rf "$DIR"

tool domain provision --realm=FIRMA.LOCAL --domain=FIRMA --server-role=dc --dns-backend=NONE \
  --adminpass='Passw0rd!2026' --targetdir="$DIR" --host-name=dc01 \
  --option="interfaces=lo" --option="bind interfaces only=yes" >/dev/null

ad() { tool "$@" -s "$DIR/etc/smb.conf" -H "$DIR/private/sam.ldb" >/dev/null; }
ad user create svc-helfi 'Dienst!Pass2026' --given-name=Helfi --surname=Dienst
ad user create m.muster 'Muster!Pass2026' --given-name=Max --surname=Muster --mail-address=m.muster@firma.local
ad user create e.beispiel 'Beispiel!Pass2026' --given-name=Erika --surname=Beispiel --mail-address=e.beispiel@firma.local
ad user create k.kunde 'Kunde!Pass2026' --given-name=Karl --surname=Kunde --mail-address=k.kunde@firma.local
# disabled account (sender lookup by email must not find it)
ad user create d.alt 'Alt!Pass2026' --given-name=Dora --surname=Alt --mail-address=d.alt@firma.local
ad user disable d.alt
ad group add Helfi-Admins
ad group add Helfi-Bearbeiter
ad group add IT-Team
# nested: e.beispiel → IT-Team → Helfi-Admins
ad group addmembers IT-Team e.beispiel
ad group addmembers Helfi-Admins IT-Team
ad group addmembers Helfi-Bearbeiter m.muster

samba -D -s "$DIR/etc/smb.conf"

# Wait until LDAPS responds
i=0
while [ "$i" -lt 60 ]; do
  if (echo | openssl s_client -connect 127.0.0.1:636 >/dev/null 2>&1); then
    echo "Samba AD is running (dc01.firma.local, LDAPS 636)"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done
echo "Samba AD did not start" >&2
exit 1
