<p align="center"><img src="public/logo.svg" width="72" alt=""></p>

# Helfi.Space

**Deutsch** · [English](README.en.md)

Ein schlankes Ticketsystem für IT-Abteilungen und Institute, auf Deutsch und Englisch. Helfi.Space läuft als ein einzelner Docker-Container mit SQLite.

![Board mit Tickets in vier Spalten](docs/images/board-de.png)

- **Active Directory** (Windows Server oder Samba AD): Anmeldung mit Windows-Konten, Rollen über AD-Gruppen (auch verschachtelt), **LDAPS-Zertifikat per Knopfdruck abrufen**
- **Single Sign-on** über OpenID Connect: Microsoft Entra ID, ADFS, Keycloak, Authentik …
- **E-Mail → Ticket:** Ein Postfach wird per IMAP abgerufen, neue Mails werden zu Tickets und Antworten landen im passenden Ticket. Melder bekommen Antworten per E-Mail.
- **Übersichtlich:** Board mit Drag & Drop, Ticketliste mit Filtern, Ticketansicht mit Details, Kommentaren, internen Notizen, Anhängen und Verlauf
- **Import aus einem anderen Ticketsystem** (über dessen REST-API, Cloud und Server/Data Center): Projekte, Tickets, Kommentare und Anhänge. Die Ticketnummern bleiben erhalten.
- **Rollen:** Administrator, Bearbeiter, Benutzer. Benutzer sehen nur ihre eigenen Anfragen.
- **Zwei-Faktor-Anmeldung (TOTP):** Im internen Netz reicht das Kennwort, von außen ist der Code aus einer Authenticator-App Pflicht.
- **Lokaler Notfall-Admin:** Er wird bei der Ersteinrichtung angelegt und funktioniert auch, wenn das AD nicht erreichbar ist.
- Automatische Sicherungen täglich und vor jedem Update

![Ticketansicht mit Kommentaren, interner Notiz und Details](docs/images/ticket-de.png)

---

## Installation

Voraussetzung: Docker mit Compose (Linux-Server, Synology, …).

```sh
mkdir helfi && cd helfi
# docker-compose.yml, env.example und update.sh aus dem neuesten Release herunterladen
cp env.example .env
nano .env            # mindestens HELFI_BASE_URL anpassen
docker compose up -d
docker compose logs helfi   # zeigt den Einrichtungscode
```

Dann `HELFI_BASE_URL` im Browser öffnen. Der Einrichtungsassistent fragt nach dem **Einrichtungscode** aus dem Protokoll und legt den **lokalen Administrator** und das erste Projekt an. Danach geht es direkt zur AD-Einrichtung.

> **Repository noch privat?** Dann braucht der Server einmalig eine Anmeldung bei ghcr.io:
> `docker login ghcr.io -u <GitHub-Name>` mit einem Personal Access Token (Recht `read:packages`).

Auf dem Host liegen nur vier Dinge:

| | |
|---|---|
| `docker-compose.yml` | bleibt bei Updates in der Regel gleich |
| `update.sh` | Update von Hand (optional, bei Container-Verwaltung nicht nötig) |
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
4. **Gruppen** für Administratoren und Bearbeiter eintragen, z. B. `Helfi-Admins` und `Helfi-Bearbeiter` (Name oder vollständiger DN). Verschachtelte Gruppen werden berücksichtigt. Optional lässt sich über eine Gruppe „Zugelassene Benutzer“ einschränken, wer sich überhaupt anmelden darf (Admins und Bearbeiter dürfen immer). Ist ein Gruppenname mehrdeutig (gleicher Name in mehreren OUs), wird keine Rolle vergeben und das Protokoll meldet es – dann den vollständigen DN eintragen.
5. **Verbindung testen**, am besten mit einer Testanmeldung. Ist der Base-DN leer, wird er dabei aus dem AD übernommen. Gibt es eine Microsoft-Zertifizierungsstelle (AD CS), findet der Test sie und bietet an, sie mit zu übernehmen. Dann bleiben auch erneuerte DC-Zertifikate automatisch gültig.
6. **AD-Anmeldung aktivieren** und speichern.

