<p align="center"><img src="public/logo.svg" width="72" alt=""></p>

# Helfi.Space

Ein schlankes Ticketsystem für IT-Abteilungen und Institute. Die Oberfläche ist an Jira angelehnt, es gibt sie auf Deutsch und Englisch. Helfi.Space läuft als ein einzelner Docker-Container mit SQLite.

*English summary below.*

- **Active Directory** (Windows Server oder Samba AD): Anmeldung mit Windows-Konten, Rollen über AD-Gruppen (auch verschachtelt), **LDAPS-Zertifikat per Knopfdruck abrufen**
- **Single Sign-on** über OpenID Connect: Microsoft Entra ID, ADFS, Keycloak, Authentik …
- **E-Mail → Ticket:** Ein Postfach wird per IMAP abgerufen, neue Mails werden zu Tickets und Antworten landen im passenden Ticket. Melder bekommen Antworten per E-Mail.
- **Jira-ähnlich:** Board mit Drag & Drop, Ticketliste mit Filtern, Ticketansicht mit Details, Kommentaren, internen Notizen, Anhängen und Verlauf
- **Rollen:** Administrator, Bearbeiter, Benutzer. Benutzer sehen nur ihre eigenen Anfragen.
- **Lokaler Notfall-Admin:** Er wird bei der Ersteinrichtung angelegt und funktioniert auch, wenn das AD nicht erreichbar ist.
- Automatische Sicherungen täglich und vor jedem Update

---

## Installation

Voraussetzung: Docker mit Compose (Linux-Server, Synology, …).

```sh
mkdir helfi && cd helfi
# docker-compose.yml und .env.example aus dem neuesten Release herunterladen
cp .env.example .env
nano .env            # mindestens HELFI_BASE_URL anpassen
docker compose up -d
docker compose logs helfi   # zeigt den Einrichtungscode
```

Dann `HELFI_BASE_URL` im Browser öffnen. Der Einrichtungsassistent fragt nach dem **Einrichtungscode** aus dem Protokoll und legt den **lokalen Administrator** und das erste Projekt an. Danach geht es direkt zur AD-Einrichtung.

> **Repository noch privat?** Dann braucht der Server einmalig eine Anmeldung bei ghcr.io:
> `docker login ghcr.io -u <GitHub-Name>` mit einem Personal Access Token (Recht `read:packages`).

Auf dem Host liegen nur drei Dinge:

| | |
|---|---|
| `docker-compose.yml` | bleibt bei Updates in der Regel gleich |
| `.env` | deine Einstellungen (Adresse, Port, Version, PUID/PGID) |
| `data/` | Datenbank, Anhänge, Sicherungen, Schlüsseldatei |

**Synology:** In der `.env` `PUID`/`PGID` auf deinen Benutzer setzen (z. B. `1026`/`100`, siehe `id` per SSH), damit die Dateien in `data/` dir gehören.

### HTTPS (empfohlen)

Helfi.Space selbst spricht HTTP auf Port 8080. Für den Betrieb gehört ein Reverse-Proxy mit HTTPS davor (Synology-Reverse-Proxy, Nginx Proxy Manager, Caddy, Traefik …). Danach `HELFI_BASE_URL=https://helfi.firma.local` setzen. Cookies werden dann automatisch als `Secure` markiert.

Damit die Bremse gegen Kennwort-Raten die echte Client-Adresse sieht, trägst du in der `.env` die Adresse des Proxys ein, z. B. `HELFI_TRUST_PROXY=10.0.10.5`. Ohne diesen Eintrag glaubt Helfi.Space keiner `X-Forwarded-For`-Angabe, weil sie sich sonst fälschen ließe.

Beispiel Caddy:

```
helfi.firma.local {
    reverse_proxy 10.0.10.20:8080
}
```

---

## Active Directory einrichten

*Administration → Active Directory*