Angemeldet wird mit `m.muster`, `FIRMA\m.muster` oder `m.muster@firma.local`. Benutzer werden bei der ersten Anmeldung angelegt. Ihre Rolle ergibt sich bei jeder Anmeldung aus den Gruppen, außer ein Admin hat sie unter *Benutzer* mit „Rolle fest“ gesperrt. Ändert ein Admin die Rolle von Hand, wird sie automatisch gesperrt.

**Gut zu wissen**

- Ein Windows-DC bietet LDAPS nur an, wenn er ein Zertifikat hat (AD CS oder manuell installiert). Samba AD erzeugt beim Einrichten selbst eines.
- Täglich prüft Helfi.Space, ob das hinterlegte Zertifikat noch passt und ob es bald abläuft. Probleme erscheinen als Hinweis für Admins. Nach einer Erneuerung am DC genügt erneut **Zertifikat abrufen**.
- Lokale Konten haben Vorrang: Gibt es ein lokales Konto mit demselben Namen wie ein AD-Konto, gilt das lokale.
- Ist das AD nicht erreichbar, können sich lokale Konten (der Notfall-Admin) weiterhin anmelden.

## Zwei-Faktor-Anmeldung (2FA)

*Administration → Sicherheit*

Standard: **Im internen Netz reicht das Kennwort, von außen ist ein zweiter Faktor Pflicht.** Das ist ein 6-stelliger Code aus einer Authenticator-App wie Microsoft Authenticator, Google Authenticator, Aegis oder 2FAS. Alternativ lässt sich 2FA „immer“ oder „nie (freiwillig)“ verlangen.

- **Zugriffe vom Server selbst** (127.0.0.1) gelten nicht automatisch als intern. Ein Reverse-Proxy auf demselben Rechner muss X-Forwarded-For setzen, sonst sähe jeder Zugriff wie vom Server selbst aus. Zum Testen lässt sich `127.0.0.1` in die Liste eintragen.
- **Interne Netze** stehen als Liste in den Einstellungen (Standard: `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7`). Die Seite zeigt an, wie deine aktuelle Adresse erkannt wird.
- **Hinter einem Reverse-Proxy** muss dessen Adresse in `HELFI_TRUST_PROXY` stehen. Sonst sieht Helfi.Space nur den Proxy und behandelt jeden Zugriff sicherheitshalber als extern. Admins bekommen dann einen Hinweis.
- **Einrichten:** Jeder richtet 2FA unter *Profil → Zwei-Faktor-Anmeldung* ein: QR-Code scannen, Code eingeben, 10 Wiederherstellungscodes sichern. Aus Sicherheitsgründen geht die Ersteinrichtung nur im internen Netz, und zwar in jedem Modus. Ist 2FA schon eingerichtet, lässt sie sich nur mit gültigem Code abschalten und dann neu einrichten (z. B. neues Handy). So kann niemand mit einem erbeuteten Kennwort von außen seinen eigenen zweiten Faktor hinterlegen. Wer nur von außen arbeitet, für den lässt sich unter *Sicherheit* die „Ersteinrichtung auch von außen“ erlauben.
- **Sitzungen:** Wer sich im Büro ohne Code angemeldet hat und denselben Browser später von zu Hause nutzt, muss sich dort neu mit Code anmelden.
- **Handy verloren:** Mit einem Wiederherstellungscode anmelden. Alternativ setzt ein Admin unter *Benutzer → 2FA zurücksetzen* die 2FA zurück, und die Person richtet sie im Büro neu ein.
- **Gilt für** lokale Konten und Active-Directory-Anmeldungen. Bei **SSO** prüft standardmäßig der Identitätsanbieter den zweiten Faktor (z. B. MFA in Entra ID). Das lässt sich abschalten, dann fragt Helfi.Space zusätzlich seinen eigenen Code ab.
- Docker-Hinweis: Bei manchen Docker-Setups kommen alle Zugriffe scheinbar vom Docker-Gateway, z. B. bei rootless Docker oder IPv6. Diese Adresse gilt deshalb nur als intern, wenn sie einzeln eingetragen ist.

![Einstellungen zur Zwei-Faktor-Anmeldung](docs/images/2fa-de.png)

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