1. **Domänencontroller** eintragen, und zwar mit dem Namen, der im Zertifikat steht (z. B. `dc01.firma.local`). Verschlüsselung: **LDAPS (636)** oder **StartTLS (389)**.
2. **Zertifikat abrufen** holt das Zertifikat direkt vom DC und zeigt den SHA-256-Fingerabdruck. Vergleiche ihn mit dem am Server und klicke dann **Zertifikat übernehmen**.
   - Windows: `certlm.msc` → Eigene Zertifikate → Zertifikat des DCs → Details → Fingerabdruck (SHA-256 über PowerShell: `Get-ChildItem Cert:\LocalMachine\My | Format-List Subject, @{n='SHA256';e={$_.GetCertHashString('SHA256')}}`)
   - Samba: `openssl x509 -in /var/lib/samba/private/tls/cert.pem -noout -fingerprint -sha256`
3. **Dienstkonto** eintragen, z. B. `svc-helfi@firma.local` (normales Domänenkonto, keine besonderen Rechte nötig). Ohne Dienstkonto sucht Helfi.Space mit dem Konto, das sich gerade anmeldet.
4. **Gruppen** für Administratoren und Bearbeiter eintragen, z. B. `Helfi-Admins` und `Helfi-Bearbeiter` (Name oder vollständiger DN). Verschachtelte Gruppen werden berücksichtigt. Optional lässt sich über eine Gruppe „Zugelassene Benutzer“ einschränken, wer Tickets anlegen darf.
5. **Verbindung testen**, am besten mit einer Testanmeldung. Ist der Base-DN leer, wird er dabei aus dem AD übernommen. Gibt es eine Microsoft-Zertifizierungsstelle (AD CS), findet der Test sie und bietet an, sie mit zu übernehmen. Dann bleiben auch erneuerte DC-Zertifikate automatisch gültig.
6. **AD-Anmeldung aktivieren** und speichern.

Angemeldet wird mit `m.muster`, `FIRMA\m.muster` oder `m.muster@firma.local`. Benutzer werden bei der ersten Anmeldung angelegt. Ihre Rolle ergibt sich bei jeder Anmeldung aus den Gruppen, außer ein Admin hat sie unter *Benutzer* mit „Rolle fest“ gesperrt.

**Gut zu wissen**

- Ein Windows-DC bietet LDAPS nur an, wenn er ein Zertifikat hat (AD CS oder manuell installiert). Samba AD erzeugt beim Einrichten selbst eines.
- Täglich prüft Helfi.Space, ob das hinterlegte Zertifikat noch passt und ob es bald abläuft. Probleme erscheinen als Hinweis für Admins. Nach einer Erneuerung am DC genügt erneut **Zertifikat abrufen**.
- Lokale Konten haben Vorrang: Gibt es ein lokales Konto mit demselben Namen wie ein AD-Konto, gilt das lokale.
- Ist das AD nicht erreichbar, können sich lokale Konten (der Notfall-Admin) weiterhin anmelden.

## Single Sign-on (OpenID Connect)

*Administration → Single Sign-on*

1. Beim Anbieter eine App bzw. einen Client anlegen und als Umleitungs-URI die angezeigte Adresse eintragen: `https://helfi.firma.local/auth/oidc/callback`.
2. Issuer-URL, Client-ID und Client-Geheimnis eintragen und **Testen**.
   - **Microsoft Entra ID:** `https://login.microsoftonline.com/<Mandanten-ID>/v2.0`. Unter *Tokenkonfiguration* den Gruppenanspruch hinzufügen. Im Token stehen dann Gruppen-IDs, und diese IDs trägst du bei Admin-/Bearbeiter-Gruppe ein.
   - **ADFS (Windows Server):** `https://adfs.firma.local/adfs`, Anwendungsgruppe „Serveranwendung, die auf eine Web-API zugreift“. Den Anspruch `groups` per Anspruchsregel ausgeben.
   - **Keycloak:** `https://keycloak.firma.local/realms/<Realm>`, Mapper „Group Membership“ mit Claim `groups`.
3. Optional „direkt zu SSO weiterleiten“ einschalten. Die normale Anmeldeseite bleibt dann über `/login?local=1` erreichbar, etwa für den Notfall-Admin.

**SSO und AD zusammen:** Trägst du bei „Mit AD-Konten zusammenführen für Domäne“ deine Domäne ein (z. B. `firma.local`), ist `m.muster@firma.local` aus dem SSO dasselbe Konto wie der AD-Benutzer `m.muster`. Trag die Domäne nur ein, wenn der Anbieter sie wirklich kontrolliert, also keine Gastkonten aus anderen Organisationen zulässt. Ohne Eintrag bleiben SSO-Konten getrennt, und ein Gast `m.muster@fremd.example` kann nie das Konto `m.muster` übernehmen. E-Mail-Adressen aus dem SSO werden nur übernommen, wenn der Anbieter sie als bestätigt meldet oder wenn sie zur freigegebenen Domäne gehören.

## E-Mail

*Administration → E-Mail*

- **Postfach abrufen (IMAP):** Server, Benutzer und Kennwort des Helpdesk-Postfachs eintragen. Neue Mails werden zu Tickets (inklusive Anhängen). Antworten mit `[IT-123]` im Betreff oder per Antworten-Funktion werden zu Kommentaren, zitierter Verlauf wird abgeschnitten. Antwortet der Melder auf ein wartendes oder erledigtes Ticket, wird es wieder geöffnet. Abwesenheitsnotizen und automatische Mails werden ignoriert. Verarbeitete Mails werden gelesen markiert oder in einen Ordner verschoben.
- **Versand (SMTP):** Als Absender am besten dieselbe Adresse wie das Postfach verwenden, dann landen Antworten wieder im Ticket.
- **Interne Notizen** gehen nie per E-Mail raus.
- Per Ticketnummer im Betreff dürfen nur Beteiligte (Melder, Bearbeiter, bisherige Schreiber) antworten. Wer die Nummer nur errät, bekommt ein eigenes neues Ticket. Antworten auf Mails von Helfi.Space werden über die Message-ID immer richtig zugeordnet.
- Absenderadressen lassen sich fälschen. Deshalb leitet Helfi.Space Kommentare, die per E-Mail kamen, nicht an den Melder weiter. Bearbeiter antworten über die Weboberfläche.
- Schleifenschutz: Mehr als 20 neue Tickets pro Stunde vom selben Absender werden ignoriert.
- Absender ohne Konto werden als *E-Mail-Kontakt* geführt. Melden sie sich später per AD oder SSO mit derselben Adresse an, werden ihre Tickets übernommen.

---

## Updates

### Mit Container-Verwaltung (empfohlen)

**Dockhand**, **Watchtower** oder **Tugtainer** erkennen neue Images von `ghcr.io/soleil0815/helfi.space.ticket:latest` und aktualisieren den Container. Empfehlung: Update-Zeit **nachts** einstellen. Helfi.Space sichert die Datenbank beim Start einer neuen Version selbst (`data/backups/helfi-vor-<Version>-….sqlite`) und stellt sie danach um.

### Von Hand

```sh
./update.sh            # neueste Version
./update.sh 1.2.0      # bestimmte Version (wird in .env festgehalten)
./update.sh -y         # ohne Rückfragen
```

`update.sh` merkt sich die laufende Version und holt die neue. Ist die mitgelieferte `docker-compose.yml` neuer, ersetzt es die alte und behält sie als `docker-compose.yml.alt`. Danach startet es den Container und wartet auf den Gesundheitscheck. Startet die neue Version nicht, fragt es nach und startet die vorherige Version mit der passenden Datenbanksicherung wieder (mit `-y` automatisch). Es entpackt nichts und baut nichts. Es läuft mit `/bin/sh`, auch auf einer Synology.

### Version festhalten und zurückgehen

1. In der `.env` `HELFI_VERSION=1.1.0` eintragen (statt `latest`).
2. Hat die neuere Version die Datenbank schon umgestellt, startet die ältere nicht. Sie meldet dann im Protokoll, welche Sicherung passt. In dem Fall:
   ```sh
   docker compose down
   cp data/helfi.sqlite data/helfi.sqlite.neu
   cp data/backups/helfi-vor-1.2.0-<Datum>.sqlite data/helfi.sqlite
   rm -f data/helfi.sqlite-wal data/helfi.sqlite-shm
   docker compose up -d
   ```

### Ohne Internet

Jedes Release enthält die Image-Datei (`helfi-<Version>-amd64.tar.gz` bzw. `-arm64`). Auf den Server kopieren und:

```sh
./update.sh --offline helfi-1.2.0-amd64.tar.gz 1.2.0
```