- **Postfach abrufen (IMAP):** Server, Benutzer und Kennwort des Helpdesk-Postfachs eintragen. Neue Mails werden zu Tickets (inklusive Anhängen bis 20 MB je Anhang und bis zu 30 Anhängen; was nicht übernommen wird, steht als Hinweis im Ticket; Mails über 80 MB werden übersprungen und im Postfach markiert). Antworten auf Mails von Helfi.Space und Antworten Beteiligter mit `[IT-123]` im Betreff werden zu Kommentaren, zitierter Verlauf wird abgeschnitten. Antwortet der Melder auf ein wartendes oder erledigtes Ticket, wird es wieder geöffnet. Abwesenheitsnotizen und automatische Mails werden ignoriert. Verarbeitete Mails werden gelesen markiert oder in einen Ordner verschoben.
- **Versand (SMTP):** Als Absender am besten dieselbe Adresse wie das Postfach verwenden, dann landen Antworten wieder im Ticket.
- **Interne Notizen** gehen nie per E-Mail raus.
- Per Ticketnummer im Betreff dürfen nur Beteiligte (Melder, Bearbeiter, bisherige Schreiber) antworten. Wer die Nummer nur errät, bekommt ein eigenes neues Ticket. Antworten auf Mails von Helfi.Space werden über die Message-ID immer richtig zugeordnet.
- Absenderadressen lassen sich fälschen. Deshalb gilt eine Mail nie als Bearbeiter-Antwort, auch wenn sie von der Adresse eines Bearbeiters kommt: Sie erscheint mit der Absenderadresse, nicht unter dem Konto, und wird nicht an den Melder weitergeleitet. Bearbeiter antworten über die Weboberfläche.
- Postfach am besten nicht parallel in Outlook oder auf dem Handy lesen: Helfi.Space holt nur ungelesene Mails. Empfohlen ist ein Ordner für verarbeitete Mails.
- Eingangsbestätigungen gehen höchstens 60-mal pro Stunde raus (Schutz vor Missbrauch mit gefälschten Absendern).
- Schleifenschutz: Mehr als 20 neue Tickets pro Stunde vom selben Absender werden ignoriert.
- Absender ohne Konto werden als *E-Mail-Kontakt* geführt. Melden sie sich später per AD oder SSO mit derselben Adresse an, werden ihre Tickets übernommen.
- **Absender im AD nachschlagen** (Standard: an, braucht AD-Anmeldung mit Dienstkonto): Unbekannte Absender sucht Helfi.Space im AD. Gesucht wird in `mail`, `userPrincipalName` und den Zweitadressen in `proxyAddresses`, deaktivierte Konten nicht. Bei genau einem Treffer wird die Person gleich als AD-Benutzer angelegt, mit der Rolle aus ihren Gruppen, als hätte sie sich angemeldet. Ein vorhandener E-Mail-Kontakt wird dabei übernommen. Nicht gefunden, mehrdeutig oder AD nicht erreichbar: Sie wird wie bisher E-Mail-Kontakt. Unbekannte Adressen werden eine Stunde lang nicht erneut gesucht. Eine Mail gibt auch dann nie Bearbeiter-Rechte.
- **Aufbewahrung:** „Verarbeitete Mails löschen nach … Tagen“ (Standard 0 = nie, sonst mindestens 7). Einmal täglich werden im Ordner für verarbeitete Mails die älteren Mails endgültig gelöscht, höchstens 500 pro Lauf. Im Posteingang wird nie gelöscht. Ist kein eigener Ordner eingetragen, löscht Helfi.Space gar nichts. Die Inhalte bleiben in den Tickets.

## Import aus einem anderen Ticketsystem

*Administration → Import*

Helfi.Space übernimmt Projekte und Tickets über die REST-API des bisherigen Systems: **Cloud** (REST-API v3) und **Server/Data Center** (REST-API v2), auch Service-Desk-Projekte. Die Zugangsdaten werden nicht gespeichert, sie gelten nur für den laufenden Import.

1. **Verbinden:**
   - Cloud: Adresse, E-Mail und API-Token.
   - Server/Data Center: Adresse und Personal Access Token, alternativ Benutzername und Kennwort.
   - Bei einem internen Zertifikat die eigene Zertifizierungsstelle (PEM) eintragen.