### Hinweis „docker-compose.yml ist veraltet“

Die Datei hat eine Versionsnummer (`HELFI_COMPOSE_VERSION`). Braucht eine neue Programmversion eine neuere Datei, zeigt Helfi.Space Admins einen Hinweis. `./update.sh` übernimmt die neue Datei automatisch, alternativ lädst du sie aus dem Release.

---

## Sicherung

- Automatisch: täglich (14 Tage aufbewahrt, `HELFI_BACKUP_KEEP_DAYS`) und vor jedem Versionswechsel, in `data/backups/`
- Von Hand: *Administration → System → Jetzt sichern*
- **Mitsichern:** den ganzen Ordner `data/`, einschließlich `secret.key`. Ohne diese Datei lassen sich gespeicherte Kennwörter (Dienstkonto, Postfach, SSO) nicht mehr entschlüsseln und müssen neu eingegeben werden. Alternativ `HELFI_SECRET` in der `.env` setzen.

## Sicherheit

- Kennwörter lokaler Konten werden mit scrypt gespeichert. Hinterlegte Zugangsdaten (Dienstkonto, Postfach, SSO) sind mit AES-256-GCM verschlüsselt und werden nie an den Browser geschickt.
- Die Ersteinrichtung ist nur mit dem Einrichtungscode aus dem Container-Protokoll möglich.
- Nach mehreren falschen Kennwörtern wird die Anmeldung gebremst. Die Sitzungscookies sind `HttpOnly` und `SameSite`, außerdem gibt es CSRF-Schutz und eine strenge Content-Security-Policy.
- Leere Kennwörter werden nie ans AD weitergegeben, denn ein anonymer Bind würde sonst als Anmeldung durchgehen. Eingaben in LDAP-Filtern werden maskiert.
- Der Container läuft ohne root-Rechte (`PUID`/`PGID`).
- Anhänge werden zum Herunterladen ausgeliefert (nur Bilder werden direkt angezeigt), damit hochgeladene Dateien nie im Kontext von Helfi.Space ausgeführt werden.
- Bei Verbindungstests wird ein gespeichertes Kennwort nur an den gespeicherten Server geschickt. Wer einen anderen Server einträgt, muss das Kennwort neu eingeben.

## Entwicklung

```sh
npm install
npm run dev                  # http://localhost:8080, Daten in ./data
npm test                     # Einzel-, API- und update.sh-Tests
sudo scripts/test-samba-ad.sh && HELFI_TEST_LDAP_HOST=dc01.firma.local npm run test:integration
```

Aufbau: `src/` Server (Express, better-sqlite3), `public/` Oberfläche (reines JavaScript ohne Build-Schritt), `src/i18n.js` und `public/js/i18n.js` für die Texte (de/en).

Releases: Version in `package.json` erhöhen, Tag `v1.2.3` setzen. Die CI testet, baut die Images für amd64 und arm64, prüft auf Schwachstellen und veröffentlicht erst danach.

## Lizenz

MIT – siehe [LICENSE](LICENSE).

---

## English summary

Helfi.Space is a lightweight, Jira-style help desk running as a single Docker container with SQLite. The UI is available in German and English (switch via the user menu).

- **Install:** download `docker-compose.yml` and `.env.example` from the latest release, copy `.env.example` to `.env` and set `HELFI_BASE_URL`. Then run `docker compose up -d`, get the setup code from `docker compose logs helfi`, open the URL and create the local admin.
- **Active Directory** (Windows or Samba): *Administration → Active Directory*. Enter the DC host name, click **Fetch certificate**, compare the SHA-256 fingerprint and accept it. Then add a service account and the admin/agent groups (nested groups supported) and run **Test connection**.
- **SSO:** OpenID Connect (Entra ID, ADFS, Keycloak, …). Register the redirect URI shown on the settings page.
- **Email:** an IMAP mailbox is polled. New mails become tickets, and replies containing `[KEY-123]` become comments. SMTP sends confirmations and agent replies.
- **Updates:** use Dockhand/Watchtower on the `latest` tag (preferably at night), or run `./update.sh [version] [-y]`, which rolls back automatically if the new version fails its health check. The database is backed up automatically before every version change.