2. **Projekte wählen** und festlegen, in welches Helfi.Space-Projekt sie kommen. Gibt es das Projekt nicht, wird es angelegt.
3. **Zuordnen:** Status und Vorgangstypen des Quellsystems auf die vier Status und Typen von Helfi.Space verteilen. Vorschläge sind schon eingetragen, z. B. „Waiting for customer“ → Wartet und „Bug“ → Störung.
4. **Importieren:** Der Fortschritt wird angezeigt. Der Import lässt sich abbrechen.

Was übernommen wird:

- Zusammenfassung, Beschreibung (als Text), Typ, Status, Priorität, Stichwörter, Fälligkeit, Erstell- und Erledigt-Datum
- Kommentare. Interne Kommentare aus Service-Desk-Projekten und Kommentare mit eingeschränkter Sichtbarkeit werden zu internen Notizen.
- Anhänge bis zur gewählten Größe

So werden Nummern und Personen behandelt:

- **Nummern:** `SUP-123` bleibt `SUP-123`. Ist die Nummer im Zielprojekt schon vergeben, bekommt das Ticket die nächste freie. Neue Tickets schließen an die höchste Nummer an.
- **Personen** werden über die E-Mail-Adresse zugeordnet. Melder ohne Konto werden zu E-Mail-Kontakten, und meldet sich die Person später per AD oder SSO an, gehören ihr die Tickets. Bearbeiter werden nur zugewiesen, wenn sie in Helfi.Space schon Bearbeiter sind, sonst steht ihr Name im Verlauf. Cloud-Systeme geben E-Mail-Adressen je nach Datenschutzeinstellung nicht heraus, dann wird nur der Name übernommen.

Außerdem gilt:

- Es werden **keine E-Mails** verschickt.
- **Wiederholbar:** Ein zweiter Lauf aktualisiert Tickets, die sich im Quellsystem seitdem geändert haben (dann gilt der Stand von dort). Unveränderte bleiben, wie sie in Helfi.Space bearbeitet wurden. Neue Kommentare und Anhänge werden ergänzt, doppelt wird nichts angelegt. So lässt sich vor der Umstellung einmal probehalber und am Stichtag noch einmal importieren.

---

## Updates

### Mit Container-Verwaltung (empfohlen)

**Dockhand**, **Watchtower** oder **Tugtainer** erkennen neue Images von `ghcr.io/soleil0815/helfi.space.ticket:latest` und aktualisieren den Container. Empfehlung: Update-Zeit **nachts** einstellen. Helfi.Space sichert die Datenbank beim Start einer neuen Version selbst (`data/backups/helfi-vor-<Version>-….sqlite`) und stellt sie danach um.

### Von Hand

```sh
./update.sh            # neueste Version
./update.sh 1.2.0      # bestimmte Version (wird in .env festgehalten)
./update.sh -y         # ohne Rückfragen
./update.sh --cleanup  # Reste früherer Updates anzeigen und nach Rückfrage löschen
```

`update.sh` merkt sich die laufende Version und holt die neue. Ist die mitgelieferte `docker-compose.yml` neuer, ersetzt es die alte und behält sie als `docker-compose.yml.alt-<Datum>-<Uhrzeit>`. Danach startet es den Container und wartet auf den Gesundheitscheck. Startet die neue Version nicht, fragt es nach und startet die vorherige Version mit der passenden Datenbanksicherung wieder (mit `-y` automatisch). Es entpackt nichts und baut nichts. Es läuft mit `/bin/sh`, auch auf einer Synology.

### Aufräumen

Mit der Zeit sammeln sich im Ordner ältere Sicherheitskopien der `docker-compose.yml` und geladene Image-Dateien aus dem Release. `./update.sh --cleanup` zeigt diese Dateien an und löscht sie erst nach Rückfrage (mit `-y` ohne). Die neueste `docker-compose.yml.alt-…` bleibt.

Gelöscht wird nur, was auf dieser festen Liste steht:

- ältere `docker-compose.yml.alt-…`
- `helfi-<Version>-amd64/arm64.tar.gz`
- Zwischendateien abgebrochener Läufe, die älter als eine Stunde sind
- eine `docker-compose.yml.neu`, die schon übernommen wurde

Nie angefasst werden `data/`, Sicherungen, `.env`, `docker-compose.yml`, Ordner, Links und Dateien, die ein Container eingebunden hat.

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

### Eigene Anpassungen an der docker-compose.yml

`update.sh` ersetzt die `docker-compose.yml` nur, wenn sie unverändert ist. Hast du sie angepasst (z. B. einen anderen Datenpfad), bleibt sie, wie sie ist. Die neue Fassung liegt dann als `docker-compose.yml.neu` daneben. Nach einem fehlgeschlagenen Update stellt `update.sh` die vorherige Version, deren Datenbanksicherung und die alte `docker-compose.yml` wieder her. Die alte Version hält es außerdem in der `.env` fest, damit Watchtower oder Dockhand die defekte nicht gleich wieder holen.

Weitere Variablen für `update.sh`: `HELFI_UPDATE_WAIT` (Wartezeit auf den Start, Standard 120 Sekunden) und `HELFI_IMAGE_REPO` (eigene Registry).

### Hinweis „docker-compose.yml ist veraltet“

Die Datei hat eine Versionsnummer (`HELFI_COMPOSE_VERSION`). Braucht eine neue Programmversion eine neuere Datei, zeigt Helfi.Space Admins einen Hinweis. `./update.sh` übernimmt die neue Datei automatisch, alternativ lädst du sie aus dem Release.

---

## Sicherung

- Automatisch: täglich (14 Tage aufbewahrt, `HELFI_BACKUP_KEEP_DAYS`) und vor jedem Versionswechsel, in `data/backups/`
- Von Hand: *Administration → System → Jetzt sichern*
- **Mitsichern:** den ganzen Ordner `data/`, einschließlich `secret.key`. Ohne diese Datei lassen sich gespeicherte Kennwörter (Dienstkonto, Postfach, SSO) und 2FA-Schlüssel nicht mehr entschlüsseln. Helfi.Space startet dann nicht und meldet das im Protokoll. Alternativ `HELFI_SECRET` (mindestens 16 Zeichen) in der `.env` setzen, aber gleich bei der Einrichtung: Ein späterer Wechsel zwischen `secret.key` und `HELFI_SECRET` macht gespeicherte Daten unlesbar.
- Die Sicherungen in `data/backups/` enthalten nur die Datenbank. Anhänge (`data/attachments/`) und `secret.key` liegen daneben. Deshalb immer den ganzen Ordner `data/` auf ein anderes Laufwerk sichern.
- Aufbewahrung: Tägliche Sicherungen 14 Tage (die neueste bleibt immer). Sicherungen vor Versionswechseln werden auf die letzten 10 begrenzt, manuelle nie gelöscht.

## Sicherheit

- Zwei-Faktor-Anmeldung nach RFC 6238. Jeder Code gilt nur einmal, nach 5 Fehlversuchen beginnt die Anmeldung von vorn. Der Schlüssel ist verschlüsselt gespeichert, die Wiederherstellungscodes nur als Hash.
- Kennwörter lokaler Konten werden mit scrypt gespeichert. Hinterlegte Zugangsdaten (Dienstkonto, Postfach, SSO) sind mit AES-256-GCM verschlüsselt und werden nie an den Browser geschickt.
- Die Ersteinrichtung ist nur mit dem Einrichtungscode aus dem Container-Protokoll möglich.
- Nach mehreren falschen Kennwörtern wird die Anmeldung gebremst. Die Sitzungscookies sind `HttpOnly` und `SameSite`, außerdem gibt es CSRF-Schutz und eine strenge Content-Security-Policy.
- Leere Kennwörter werden nie ans AD weitergegeben, denn ein anonymer Bind würde sonst als Anmeldung durchgehen. Eingaben in LDAP-Filtern werden maskiert.
- Der Container läuft ohne root-Rechte (`PUID`/`PGID`, 0 ist nicht erlaubt), mit schreibgeschütztem Programmteil, ohne zusätzliche Linux-Rechte und mit `no-new-privileges` (siehe `docker-compose.yml`). Dateien in `data/` sind nur für diesen Benutzer lesbar.
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

Releases: *Actions → CI → Run workflow*, Branch `main`, bei „Release“ `patch`, `minor` oder `major` wählen. Die Version zählt sich selbst hoch (höchster Tag + 1), `package.json` muss nicht angepasst werden. Die CI testet, baut die Images für amd64 und arm64 nativ, prüft auf Schwachstellen und legt erst danach Tag, Images und GitHub-Release an.

## Lizenz

MIT – siehe [LICENSE](LICENSE).

