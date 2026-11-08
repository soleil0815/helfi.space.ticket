<p align="center"><img src="public/logo.svg" width="72" alt=""></p>

# Helfi.Space

**Deutsch** · [English](README.en.md) · [helfi.space](https://helfi.space)

Ein schlankes Ticketsystem für IT-Abteilungen und Institute, auf Deutsch und Englisch. Helfi.Space läuft als ein einzelner Docker-Container mit SQLite.

![Board mit Tickets in vier Spalten](docs/images/board-de.png)

- **Active Directory** (Windows Server oder Samba AD): Anmeldung mit Windows-Konten, Rollen über AD-Gruppen (auch verschachtelt), **LDAPS-Zertifikat per Knopfdruck abrufen**
- **Single Sign-on** über OpenID Connect: Microsoft Entra ID, ADFS, Keycloak, Authentik …
- **E-Mail → Ticket:** Ein Postfach wird per IMAP abgerufen, neue Mails werden zu Tickets und Antworten landen im passenden Ticket. Melder bekommen Antworten per E-Mail.
- **Übersichtlich:** Seitenleiste mit Warteschlangen (offen, mir zugewiesen, nicht zugewiesen, wartet, kürzlich erledigt, alle) samt Live-Zahlen, Zusammenfassung je Projekt, Board mit Drag & Drop, Ticketliste mit Filtern und Seiten (50/100/250/500 pro Seite; bei einer Suche die besten 5000 Treffer), Ticketansicht mit Details, Kommentaren, internen Notizen, Anhängen und Verlauf
- **Umzug leicht gemacht:** Import aus **Zammad**, **Znuny/OTRS**, **GLPI**, **Zendesk**, **Freshdesk**, **Jira** (Cloud, Server/Data Center) oder einer **CSV-Datei** – mit Kommentaren, internen Notizen und Anhängen; Ticketnummern bleiben erhalten, ein zweiter Lauf ergänzt nur Neues.
- **Formatierte Antworten:** eine Werkzeugleiste über dem Kommentarfeld (Ticket, Wissensartikel, Handy) mit KI, fett/kursiv, Listen, Zitat, Code, Link, Bild, Emoji, @-Erwähnung und vorformulierten Antworten – formatiert beim Schreiben, formatiert in der Mail
- **Screenshots einfügen:** Bilder aus der Zwischenablage mit Strg+V direkt in Kommentar, Beschreibung oder „Ticket erstellen“. In internen Notizen bleiben sie intern.
- **IT-Service-Management nach ITIL** (alles optional): Verknüpfungen und Unteraufgaben, Auswirkung/Dringlichkeit und Major Incidents, Service Level, Probleme und bekannte Fehler, Change-Management mit Genehmigung und Kalender, Wissensdatenbank, Servicekatalog mit Formularen und Genehmigung, Geräte & Dienste, Zufriedenheitsumfrage und Kennzahlen
- **Suche mit Treffern beim Tippen** – mit Fundstelle, Tastatursteuerung und den zuletzt geöffneten Tickets, am PC und auf dem Handy
- **Gespeicherte Filter und eigene Warteschlangen:** Filter der Ticketliste unter einem Namen speichern – persönlich oder vom Admin für alle Bearbeiter freigegeben, in der Seitenleiste mit Anzahl, auf dem Handy als Chip
- **Komponenten mit Zuständigkeit:** Projekte in Bereiche wie „VPN & Fernzugriff“ oder „Drucker & Scanner“ aufteilen, je mit verantwortlicher Person und Vertretung. Neue Tickets werden über Schlagwörter oder den Absender zugeordnet und gehen automatisch an die richtige Person – mit fertigen Beispielen für IT, Haustechnik und Verwaltung
- **Zusammenarbeit im Team:** **@-Erwähnungen** in Antworten und internen Notizen (mit Mail und Ansicht „Erwähnt mich“), Anfrage-Teilnehmer, Antwortvorlagen, **Mehrfachauswahl** (Status, Zuweisung, Kommentar oder Verknüpfung für viele Tickets auf einmal), **Verknüpfen mit Suche und Vorschlägen** (mögliche Ursachen, ähnliche Tickets)
- **KI-Unterstützung (optional, jede Funktion einzeln schaltbar):** Zusammenfassung, Antwortvorschlag, Umformulieren, Hilfe beim Schreiben von Wissensartikeln, Erkennen der Komponente und von Duplikaten (mit Trefferquote) mit einem eigenen Modell (Ollama, LM Studio, vLLM …) oder einem beliebigen OpenAI-kompatiblen Dienst – nur Vorschläge, nichts wird automatisch verschickt
- **Handy-App:** eigene, app-artige Oberfläche unter `/m`, als App installierbar, mit Fotos, Vorlagen, Erwähnungen und 2FA-Einrichtung
- **Selbstregistrierung und „Kennwort vergessen“** für lokale Konten (Selbstregistrierung standardmäßig aus, „Kennwort vergessen“ standardmäßig für Benutzer-Konten), optional nur für bestimmte Domänen und mit Freigabe
- **Automatische Abmeldung bei Inaktivität,** für Admins und Zugriffe von außen strenger einstellbar, mit „Noch da?“-Hinweis
- **Wissensartikel mit 👍/👎-Bewertung** und Rückmeldungen, was gefehlt hat – Artikel, die eine Überarbeitung brauchen, auf einen Blick
- **Rollen:** Administrator, Bearbeiter, Benutzer. Benutzer sehen nur ihre eigenen Anfragen.
- **Zwei-Faktor-Anmeldung (TOTP):** Im internen Netz reicht das Kennwort, von außen ist der Code aus einer Authenticator-App Pflicht – einstellbar je Rolle.
- **Lokaler Notfall-Admin:** Er wird bei der Ersteinrichtung angelegt und funktioniert auch, wenn das AD nicht erreichbar ist.
- **Dunkelmodus:** Im Benutzermenü unter *Design* zwischen *System* (folgt dem Gerät), *Hell* und *Dunkel* wählen – am Handy unter *Ich → Design*. Die Wahl gilt für das Konto auf allen Geräten, auch mit eigener Firmenfarbe.
- **Neuigkeiten:** Nach einem Update zeigt Helfi.Space jedem einmal, was sich für ihn geändert hat; alle Versionen stehen im Benutzermenü unter *Neuigkeiten*.
- Automatische Sicherungen täglich und vor jedem Update

![Ticketansicht mit Kommentaren, interner Notiz und Details](docs/images/ticket-de.png)

**Handbuch (PDF):** [Deutsch](docs/Handbuch.pdf) · [English](docs/Manual.en.pdf) – für Benutzer, Bearbeiter und Administratoren.

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

Damit die Bremse gegen Kennwort-Raten die echte Client-Adresse sieht, trägst du in der `.env` die Adresse des Proxys ein, z. B. `HELFI_TRUST_PROXY=10.0.10.5`. Mehrere Angaben trennst du mit Komma, z. B. `loopback, 10.0.10.5`. Ohne diesen Eintrag glaubt Helfi.Space `X-Forwarded-For` nur vom eigenen Rechner (`loopback`), weil sich die Angabe sonst fälschen ließe. Werte wie `true` oder eine Zahl (Anzahl der Proxys) werden mit einer Warnung im Protokoll ignoriert; dann gilt ebenfalls `loopback`. Schickt ein einzeln eingetragener Proxy (Adresse, kein Bereich) eine Anfrage ohne `X-Forwarded-For`, ist das Gerät dahinter unbekannt – sie zählt dann als von außen (2FA nach der Regel für außen).

Beispiel Caddy:

```
helfi.firma.local {
    reverse_proxy 10.0.10.20:8080
}
```

---

## Erscheinungsbild (Corporate Design)

*Administration → Allgemein → Erscheinungsbild*:

- **Logo** als PNG oder SVG (höchstens 512 KB). Es ersetzt das Logo in der Kopfzeile, auf der Anmeldeseite und im Browser-Tab. SVGs mit Skripten oder Verweisen auf fremde Inhalte werden abgelehnt. Das Logo liegt im Datenordner unter `brand/` und wird mitgesichert.
- **Titel neben dem Logo** lässt sich ausblenden, wenn das Logo den Namen schon enthält.
- **Hauptfarbe** für Knöpfe, Links und Markierungen. Die Seite zeigt den Kontrast zu Weiß an und warnt unter 4,5:1, weil Schrift auf Knöpfen dann schlecht lesbar ist.
- **Kopfzeile** hell oder in der Hauptfarbe. Bei sehr hellen Farben wird die Schrift dort automatisch dunkel.
- Eine Vorschau zeigt die Wirkung vor dem Speichern; *Auf Standard zurücksetzen* stellt alles wieder her.

## Anmeldeseite anpassen

*Administration → Allgemein → Anmeldeseite*: eigene Überschrift (z. B. „Hilfecenter“), Begrüßungstext auf Deutsch und optional Englisch, z. B. wie man Hilfe bekommt, und eine eigene Bezeichnung für das Anmeldefeld („Windows-Anmeldename“). Nur Text: `**fett**`, Links und Mailadressen werden automatisch anklickbar, HTML wird nie ausgeführt. Eine Vorschau zeigt das Ergebnis sofort.

## KI-Unterstützung (optional)

*Administration → KI* (standardmäßig aus)

Bearbeiter lassen sich Tickets zusammenfassen und Antworten vorschlagen, glätten, kürzen oder übersetzen. Alles ist nur ein **Vorschlag**: Nichts wird automatisch gesendet oder gespeichert, Anfragende sehen davon nichts. Einzige Ausnahme, wenn ausdrücklich so eingestellt: *Komponente erkennen* im Modus *Automatisch zuordnen*.

- **Jede OpenAI-kompatible Schnittstelle:** Ollama, LM Studio, vLLM, aber auch Cloud-Anbieter. Eingetragen werden Adresse (Ollama: `http://<host>:11434/v1`) und optional ein API-Schlüssel (verschlüsselt gespeichert, nur an diese Adresse geschickt). **Die installierten Modelle werden automatisch abgerufen** und stehen in einer Auswahlliste – bei Ollama mit Parameterzahl, Quantisierung und Größe, Cloud-Modelle in einer eigenen Gruppe; Embedding-Modelle (können nicht antworten) sind ausgeblendet. Liefert ein Server keine Liste, lässt sich der Name über *Anderes Modell eingeben …* frei eintragen. *Testen* prüft die Verbindung.
- **Empfehlung für den Echtbetrieb: selbst hosten.** Mit einem Modell im eigenen Netz verlassen Ticketinhalte das Haus nicht. Für brauchbares Deutsch eignen sich Modelle ab etwa 8–14 Mrd. Parametern (z. B. Qwen3, Mistral, gpt-oss:20b); mit Grafikkarte kommen Antworten in Sekunden. Cloud-Modelle (auch Ollamas `…-cloud`-Modelle) schicken Namen, Beschreibungen und Antworten zum Anbieter – die Einstellungsseite weist darauf hin; ob das zulässig ist, ist eine Datenschutzfrage.
- **Was die KI bekommt:** Titel, Beschreibung und öffentliche Kommentare (neueste zuerst, gekürzt auf eine einstellbare Länge). Interne Notizen nur, wenn eingeschaltet; Anhänge nie. Das Protokoll enthält nur Ticketnummer, Aufgabe, Modell und Dauer – keine Inhalte.
- **Reasoning-Modelle** (z. B. gpt-oss): Das „Nachdenken“ ist auf *niedrig* gestellt (schneller) und wird aus der Antwort entfernt.
- Nur der Server spricht das Modell an; der Browser lädt weiterhin nichts von außen. Pro Bearbeiter sind die Aufrufe begrenzt.
- **Wissensartikel** (Funktion standardmäßig an): Im Artikel-Editor ist *KI* der erste Knopf. Er wirkt auf die Markierung oder den ganzen Artikel und lässt die Formatierung stehen – glätten, kürzen, Schritt-für-Schritt-Anleitung aus Stichpunkten, übersetzen, Titel und Kategorie vorschlagen. Bei einem Artikel aus einem Ticket schreibt die KI auf Wunsch einen Entwurf (Problem – Ursache – Lösung) ohne persönliche Angaben. *Rückgängig* holt den vorherigen Text zurück.
- **Funktionen einzeln schalten:** *Zusammenfassung*, *Antwortvorschlag* und *Umformulieren* und *Wissensartikel* (standardmäßig an) sowie *Komponente erkennen* und *Duplikate erkennen* (standardmäßig aus). Ausgeschaltete Funktionen erscheinen nirgends.
- **Komponente erkennen:** Für neue Tickets, bei denen keine [Komponenten](#komponenten)-Regel passt, wählt die KI im Hintergrund aus der Liste der Komponenten (mit Beschreibung und Schlagwörtern) – oder meldet „passt nicht“. Zwei Arten:
  - *Vorschlagen* (Standard): Im Ticket steht „KI schlägt vor: VPN & Fernzugriff – Übernehmen / Verwerfen“ (Handy: unter *Alle Details*). Übernehmen setzt die Komponente und gibt das Ticket wie die Regeln an die verantwortliche Person.
  - *Automatisch zuordnen*: Die Komponente wird direkt gesetzt; im Verlauf steht „von KI“ mit dem Modell.
  - Die **Trefferquote** steht auf der KI-Seite, z. B. „87 % (52 von 60 übernommen)“: übernommene und automatisch gesetzte, die niemand geändert hat, gegen korrigierte und verworfene.
  - Mit einem Cloud-Modell gehen dafür Titel und Beschreibung jedes neuen Tickets ohne Regel-Treffer an den Anbieter – die Seite weist darauf hin.
- **Duplikate erkennen** (standardmäßig aus): Für ein neues Ticket sucht Helfi.Space zuerst ohne KI per Volltext ähnliche **offene** Tickets desselben Projekts aus den letzten 30 Tagen (höchstens 8). Nur wenn es welche gibt, prüft die KI, ob das neue Ticket dasselbe Problem meldet. Bearbeiter sehen dann im Ticket „Mögliches Duplikat von IT-12 – Begründung“ mit **Als Duplikat schließen** (öffnet den Dialog mit eingetragenem Original) und **Kein Duplikat** – auch auf dem Handy. Geschlossen wird nie automatisch; Melder sehen den Hinweis nicht. Die Trefferquote steht auf der KI-Seite. Mit einem Cloud-Modell gehen dafür Titel und Beschreibung des neuen Tickets und der bis zu 8 möglichen Originale (je die ersten 1500 Zeichen) an den Anbieter.

## Selbstregistrierung und Kennwort vergessen

*Administration → Sicherheit → Registrierung und Kennwort vergessen* (Registrierung standardmäßig aus)

Ohne AD oder SSO schreiben Externe einfach eine Mail und werden als E-Mail-Kontakt geführt; anmelden können sie sich damit nicht. Mit **Selbstregistrierung** legen sie sich über „Konto erstellen“ auf der Anmeldeseite selbst ein lokales Konto an (Rolle „Benutzer“) und sehen ihre Anfragen dann auch im Browser.

- **Bestätigung per Link:** Name, E-Mail-Adresse und Kennwort eingeben, dann kommt ein Link (24 Stunden gültig). Erst danach entsteht das Konto. Gibt es zur Adresse schon einen E-Mail-Kontakt, wird er zum Konto, mit allen bisherigen Anfragen. Unbestätigte Registrierungen verfallen von selbst.
- **Anmeldung** mit der E-Mail-Adresse als Benutzername. Die Adresse lässt sich danach nur von einem Admin ändern.
- **Erlaubte Mail-Domains** (optional, Subdomains eingeschlossen) und **Freigabe durch einen Admin** (optional: Admins bekommen eine Mail und geben das Konto unter *Benutzer* frei; die Person wird benachrichtigt).
- **Kennwort vergessen:** Link per Mail, 60 Minuten gültig und nur einmal nutzbar; danach sind alle Sitzungen beendet. Standardmäßig für lokale Konten mit der Rolle „Benutzer“, wahlweise für alle lokalen Konten oder aus. Der Link erscheint nur, wenn es solche Konten gibt. Konten aus AD oder SSO ändern ihr Kennwort dort; die Zwei-Faktor-Anmeldung bleibt bestehen.
- **Voraussetzung** ist der E-Mail-Versand. Die Seite sagt nie, ob eine Adresse schon bekannt ist (die Person erfährt es per Mail). Anfragen pro IP und Adresse sind begrenzt, ein unsichtbares Feld hält einfache Bots ab; ein Captcha gibt es nicht, weil dafür etwas aus dem Internet geladen werden müsste.
- **Zwei-Faktor:** Ist 2FA von außen für alle Pflicht, die Ersteinrichtung aber nur im Firmennetz erlaubt, könnten sich Externe nie anmelden. Die Einstellungsseite weist darauf hin.

## Active Directory einrichten

*Administration → Active Directory*

1. **Domänencontroller** eintragen, und zwar mit dem Namen, der im Zertifikat steht (z. B. `dc01.firma.local`). Verschlüsselung: **LDAPS (636)** oder **StartTLS (389)**.
2. **Zertifikat abrufen** holt das Zertifikat direkt vom DC und zeigt den SHA-256-Fingerabdruck. Vergleiche ihn mit dem am Server und klicke dann **Zertifikat übernehmen**.
   - Windows: `certlm.msc` → Eigene Zertifikate → Zertifikat des DCs → Details → Fingerabdruck (SHA-256 über PowerShell: `Get-ChildItem Cert:\LocalMachine\My | Format-List Subject, @{n='SHA256';e={$_.GetCertHashString('SHA256')}}`)
   - Samba: `openssl x509 -in /var/lib/samba/private/tls/cert.pem -noout -fingerprint -sha256`
3. **Dienstkonto** eintragen, z. B. `svc-helfi@firma.local` (normales Domänenkonto, keine besonderen Rechte nötig). Ohne Dienstkonto sucht Helfi.Space mit dem Konto, das sich gerade anmeldet, und prüft das Kennwort danach noch einmal am gefundenen Konto (so führt der UPN eines anderen Kontos nie zur falschen Anmeldung).
4. **Gruppen** für Administratoren und Bearbeiter eintragen, z. B. `Helfi-Admins` und `Helfi-Bearbeiter` (Name oder vollständiger DN). Verschachtelte Gruppen werden berücksichtigt. Optional lässt sich über eine Gruppe „Zugelassene Benutzer“ einschränken, wer sich überhaupt anmelden darf (Admins und Bearbeiter dürfen immer). Ist ein Gruppenname mehrdeutig (gleicher Name in mehreren OUs), wird keine Rolle vergeben und das Protokoll meldet es – dann den vollständigen DN eintragen.
5. **Verbindung testen**, am besten mit einer Testanmeldung. Ist der Base-DN leer, wird er dabei aus dem AD übernommen. Gibt es eine Microsoft-Zertifizierungsstelle (AD CS), findet der Test sie und bietet an, sie mit zu übernehmen. Dann bleiben auch erneuerte DC-Zertifikate automatisch gültig.
6. **AD-Anmeldung aktivieren** und speichern.

Angemeldet wird mit `m.muster`, `FIRMA\m.muster` oder `m.muster@firma.local`. Benutzer werden bei der ersten Anmeldung angelegt. Ihre Rolle ergibt sich bei jeder Anmeldung aus den Gruppen, außer ein Admin hat sie unter *Benutzer* mit „Rolle fest“ gesperrt. Ändert ein Admin die Rolle von Hand, wird sie automatisch gesperrt.

**Gut zu wissen**

- Ein Windows-DC bietet LDAPS nur an, wenn er ein Zertifikat hat (AD CS oder manuell installiert). Samba AD erzeugt beim Einrichten selbst eines.
- Täglich prüft Helfi.Space, ob das hinterlegte Zertifikat noch passt und ob es bald abläuft. Probleme erscheinen als Hinweis für Admins. Nach einer Erneuerung am DC genügt erneut **Zertifikat abrufen**.
- **Teilnehmer aus dem AD vorschlagen** (Standard: an, braucht das Dienstkonto): siehe [Anfrage-Teilnehmer](#anfrage-teilnehmer).
- Lokale Konten haben Vorrang: Gibt es ein lokales Konto mit demselben Namen wie ein AD-Konto, gilt das lokale.
- Ist das AD nicht erreichbar, können sich lokale Konten (der Notfall-Admin) weiterhin anmelden.

## Zwei-Faktor-Anmeldung (2FA)

*Administration → Sicherheit*

Standard: **Im internen Netz reicht das Kennwort, von außen ist ein zweiter Faktor Pflicht.** Das ist ein 6-stelliger Code aus einer Authenticator-App wie Microsoft Authenticator, Google Authenticator, Aegis oder 2FAS. Die Pflicht lässt sich getrennt nach Rolle einstellen:

| Einstellung | Auswahl |
|---|---|
| Pflicht bei Anmeldung von außen | alle Benutzer (Standard) · Bearbeiter und Administratoren · nur Administratoren · niemand |
| Im internen Netz | keine Zwei-Faktor-Abfrage (Standard) · nur Administratoren · Bearbeiter und Administratoren · alle Benutzer |

Beispiel: Melder ohne Code, Bearbeiter von außen mit Code, Administratoren immer mit Code. Wer vorher „immer“ oder „nie“ eingestellt hatte, behält das Verhalten.

- **Zugriffe vom Server selbst** (127.0.0.1) gelten nicht automatisch als intern. Ein Reverse-Proxy auf demselben Rechner muss X-Forwarded-For setzen, sonst sähe jeder Zugriff wie vom Server selbst aus. Zum Testen lässt sich `127.0.0.1` in die Liste eintragen.
- **Interne Netze** stehen in den Einstellungen, eine Angabe pro Zeile (Standard: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). Die Vorgabe deckt alle privaten Bereiche ab, auch Docker-Netze und ein Gäste-WLAN. Am besten auf die echten Firmennetze eingrenzen, z. B. `10.0.10.0/24`. Die Seite zeigt an, wie deine aktuelle Adresse erkannt wird.
- **Eigener Internetanschluss:** Ruft ein Rechner im Firmennetz Helfi.Space über die öffentliche Adresse auf, kommt er oft mit der öffentlichen IP des eigenen Anschlusses an (Hairpin-NAT). Diese IP oder einen DynDNS-Namen (z. B. `203.0.113.10` oder `helfi.dyndns.example`) dort eintragen, dann gelten solche Zugriffe als intern. Namen werden alle 5 Minuten neu aufgelöst; ist DNS kurz nicht erreichbar, gilt die zuletzt bekannte Adresse weiter. Achtung: Hängt ein Gäste-WLAN am selben Anschluss, gelten auch Gäste als intern.
- **Hinter einem Reverse-Proxy** muss dessen Adresse in `HELFI_TRUST_PROXY` stehen. Sonst sieht Helfi.Space nur den Proxy und behandelt jeden Zugriff sicherheitshalber als extern. Admins bekommen dann einen Hinweis.
- **Einrichten:** Jeder richtet 2FA unter *Profil → Zwei-Faktor-Anmeldung* ein: QR-Code scannen, Code eingeben, 10 Wiederherstellungscodes sichern. Aus Sicherheitsgründen geht die Ersteinrichtung nur im internen Netz, und zwar in jedem Modus. Ausnahme: nach einer SSO-Anmeldung, deren zweiten Faktor der Identitätsanbieter geprüft hat („SSO-Anmeldungen gelten als zweiter Faktor“). Ist 2FA schon eingerichtet, lässt sie sich nur mit gültigem Code abschalten und dann neu einrichten (z. B. neues Handy). So kann niemand mit einem erbeuteten Kennwort von außen seinen eigenen zweiten Faktor hinterlegen. Wer nur von außen arbeitet, für den lässt sich unter *Sicherheit* die „Ersteinrichtung auch von außen“ erlauben.
- **Sitzungen:** Wer sich im Büro ohne Code angemeldet hat und denselben Browser später von zu Hause nutzt, muss sich dort neu mit Code anmelden. Spätestens 30 Tage nach der Anmeldung endet jede Sitzung, auch bei ständiger Nutzung.
- **Automatische Abmeldung** (*Administration → Sicherheit*): Wer eine Weile nichts tut (keine Klicks, keine Eingaben), wird abgemeldet – für alle nach `HELFI_SESSION_HOURS` (Standard 12 Stunden) oder dem dort eingestellten Wert, für Admins standardmäßig nach 60 Minuten, optional kürzer für Zugriffe von außerhalb des Firmennetzes; es gilt die kürzeste passende Frist. Zwei Minuten vorher fragt Helfi „Noch da?“. Solange jemand arbeitet, auch beim Tippen einer langen Antwort, läuft die Sitzung weiter. Optional endet die Anmeldung mit dem Schließen des Browsers.
- **Handy verloren:** Mit einem Wiederherstellungscode anmelden. Alternativ setzt ein Admin unter *Benutzer → 2FA zurücksetzen* die 2FA zurück, und die Person richtet sie im Büro neu ein.
- **Gilt für** lokale Konten und Active-Directory-Anmeldungen. Bei **SSO** regelt *Sicherheit → SSO-Anmeldung als zweiter Faktor*, ob die Anmeldung beim Identitätsanbieter reicht:
  - **Nur wenn der Anbieter eine MFA meldet** (Standard): Das Token muss eine Mehrfaktor-Anmeldung belegen, also `amr` mit z. B. `mfa`, `otp` oder `hwk` (Entra ID: `mfa`), oder einen der unter *Single Sign-on → acr-Werte für MFA* eingetragenen `acr`-Werte (z. B. Keycloak-Stufe `2`). Sonst fragt Helfi.Space seinen eigenen Code ab.
  - **Immer** oder **Nie** (dann immer zusätzlich der eigene Code).
  - Installationen mit aktivem SSO behalten beim Update ihr bisheriges Verhalten („Immer“); unter *Sicherheit* steht dann ein Hinweis mit der Empfehlung.
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

**SSO und AD zusammen:** Trägst du bei „Mit AD-Konten zusammenführen für Domäne“ deine Domäne ein (z. B. `firma.local`), ist `m.muster@firma.local` aus dem SSO dasselbe Konto wie der AD-Benutzer `m.muster`. Trag die Domäne nur ein, wenn der Anbieter sie wirklich kontrolliert, also keine Gastkonten aus anderen Organisationen zulässt. Ohne Eintrag bleiben SSO-Konten getrennt, und ein Gast `m.muster@fremd.example` kann nie das Konto `m.muster` übernehmen. Steht im Token kein Anmeldename (`preferred_username`/UPN), sondern nur die E-Mail-Adresse, wird nur zusammengeführt, wenn der Anbieter sie als bestätigt meldet (`email_verified`). E-Mail-Adressen aus dem SSO werden nur übernommen und mit E-Mail-Kontakten zusammengeführt, wenn der Anbieter sie als bestätigt meldet oder wenn sie gleich dem Anmeldenamen der freigegebenen Domäne sind (z. B. Entra ID: UPN = Mailadresse).

**Stabile Zusammenführung über die AD-Kennung (empfohlen):** Bei manchen Anbietern (z. B. Keycloak, Authentik) ist der Anmeldename frei wählbar. Trag deshalb unter *Claim mit AD-Kennung* den Claim ein, der die `objectSid` oder `objectGUID` des AD-Kontos enthält: bei Entra ID den optionalen Claim `onprem_sid`, bei Keycloak oder Authentik ein eigenes Mapping auf `objectGUID` (als Text mit Bindestrichen, Hex oder Base64). Dann wird **nur** darüber zusammengeführt, nicht mehr über Namen und Domäne. Mit Dienstkonto prüft Helfi.Space bei jeder SSO-Anmeldung das AD-Konto wie bei einer Kennwort-Anmeldung: deaktiviert oder nicht mehr in der Gruppe „Zugelassene Benutzer“ heißt kein Zugang, die Rolle folgt den AD-Gruppen, und ein noch unbekanntes AD-Konto wird angelegt (außer „Nur vorhandene Konten“ ist eingestellt). Ist das AD gerade nicht erreichbar, wird die SSO-Anmeldung abgebrochen, statt ein getrenntes Konto anzulegen. Ein früher getrenntes SSO-Konto derselben Person bleibt liegen, angemeldet wird ab dann das AD-Konto. Fehlt der Claim im Token oder gibt es die Person im AD nicht, bleibt das SSO-Konto getrennt.

## E-Mail

*Administration → E-Mail*

- **Postfach abrufen (IMAP):** Server, Benutzer und Kennwort des Helpdesk-Postfachs eintragen. Neue Mails werden zu Tickets (inklusive Anhängen bis 20 MB je Anhang und bis zu 30 Anhängen; was nicht übernommen wird, steht als Hinweis im Ticket; Mails über 80 MB werden übersprungen und im Postfach markiert). Antworten auf Mails von Helfi.Space und Antworten Beteiligter mit `[IT-123]` im Betreff werden zu Kommentaren, zitierter Verlauf wird abgeschnitten. Antwortet der Melder auf ein wartendes oder erledigtes Ticket, wird es wieder geöffnet – außer es wurde abgelehnt oder als Duplikat geschlossen: Dann wird die Antwort eine interne Notiz und das Ticket bleibt zu (bei Bedarf öffnet es ein Bearbeiter). Abwesenheitsnotizen und automatische Mails werden ignoriert. Verarbeitete Mails werden gelesen markiert oder in einen Ordner verschoben. Übersprungene Mails (automatisch erzeugt, Stundengrenze, Konto deaktiviert, ohne gültigen Absender, eigene Adresse, Regel „Ignorieren“) und Unzustellbarkeitsberichte bleiben gelesen im Posteingang; sie kommen nicht in den Ordner für verarbeitete Mails und werden deshalb auch nicht automatisch gelöscht.
- **Versand (SMTP):** Als Absender am besten dieselbe Adresse wie das Postfach verwenden, dann landen Antworten wieder im Ticket.
- **Interne Notizen** gehen nie per E-Mail raus.
- Per Ticketnummer im Betreff dürfen nur Beteiligte antworten: der Melder, Anfrage-Teilnehmer und alle, die schon im Ticket geschrieben haben. Der zugewiesene Bearbeiter zählt nicht automatisch dazu. Wer die Nummer nur errät, bekommt ein eigenes neues Ticket. Antworten auf Mails von Helfi.Space werden über die Message-ID immer richtig zugeordnet.
- Wird eine Antwort nur über die Nummer im Betreff zugeordnet, werden ihre An/CC-Empfänger nicht Teilnehmer. Das geschieht nur bei neuen Tickets und bei Antworten auf Mails von Helfi.Space (Bezug über die Message-ID).
- Absenderadressen lassen sich fälschen. Deshalb gilt eine Mail nie als Bearbeiter-Antwort, auch wenn sie von der Adresse eines Bearbeiters kommt: Sie erscheint mit der Absenderadresse, nicht unter dem Konto, und wird nicht an den Melder weitergeleitet. Bearbeiter antworten über die Weboberfläche.
- Antworten per Mail auf Zuweisungs-, SLA- oder Genehmigungsmails an Bearbeiter werden interne Notizen und öffnen das Ticket nicht wieder.
- Antworten auf eine Mail des Ticketsystems von jemandem, der nicht mehr Melder oder Teilnehmer ist (z. B. nach einem Melderwechsel oder als Genehmigender ohne Teilnahme), werden ebenfalls nur interne Notizen: keine neuen Teilnehmer aus CC, kein Wiedereröffnen.
- Mails von der Adresse eines Bearbeiters, die nur über `[IT-123]` im Betreff zugeordnet werden, werden interne Notizen und öffnen nichts wieder; ebenso Mails von einer Bearbeiter-Adresse, die auf eine Mail an jemand anderen antworten (z. B. die Benachrichtigung des Melders) – der Absender einer Mail lässt sich fälschen, die Ticketnummer erraten. Antworten an den Melder deshalb im Ticket schreiben.
- Helfi.Space merkt sich verarbeitete Mails mit einem eigenen IMAP-Kennzeichen (`$HelfiDone`). Liest jemand das Postfach parallel in Outlook oder auf dem Handy, werden die Mails trotzdem verarbeitet. Kann der Mailserver keine eigenen Kennzeichen speichern, holt Helfi.Space wie früher nur ungelesene Mails – dann das Postfach nicht parallel lesen. Empfohlen ist ein Ordner für verarbeitete Mails.
- Eingangsbestätigungen gehen höchstens 60-mal pro Stunde raus (Schutz vor Missbrauch mit gefälschten Absendern).
- Schleifenschutz: Mehr als 20 neue Tickets pro Stunde vom selben Absender werden ignoriert.
- **Schutz vor Mail-Schleifen** (z. B. mit Monitoren, Druckern, Backup-Software):
  - Unzustellbarkeitsberichte (Exchange, Postfix, …) und Lesebestätigungen werden nie zu Tickets oder Kommentaren und nie beantwortet.
  - Gehört ein Bericht zu einer Mail von Helfi.Space, erscheint im Ticket eine interne Notiz „Zustellung fehlgeschlagen“.
  - Die betroffene Adresse bekommt 7 Tage lang keine Mails mehr. Gesperrt werden nur Adressen aus echten Kopfzeilen des Berichts (`X-Failed-Recipients`) bzw. aus seinem Teil `message/delivery-status`, nie Adressen aus dem Mailtext – und nur, wenn der Bericht sich auf eine Mail bezieht, die Helfi.Space an genau diese Adresse geschickt hat (ein gefälschter Bericht sperrt sonst nichts). Die Liste steht unter *Administration → E-Mail → Gesperrte Empfänger*, dort lässt sich eine Adresse auch vorzeitig freigeben.
  - **Absender-Regeln** (Adresse oder Muster wie `*@zabbix.firma.local`): „Ticket anlegen, nie antworten“, wahlweise in ein eigenes Projekt, oder „Ignorieren“. Automatisch erzeugte Mails (Kopfzeile `Auto-Submitted`, `Precedence: bulk`, Absender `noreply@…`), wie sie Proxmox, NAS-Systeme oder Monitoring verschicken, werden nur mit der Regel „Ticket anlegen, nie antworten“ angenommen. Ohne Regel werden sie übersprungen. Unter *Administration → E-Mail* steht bei den zuletzt übersprungenen Mails jeweils Absender und Grund.
- Absender ohne Konto werden als *E-Mail-Kontakt* geführt. Melden sie sich später per AD oder SSO mit derselben Adresse an, werden ihre Tickets übernommen.
- **Absender im AD nachschlagen** (Standard: an, braucht AD-Anmeldung mit Dienstkonto): Unbekannte Absender sucht Helfi.Space im AD. Gesucht wird in `mail`, `userPrincipalName` und den Zweitadressen in `proxyAddresses`, deaktivierte Konten nicht. Bei genau einem Treffer wird die Person gleich als AD-Benutzer angelegt, mit der Rolle aus ihren Gruppen, als hätte sie sich angemeldet. Ein vorhandener E-Mail-Kontakt wird dabei übernommen. Nicht gefunden, mehrdeutig oder AD nicht erreichbar: Sie wird wie bisher E-Mail-Kontakt. Unbekannte Adressen werden eine Stunde lang nicht erneut gesucht. Eine Mail gibt auch dann nie Bearbeiter-Rechte.
- **Aufbewahrung:** „Verarbeitete Mails löschen nach … Tagen“ (Standard 0 = nie, sonst mindestens 7). Einmal täglich werden im Ordner für verarbeitete Mails die älteren Mails endgültig gelöscht, höchstens 500 pro Lauf. Im Posteingang wird nie gelöscht. Ist kein eigener Ordner eingetragen, löscht Helfi.Space gar nichts. Die Inhalte bleiben in den Tickets.

### HTML-Mails

Mails im HTML-Format zeigt Helfi.Space bei Beschreibung und Antworten **formatiert** an, mit Tabellen, Fettdruck, Farben, Signatur und eingebetteten Bildern. Ein Umschalter **„Formatiert | Text“** wechselt zur Textfassung; die Wahl merkt sich der Browser. Bearbeitet wird immer die Textfassung. Nach dem Bearbeiten einer Beschreibung gilt nur noch der Text.

- **Sicherheit:** Das HTML wird beim Empfang bereinigt. Skripte, Formulare, eingebettete Seiten, Ereignis-Attribute und `javascript:`-Links werden entfernt. Angezeigt wird es zusätzlich in einem abgeschotteten Rahmen mit eigener Sicherheitsrichtlinie, in dem kein Skript laufen kann.
- **Bilder:** Eingebettete Bilder wie Logos, Signaturen oder eingefügte Screenshots werden angezeigt. Kleine Logos tauchen nicht in der Anhangsliste auf. **Bilder aus dem Internet** (oft Zählpixel) werden nie geladen; ein Hinweis nennt ihre Anzahl.
- **Antworten:** Der zitierte Verlauf (Outlook, Gmail, Apple Mail, Thunderbird) ist eingeklappt: „Zitierten Text anzeigen“.
- Gilt für Mails, die nach dem Update eingehen.

## Suche

Das Suchfeld oben durchsucht alle Tickets im Volltext: Titel, Beschreibung, Antworten, Stichwörter und Namen der Anhänge. Bearbeiter finden zusätzlich interne Notizen und die beteiligten Personen (Melder, Bearbeiter, Antwortende, auch über Mailadresse und Anmeldenamen). Benutzer ohne Bearbeiter-Rolle finden Tickets über Titel, Beschreibung, öffentliche Antworten, Namen der Anhänge, Stichwörter und die Namen, die sie im Ticket auch sehen (Melder, Bearbeiter, Antwortende) – nie über interne Notizen, Mailadressen oder Anmeldenamen.

- **Treffer schon beim Tippen:** Ab zwei Zeichen zeigt eine Liste unter dem Suchfeld bis zu acht Tickets mit Nummer, Titel, Status und Fundstelle (z. B. „Antwort von Eva Berger: …“). ↑/↓ wählt, Enter oder Klick öffnet das Ticket, Enter ohne Auswahl bzw. *Alle Treffer anzeigen* führt wie bisher zur Ticketliste mit allen Ergebnissen und Filtern; Esc schließt. Eine Ticketnummer steht als „IT-42 öffnen“ ganz oben. Im leeren Feld erscheinen die zuletzt geöffneten Tickets (nur im Browser gespeichert, beim Abmelden gelöscht). Auf dem Handy genauso im Tab *Tickets*.
- **Wortteile** werden gefunden: `drucker` findet auch „Netzwerkdrucker“. Groß- und Kleinschreibung spielt keine Rolle.
- **Mehrere Wörter** in beliebiger Reihenfolge müssen alle vorkommen, `"genaue Folge"` in Anführungszeichen, `-wort` schließt aus.
- **Beste Treffer zuerst:** Titeltreffer zählen am meisten. Ein Klick auf eine Spalte sortiert wie gewohnt, „Beste Treffer zuerst“ stellt zurück.
- **Fundstelle:** unter jedem Treffer steht ein Ausschnitt mit markierten Wörtern und woher er stammt (Beschreibung, Antwort von …, Anhang).
- Eine Ticketnummer wie `HELP-123` springt direkt zum Ticket. Der Suchindex wird beim ersten Start nach dem Update einmal aufgebaut (bei 7000 Tickets unter einer Sekunde) und danach laufend nachgeführt.

## Anfrage-Teilnehmer

Neben dem Melder können weitere Personen an einem Ticket beteiligt sein, z. B. Kollegen mit demselben Problem oder die Vorgesetzte.

- **Hinzufügen:** in der Ticketansicht unter *Anfrage-Teilnehmer → Hinzufügen*.
  - Bearbeiter suchen nach Name oder tragen eine beliebige E-Mail-Adresse ein. Die Vorschläge erscheinen beim Tippen, der Cursor bleibt im Feld; auswählen mit Klick oder ↑/↓ und Enter, Esc bricht ab.
  - **Aus dem AD:** Bearbeiter sehen ab 3 Zeichen auch Personen aus dem AD (markiert mit „AD“), gesucht in Name, Anmeldename und Mailadressen samt Zweitadressen. Wer gewählt wird, wird als AD-Benutzer angelegt bzw. aktualisiert, mit Mailadresse und Rolle aus dem AD; ein vorhandener E-Mail-Kontakt wird übernommen. Auch eine eingetippte Mailadresse wird im AD nachgeschlagen. Personen, die laut Gruppen Helfi.Space nicht nutzen dürfen, kommen als E-Mail-Kontakt dazu. Ist das AD nicht erreichbar, erscheinen nur die vorhandenen Personen. Abschaltbar unter *Administration → Active Directory → Teilnehmer aus dem AD vorschlagen*, braucht das Dienstkonto.
  - Melder und Teilnehmer können Kollegen mit eigenem Konto hinzufügen, aber keine freien Adressen.
  - Höchstens 20 je Ticket.
- **Per E-Mail:** Wer bei einer neuen Mail oder einer Antwort auf eine Mail von Helfi.Space in *An* oder *CC* steht, wird automatisch Teilnehmer (nicht, wenn eine Antwort nur über die Nummer im Betreff zugeordnet wird). Das gilt für höchstens 10 Adressen je Mail; die eigene Helpdesk-Adresse und Bearbeiter zählen nicht mit. Abschaltbar unter *Administration → E-Mail*.
- **Was Teilnehmer dürfen:**
  - das Ticket sehen, auch unter *Meine Anfragen* mit dem Filter „Ich bin Teilnehmer“
  - im Web oder per Antwort-Mail kommentieren und Dateien anhängen
- **Was Teilnehmer nicht dürfen:** interne Notizen sehen, Status, Zuweisung oder Titel ändern. Vom Melder und von anderen Antwortenden sehen sie nur den Namen, nicht Mailadresse und Anmeldenamen (das gilt auch für Genehmigende ohne Bearbeiter-Rolle und in der Personensuche).
- **Absender ist immer das Ticketsystem** (keine Adressen oder Signaturen von Bearbeitern). Antwort- und Erledigt-Mails enden mit „Viele Grüße“, dem Namen des Bearbeiters und dem Namen des Systems; ist das Ticket jemand anderem zugewiesen, steht „Ihr Ansprechpartner: …“ dabei.
- **Benachrichtigungen:** Teilnehmer bekommen dieselben Mails wie der Melder (Antworten, Erledigt), jeder einzeln in seiner Sprache, ohne die Adressen der anderen. Wer im Web hinzugefügt wird, bekommt eine kurze Mail.
- **Entfernen:** Bearbeiter, der Melder oder die Person selbst.

## Ablehnen und Duplikate

Ein erledigtes Ticket hat eine **Lösung**: *Erledigt*, *Abgelehnt* oder *Duplikat*. Intern bleibt der Status „Erledigt“ – Service Level, Board, Berichte, automatisches Schließen und Wiederöffnen funktionieren deshalb wie gewohnt.

- **Ablehnen:** im Status-Menü des Tickets *Ablehnen …* (Handy: Status → *Ablehnen …*). Die **Begründung ist Pflicht** und geht als Antwort an Melder und Teilnehmer – statt der „Erledigt“-Mail. Antwortvorlagen und Platzhalter funktionieren; eine Zufriedenheitsumfrage gibt es nicht.
- **Als Duplikat schließen:** Original-Ticket wählen (Nummer oder Suche). Das Ticket wird mit dem Original verknüpft; der Melder bekommt einen Standardhinweis mit der Nummer des Originals (oder deinen eigenen Text). Optional werden Melder und Teilnehmer **zum Original hinzugefügt** und dort auf dem Laufenden gehalten – nur anhaken, wenn das Original nichts Vertrauliches enthält.
- **Mehrere auf einmal:** in der Ticketliste über die Mehrfachauswahl → *Status* → *Ablehnen …* bzw. *Als Duplikat schließen …*; Platzhalter werden je Ticket ersetzt.
- **Anzeige:** Lozenge *Abgelehnt* bzw. *Duplikat* statt *Erledigt* (Listen, Ticket, *Meine Anfragen*, Handy), „Duplikat von IT-12“ mit Link, Eintrag im Verlauf. Filter *Lösung* in der Ticketliste, sobald der Status *Erledigt* gewählt ist.
- **Wiederöffnen:** Eine Antwort-Mail auf ein abgelehntes oder als Duplikat geschlossenes Ticket öffnet es nicht wieder, sondern wird eine interne Notiz (ein „Danke“ oder eine gefälschte Mail soll die Entscheidung nicht aufheben). Schreibt der Melder in der Weboberfläche, öffnet sich das Ticket wie gewohnt wieder; beim Wiederöffnen wird die Lösung zurückgesetzt. Ein schon erledigtes Ticket lässt sich nachträglich ablehnen oder als Duplikat markieren.
- **Berichte:** Abgelehnte und Duplikate stehen im Bericht je Komponente in einer eigenen Spalte und zählen nicht zur Ø Lösungszeit (auch nicht je Bearbeiter).
- **Servicekatalog:** Eine abgelehnte Genehmigung schließt die Anfrage als *Abgelehnt*.
- **Import:** Lösungen oder Statusnamen aus dem Quellsystem wie „Won't Do“, „Declined“, „Rejected/Abgelehnt“ oder „Cancelled/Storniert“ werden zu *Abgelehnt*, „Duplicate/doppelt“ zu *Duplikat*.

## Tickets für andere erfassen

Kommt ein Anliegen per Telefon, im Flur oder an ein anderes Postfach, erfassen Bearbeiter das Ticket gleich im Namen der Person. So landet es bei ihr unter *Meine Anfragen*, und sie gewöhnt sich ans Ticketsystem.

- **Beim Erstellen:** Im Dialog *Ticket erstellen* steht oben der **Melder**, voreingestellt „Ich“. *Für jemand anderen erfassen* öffnet die Suche:
  - vorhandene Konten nach Name, Anmeldename oder Mailadresse
  - ab 3 Zeichen auch Personen aus dem AD (wie bei den Teilnehmern; sie werden beim Speichern als AD-Benutzer angelegt)
  - oder eine beliebige Mailadresse; ohne Konto entsteht ein E-Mail-Kontakt wie bei Tickets per Mail
- **Benachrichtigen** (standardmäßig an): Die Person bekommt eine Mail mit Ticketnummer und Link. Personen mit Konto erhalten dazu den Hinweis, dass sie neue Anliegen künftig selbst in Helfi.Space melden können. Ist der Mailabruf eingerichtet, können sie auf die Mail antworten.
- **Nachvollziehbar:** Der Verlauf zeigt, welcher Bearbeiter das Ticket für wen angelegt hat.
- **Nachträglich ändern:** in den Details *Melder → Melder ändern* (Handy: *Alle Details → Melder*). Der bisherige Melder behält als Anfrage-Teilnehmer Zugriff; Bearbeiter und reine E-Mail-Kontakte nicht. Die Änderung steht im Verlauf.
- **Nur Bearbeiter:** Benutzer können keinen anderen Melder eintragen (der Server lehnt das ab). Deaktivierte Konten lassen sich nicht wählen.
- **Auf dem Handy:** *+ → Problem melden* zeigt Bearbeitern oben das Feld *Melder*.

## Antworten formatieren

Über dem Kommentarfeld liegt eine Werkzeugleiste – im Ticket, bei Kommentaren zu Wissensartikeln und auf dem Handy (dort erscheint sie beim Schreiben und lässt sich seitlich wischen):

- **KI** (wenn eingerichtet): Antwort vorschlagen, glätten, kürzen, übersetzen.
- **Formatieren:** fett (Strg+B), kursiv (Strg+I), unterstrichen, durchgestrichen, Code; Aufzählung, nummerierte Liste, Zitat, Codeblock. Die Formatierung ist beim Schreiben sichtbar; „- “, „1. “ oder „> “ am Zeilenanfang gehen auch.
- **Link** (Strg+K, auch Ticketnummern wie IT-42), **Bild** (oder Strg+V), **Emoji** (auch „:)“) und **@** zum Erwähnen.
- **Vorformulierte Antworten** rechts in der Leiste, im selben Menü *Als Vorlage speichern*. Strg+Enter speichert.

Gespeichert wird Text im Format der Wissensartikel. Melder und Teilnehmer bekommen die Antwort formatiert per Mail (HTML) mit einem lesbaren Textteil ohne Sternchen. Ältere Kommentare und Mails werden unverändert angezeigt.

## @-Erwähnungen

Bearbeiter holen Kollegen gezielt in ein Ticket: Im Antwortfeld (Desktop und Handy) **@** und ein paar Buchstaben tippen, Person auswählen (Klick/Tippen oder ↑/↓ und Enter bzw. Tab; Esc schließt die Liste). Im Kommentar erscheint der Name hervorgehoben, die eigene Erwähnung farbig.

- **Wer erwähnt werden kann:** in einer **internen Notiz** nur Bearbeiter; in einer **Antwort** außerdem Melder, Teilnehmer und Genehmigende des Tickets. Wer das Ticket nicht sehen darf, wird nicht angeboten – und auch ein von Hand getippter Verweis wird beim Speichern zu reinem Text. Melder erwähnen niemanden; Kommentare aus E-Mails auch nicht (Absender lassen sich fälschen).
- **Benachrichtigung:** Wer erwähnt wird, bekommt eine Mail vom Ticketsystem („[IT-12] Anna hat Sie erwähnt: …“) mit dem Kommentar und dem Link. Melder und Teilnehmer, die die Antwort ohnehin per Mail bekommen, erhalten keine zweite. Wer sich selbst erwähnt, bekommt nichts. Antworten auf die Mail eines Bearbeiters werden wie gewohnt zu internen Notizen. Abschaltbar unter *Kanäle: E-Mail → Benachrichtigungen*.
- **Wiederfinden:** *Erwähnt mich* in der Seitenleiste (Handy: Chip *Erwähnt* unter *Tickets*) listet alle Tickets mit einer Erwähnung; die Zahl daneben zählt die noch nicht geöffneten. Neue Erwähnungen sind in den Listen mit **@** markiert, der betreffende Kommentar im Ticket ebenfalls. Mit dem Öffnen des Tickets gilt die Erwähnung als gesehen.
- Erwähnungen werden nicht automatisch zu Teilnehmern oder Beobachtern – dafür gibt es *Anfrage-Teilnehmer*.

## Gespeicherte Filter und Warteschlangen

In der Ticketliste Filter, Suche und Sortierung einstellen und **Filter speichern** wählen. Der Filter erscheint links unter *Gespeicherte Filter* mit der aktuellen Anzahl (Handy: als Chip unter *Tickets*); die Liste trägt dann seinen Namen.

- **Persönlich:** Jeder Bearbeiter hat eigene Filter (bis zu 50). Andere sehen sie nicht.
- **Für alle Bearbeiter:** Admins können einen Filter beim Speichern freigeben. Er erscheint bei allen Bearbeitern als Warteschlange (mit Personen-Symbol). „Mir zugewiesen“ bezieht sich dabei auf die jeweilige Person.
- **Verwalten:** Das Symbol neben *Gespeicherte Filter* öffnet die Liste zum Umbenennen, Sortieren (↑/↓) und Löschen. Freigegebene Warteschlangen ändern nur Admins.
- Gespeichert werden nur Filter der Ticketliste (Projekt, Status, Typ, Priorität, Bearbeiter, Komponente, Stichwort, Suche, Sortierung …).

## Komponenten

*Administration → Komponenten* (oder *Projekte → Komponenten*)

Komponenten teilen ein Projekt in Zuständigkeiten auf. Jede hat einen Namen, eine kurze Beschreibung, eine **verantwortliche Person**, optional eine **Vertretung**, **Schlagwörter** und optional **Absender-Muster**.

- **Zuordnen:** Beim Anlegen eines Tickets (Web, Handy, E-Mail, Servicekatalog) entscheidet zuerst ein passender Absender (z. B. `*@zabbix.firma.local`), sonst die Schlagwörter: Ein Treffer im Titel zählt 3, in der Beschreibung 1. Bei Gleichstand gewinnt die Komponente, die weiter oben steht. Ab 4 Buchstaben zählt ein Schlagwort auch als Teil eines Worts („drucker“ findet „Netzwerkdrucker“), kürzere nur als ganzes Wort („pc“ findet nicht „PCIe“).
- **Zuweisen:** Ist noch niemand zugewiesen, bekommt die verantwortliche Person das Ticket; ist sie deaktiviert, die Vertretung. Ein Bearbeiter, der beim Anlegen selbst jemanden auswählt, hat Vorrang.
- **Nachvollziehbar:** Der Verlauf zeigt „Komponente VPN & Fernzugriff (Schlagwörter: vpn, forticlient)“ und „zugewiesen an Anna (verantwortlich für VPN & Fernzugriff)“. Bearbeiter ändern die Komponente im Ticket (Handy: unter *Alle Details*); auch das steht im Verlauf.
- **Testen:** Unter der Liste probierst du mit Titel, Beschreibung und Absender aus, welche Komponente ein Ticket bekäme und warum.
- **Beispiele übernehmen:** fertige Komponenten mit Beschreibung und deutschen wie englischen Schlagwörtern für IT-Support (Arbeitsplatz & PC, Drucker & Scanner, E-Mail & Kalender, Netzwerk & WLAN, VPN & Fernzugriff, Benutzerkonto & Kennwort, Telefonie & Mobilgeräte, Software & Lizenzen, Server & Speicher, Webseite & Intranet), Haustechnik und Verwaltung/Service.
- **Liste und Berichte:** Filter und Spalte *Komponente* in der Ticketliste (bei gewähltem Projekt); unter *Berichte* Tickets, offene und Ø Lösungszeit je Komponente.
- Komponenten sind nur für Bearbeiter sichtbar. Löschen lässt die Tickets unangetastet (das Feld wird leer), archivierte Komponenten bleiben an alten Tickets sichtbar, werden aber nicht mehr zugeordnet. Beim Verschieben in ein anderes Projekt fällt die Komponente weg.
- Liefert das Quellsystem beim **Import** Komponenten mit, kommt die (erste) Komponente mit und wird im Zielprojekt angelegt, falls es sie noch nicht gibt.
- **Bestehende Tickets einordnen:** Unten auf der Seite ordnest du Tickets ohne Komponente nachträglich zu – etwa nach dem Import oder wenn Komponenten neu dazukommen. *Vorschau* zeigt, wie viele es sind und wie viele eine Regel trifft; *Einordnen starten* wendet zuerst die Regeln an und schickt den Rest – wenn die KI-Funktion *Komponente erkennen* an ist – nacheinander an die KI (im Hintergrund, mit Fortschritt, jederzeit abbrechbar).
  - Standardmäßig nur offene Tickets; erledigte nur mit Haken bei *Auch erledigte Tickets*. Je Lauf gehen höchstens 1000 Tickets an die KI (für den Rest einfach erneut starten); vor dem Start steht, wie viel Text an die KI geht – bei einer KI im Internet mit Hinweis auf mögliche Kosten. Tickets, die die KI schon geprüft hat, überspringt der Lauf (außer mit *erneut prüfen*).
  - Die KI macht standardmäßig nur **Vorschläge**: Unter *KI-Vorschläge prüfen* übernimmst oder verwirfst du sie einzeln oder mehrere auf einmal. Wahlweise setzt sie die Komponente direkt („von KI“ im Verlauf).
  - Nachträglich gehen **keine Mails** raus, niemand bekommt Tickets **zugewiesen**, und die Zeit „Aktualisiert“ bleibt, damit Listen ihre Reihenfolge behalten. Der Verlauf zeigt, woher die Komponente kommt.

**Tipp – Komponenten sinnvoll schneiden:** nach Zuständigkeit, nicht nach Technik; lieber 6–12 Komponenten als 40; jede braucht eine verantwortliche Person; Schlagwörter aus echten Tickettiteln nehmen und mit dem Testfeld prüfen.

## Mehrere Tickets auf einmal bearbeiten

In *Alle Tickets* (Bearbeiter):
- **Auswählen:** Kästchen vor jeder Zeile, „alle“ im Kopf, Umschalt+Klick für einen Bereich, `x` für das mit `j`/`k` markierte Ticket.
- **Aktionsleiste:**
  - **Erledigen** und **Status:** jeweils mit optionalem Kommentar – wahlweise als Antwort an Melder und Teilnehmer oder als interne Notiz, mit Vorlagen und Platzhaltern je Ticket. Mit Antwort gibt es keine zusätzliche „Erledigt“-Mail.
  - **Kommentieren:** Antwort oder interne Notiz für alle ausgewählten Tickets, ohne den Status zu ändern.
  - **Verknüpfen …:** alle ausgewählten Tickets mit einem Ticket verknüpfen, z. B. „wird verursacht durch IT-42“; optional gleich mit Status und Kommentar. Bestehende Verknüpfungen bleiben, wie sie sind.
  - **Zuweisen**, **Priorität**
  - **Komponente:** setzen oder entfernen (*Keine Komponente*), wenn alle ausgewählten Tickets aus einem Projekt stammen – wie eine Änderung im Ticket: Eintrag im Verlauf, keine Mail, niemand wird automatisch zugewiesen.
  - **In ein anderes Projekt verschieben**
- Jede Änderung landet im Verlauf des Tickets. Klappt ein Ticket nicht, laufen die anderen trotzdem durch, und die Meldung nennt es.

**Tickets werden nie gelöscht**, auch nicht von Admins, damit der Verlauf nachweisbar bleibt. Was erledigt ist, wird auf „Erledigt“ gesetzt. Gegen Spam hilft eine Absender-Regel „Ignorieren“. Ein Projekt lässt sich nur löschen, wenn seine Tickets dabei in ein anderes Projekt verschoben werden. Soll es samt Tickets erhalten bleiben, archiviert man es stattdessen.

## Verknüpfungen und Unteraufgaben

In der Ticketansicht (Bearbeiter) unter *Verknüpfungen* – oder schneller über **Verknüpfen** oben neben dem Status; auf dem Handy unter *Details*. Viele Tickets auf einmal verknüpft die Mehrfachauswahl. Im Feld für das Ticket sucht man nach Nummer oder Stichwort (Titel, Beschreibung, Kommentare); solange es leer ist, gibt es Vorschläge: **mögliche Ursache** (offene Probleme und Major Incidents) und **ähnliche Tickets** (dieselben auffälligen Wörter in Titel und Beschreibung, ohne schon verknüpfte).

- **Verknüpfen:** „bezieht sich auf“, „ist Duplikat von“, „blockiert“ / „wird blockiert von“, „verursacht“ / „wird verursacht durch“, „ist Unteraufgabe von“ / „hat Unteraufgabe“. Die Gegenseite sieht die Verknüpfung automatisch, beide Tickets bekommen einen Verlaufseintrag. Bei „ist Duplikat von“ lässt sich das Ticket gleich auf „Erledigt“ setzen.
- **Unteraufgaben:** direkt anlegen (Aufgabe im selben Projekt) oder bestehende Tickets unterordnen. Ein Fortschrittsbalken zeigt „x von y erledigt“. Ein Ticket hat höchstens ein übergeordnetes Ticket, Kreise werden abgelehnt.
- Verknüpfungen sehen nur Bearbeiter; höchstens 50 je Ticket.

## Auswirkung, Dringlichkeit und Major Incident

- **Priorität nach ITIL:** In den Details setzen Bearbeiter *Auswirkung* und *Dringlichkeit* (hoch/mittel/niedrig). Sind beide gesetzt, ergibt sich die Priorität aus der Matrix (z. B. hoch × hoch = Sehr hoch, mittel × mittel = Mittel). Von Hand lässt sie sich weiterhin ändern.
- **Major Incident:** Eine Störung mit vielen Betroffenen über den Knopf *Major Incident* kennzeichnen. Alle Bearbeiter sehen sie oben als roten Hinweis. Betroffene Tickets hängst du über *Verknüpfen → verursacht* an. **Info an alle Betroffenen** schreibt dieselbe Antwort in den Major Incident und alle offenen betroffenen Tickets, sodass jeder Melder und Teilnehmer sie per Mail bekommt. Optional werden danach alle auf „Erledigt“ gesetzt.

## Service Level (SLA)

*Administration → Service Level* (standardmäßig aus):

- **Ziele je Priorität** für die **erste Reaktion** (erste öffentliche Antwort eines Bearbeiters) und die **Lösung**, in Geschäftsstunden. Vorgabe: Sehr hoch 0,5 / 4 Std, Hoch 2 / 16, Mittel 8 / 40, Niedrig 16 / 80.
- **Geschäftszeiten** (Wochentage, Beginn, Ende) und **Feiertage** (eine Zeile je Tag, `2026-12-24 Heiligabend`). Außerhalb läuft keine SLA-Zeit; maßgeblich ist die Zeitzone `TZ` des Containers.
- **„Wartet“ hält die Lösungszeit an** (abschaltbar).
- Gilt für Störungen, Anfragen und Fragen von Benutzern, nicht für Aufgaben und eigene Tickets der Bearbeiter und nicht für importierte Tickets.
- **Anzeige:** In der Ticketansicht stehen beide Uhren mit Restzeit, grün, gelb ab 80 % (einstellbar) und rot bei Überschreitung. In der Ticketliste gibt es eine SLA-Spalte, in der Seitenleiste die Ansicht **SLA gefährdet** mit Zähler.
- **Warnung:** Bei Erreichen der Warnschwelle und bei Überschreitung bekommt der Bearbeiter eine Mail (ohne Bearbeiter die Projektleitung), jeweils einmal. Der Verlauf hält es fest.

## Problem-Management

- **Problem anlegen:** In einer Störung über *Problem anlegen*. Das Problem wird gleich mit der Störung verknüpft. Probleme legen nur Bearbeiter an; die Seitenleiste zeigt offene **Probleme** mit Zähler.
- **Felder:** *Ursache*, *Workaround* und **Bekannter Fehler** (Ursache und Workaround sind bekannt, die endgültige Lösung steht noch aus).
- **Betroffene Störungen** hängen über *Verknüpfen → verursacht* am Problem. Dort sehen Bearbeiter oben „Ursache bekannt“ mit dem Workaround und übernehmen ihn mit einem Klick in die Antwort.
- **Störungen informieren:** schreibt dieselbe Antwort in alle offenen betroffenen Störungen, z. B. wenn die Lösung eingespielt ist.

## Change-Management

Tickettyp **Change** (nur Bearbeiter), mit eigenem Abschnitt im Ticket:

- **Arten:**
  - **Normal:** braucht eine Genehmigung.
  - **Standard:** vorab genehmigte Routine nach einer Vorlage, ohne Genehmigung.
  - **Notfall:** sofort umsetzen, Genehmigung nachträglich.
- **Felder:** Grund, Risiko, betroffene Dienste und Geräte, geplanter Beginn und geplantes Ende, Umsetzungs-, Rückfall- und Testplan.
- **Ablauf:** Entwurf → Zur Genehmigung → Genehmigt/Abgelehnt → Geplant → In Umsetzung → Überprüfung → Abgeschlossen. Der Ticketstatus folgt automatisch. Fehlende Pflichtangaben nennt Helfi.Space beim jeweiligen Schritt.
- **Genehmigung (CAB):** Genehmiger und Regel („eine Zustimmung genügt“ oder „alle müssen zustimmen“) unter *Administration → Change*. Genehmiger bekommen eine Mail und entscheiden im Ticket (mit Kommentar) oder über die Ansicht **Meine Genehmigungen**. Jede Entscheidung steht im Verlauf. Nach einer Ablehnung lässt sich der Change überarbeiten und neu vorlegen.
- **Vorlagen für Standard-Changes** (z. B. Firmware-Update) unter *Administration → Change*, im Change mit einem Klick übernommen.
- **Abschluss:** Ergebnis „Erfolgreich“, „Mit Problemen“ oder „Zurückgerollt“. Bei den beiden letzten ist eine Nachbetrachtung Pflicht.
- **Change-Kalender** in der Seitenleiste: Monatsansicht aller geplanten Changes, zeitliche Überschneidungen sind rot markiert.

## Wissensdatenbank

*Wissen* in der Seitenleiste; für Benutzer heißt sie *Hilfe & Wissen*.

- **Artikel** mit Titel, Kategorie und formatiertem Inhalt. Sichtbarkeit **intern** (nur Bearbeiter) oder **öffentlich** (alle Angemeldeten).
- **Suche** über Titel und Inhalt, Titeltreffer zuerst; Filter nach Kategorie. Lesehäufigkeit je Artikel für Bearbeiter.
- **Editor:** Bearbeiten im fertigen Aussehen mit Werkzeugleiste: Überschriften, Fett/Kursiv/Unterstrichen/Durchgestrichen, Aufzählung, nummerierte Liste, Checkliste, Zitat, Codeblock, Infobox (Hinweis, Tipp, Warnung), Tabelle, Trennlinie, Link (auch auf Tickets wie `IT-42` oder Artikel `KB-3`), Emoji und Bilder. Bilder kommen per Strg+V, Drag & Drop oder Knopf hinein, mit Größe und Bildunterschrift. Markdown-Kürzel beim Tippen (`# `, `- `, `1. `, `[] `, `> `, ```` ``` ````, `---`), Tastenkürzel (Strg+B/I/U/K/E/S). Einfügen aus Word oder Webseiten übernimmt Überschriften, Listen, Tabellen und Links; Bilder von fremden Adressen werden nicht übernommen. Ungespeicherte Änderungen sichert der Browser als Entwurf. Gespeichert wird schlichter Text im Markdown-Stil, kein HTML.
- **Inhaltsverzeichnis** in der Artikelansicht ab drei Überschriften.
- **Versionen:** Jedes Speichern ist eine Version (mit optionaler Änderungsnotiz). *Version n · Verlauf* am Artikel zeigt alle Versionen; zwei davon lassen sich wortgenau vergleichen (entfernt rot, neu grün), ältere ansehen und wiederherstellen – das legt eine neue Version an, der Verlauf bleibt vollständig.
- **Vorlagen:** „Neuer Artikel“ beginnt mit der Wahl: leere Seite, Anleitung, Störung beheben (FAQ), Checkliste, Bekannter Fehler oder eine eigene Vorlage. Eigene Vorlagen entstehen im Editor über *Als Vorlage speichern* und werden unter *Wissen → Vorlagen* gepflegt.
- **Seitenbaum:** Artikel können unter anderen stehen (*Liegt unter* im Editor, *Unterseite* am Artikel, am PC per Ziehen im Seitenbaum; *Neuer Ordner* legt eine Sammelseite ohne eigenen Text an), beliebig tief. Die Startseite zeigt den Baum und die zuletzt geänderten Artikel, jeder Artikel den Pfad, den Baum links (auf dem Handy hinter *Seiten*) und seine Unterseiten. Benutzer sehen nur öffentliche Seiten; eine öffentliche Seite unter einer internen rückt für sie eine Ebene hoch. Beim Löschen rücken Unterseiten eine Ebene hoch. Verschieben legt keine neue Version an.
- **Drucken / PDF:** eigenes Drucklayout (nur Titel, Pfad, Stand und Inhalt; keine Umbrüche mitten in Bildern, Tabellen oder Infoboxen). Mit Unterseiten entsteht ein Dokument mit Inhaltsverzeichnis, jede Seite beginnt auf einem neuen Blatt. Im Druckdialog „Als PDF speichern“ wählen.
- **„War dieser Artikel hilfreich?“** 👍/👎 unter jedem Artikel, am PC und auf dem Handy: eine Stimme pro Konto, erneuter Klick nimmt sie zurück. Nach 👎 kann man kurz schreiben, was gefehlt hat – das sehen nur Bearbeiter (*Rückmeldungen* am Artikel). Bearbeiter sehen die Bewertung in der Artikelliste, der Filter *Braucht Überarbeitung* zeigt Artikel mit 👎-Stimmen, die meisten zuerst. Nach einer Überarbeitung setzt *Bewertung zurücksetzen* die Stimmen auf null; die Notizen bleiben als frühere Rückmeldungen erhalten.
- **Kommentare:** Wer einen Artikel sehen darf, kann ihn kommentieren (auch Benutzer bei öffentlichen Artikeln). Autor und letzter Bearbeiter bekommen eine Mail, Bearbeiter markieren Kommentare als erledigt, eigene lassen sich löschen. Die Artikelliste zeigt offene Kommentare.
- **Vorschläge beim Melden:** Tippt ein Benutzer im Dialog „Ticket erstellen“ die Zusammenfassung, erscheinen passende öffentliche Artikel („Vielleicht hilft das schon“). Sie öffnen sich, ohne dass die Meldung verloren geht.
- **Aus einem Ticket:** *Wissensartikel* im Ticket legt einen Entwurf an, mit Beschreibung, letzter Antwort und bei Problemen mit Ursache und Workaround. Vor dem Veröffentlichen persönliche Angaben entfernen. Der Verlauf des Tickets verweist auf den Artikel.
- **Bekannte Fehler:** Reiter mit allen Problemen, die als bekannter Fehler markiert sind, samt Workaround.
- **Beispiel-Artikel:** *Beispiele* (Bearbeiter) übernimmt fertige Musterartikel – „So meldest du ein Problem richtig“, „VPN einrichten“, „Drucker hinzufügen“, „Kennwort ändern oder vergessen“, „Abwesenheitsnotiz einrichten“ – auf Deutsch oder Englisch. Sie werden **intern** angelegt: Angaben in eckigen Klammern anpassen, dann öffentlich machen.

## Servicekatalog

Standardanfragen mit eigenem Formular, z. B. „Neuer Mitarbeiter“, „Software-Wunsch“ oder „Zugang zu einem Laufwerk“. Angelegt werden sie unter *Administration → Servicekatalog*.

- **Formular:** Felder vom Typ Text, mehrzeilig, Auswahl, Häkchen oder Datum, jeweils optional als Pflichtfeld. Die Antworten stehen übersichtlich in der Beschreibung des Tickets (Typ *Anfrage*).
- **Service anfordern** in der Seitenleiste zeigt Benutzern und Bearbeitern alle Angebote als Kacheln.
- **Genehmigung (optional):** Pro Angebot legst du fest, wer zustimmen muss und ob eine Zustimmung genügt oder alle zustimmen müssen. Genehmiger dürfen auch Personen ohne Bearbeiter-Rolle sein, etwa Vorgesetzte; sie sehen dann nur die Anfragen, über die sie entscheiden. Sie bekommen eine Mail und finden offene Entscheidungen unter **Meine Genehmigungen**.
- **Ergebnis:** Die Entscheidung kommt als Antwort ins Ticket, der Melder bekommt sie also auch per Mail. Eine Ablehnung schließt die Anfrage.
- **Beispiele übernehmen:** *Beispiele* legt typische Angebote mit fertigem Formular an – neue Mitarbeiterin/neuer Mitarbeiter, Ausscheiden, Software installieren, Zugriff auf Laufwerk oder Ordner, Hardware bestellen, WLAN für Gäste, Verteiler oder Gruppenpostfach – auf Deutsch oder Englisch. Sie sind zunächst **ausgeschaltet**: Felder, Projekt und Genehmigende prüfen, dann einschalten.

## Geräte & Dienste

Ein schlankes Verzeichnis der IT-Ausstattung und Dienste (CI-Verzeichnis), nur für Bearbeiter: *Geräte & Dienste* in der Seitenleiste.

- **Einträge** mit Name (z. B. `PC-0001`), Art (Arbeitsplatz, Server, Netzwerk, Drucker, Telefon/Mobil, Dienst, Anwendung, Sonstiges), Status (in Betrieb, in Wartung, ausgemustert), Standort, Benutzer bzw. Verantwortlichem, IP-Adresse, Seriennummer, Hersteller, Modell und Beschreibung. Suche über alle Angaben; ausgemusterte Einträge sind standardmäßig ausgeblendet.
- **Im Ticket** verknüpfst du betroffene Geräte und Dienste im Abschnitt *Geräte & Dienste*. Das funktioniert für alle Tickettypen, auch für Changes (betroffene Dienste) und Probleme. Eine Zahl am Eintrag zeigt, dass noch weitere offene Tickets dazu existieren.
- **Verlauf je Eintrag:** Alle Tickets zu einem Gerät oder Dienst auf einen Blick, z. B. um wiederkehrende Störungen zu erkennen.
- **CSV-Import** (Administratoren) aus der Inventarisierung: erste Zeile = Spaltennamen (u. a. Name/Hostname, Typ, Standort, IP-Adresse, Seriennummer, Hersteller, Modell, Benutzer, Status). Trennzeichen `;`, `,` oder Tab. Vorhandene Einträge mit gleichem Namen werden aktualisiert.
- **Löschen** nur Administratoren, und nur, solange keine Tickets verknüpft sind. Danach setzt du den Eintrag auf „ausgemustert“; der Verlauf bleibt erhalten.

## Zufriedenheitsumfrage

Einschalten unter *Administration → E-Mail → Zufriedenheitsumfrage* (Standard: aus).

- **In der „Erledigt“-Mail** bekommt der Melder fünf Links von „sehr zufrieden“ bis „sehr unzufrieden“. Ein Klick genügt, eine Anmeldung ist nicht nötig. Auf der Seite kann er die Sterne noch ändern und freiwillig einen Kommentar schreiben. Anfrage-Teilnehmer bekommen keine Links.
- **Im Ticket** können angemeldete Melder ebenfalls bewerten. Bearbeiter sehen die Bewertung samt Kommentar oben im Ticket; Änderungen der Sterne stehen im Verlauf.
- **Sicherheit:** Jeder Link enthält ein zufälliges Token, gespeichert wird nur dessen Hash. Der Link gilt eine einstellbare Zahl von Tagen (Standard 14) und zeigt nur Ticketnummer und Titel. Wird das Ticket wieder geöffnet und erneut erledigt, gibt es eine neue Umfrage; der alte Link verfällt.
- **Auswertung** unter *Berichte → Zufriedenheit*: Durchschnitt, Rücklaufquote, Verteilung der Sterne, Werte je Bearbeiter und die neuesten Kommentare. Probleme und Changes werden nicht abgefragt.

## Auf dem Smartphone

Auf dem Handy öffnet sich Helfi.Space automatisch in einer eigenen, app-artigen Oberfläche (unter `/m`). Tablets und Computer bekommen weiter die gewohnte Ansicht.

- **Unten eine Tab-Leiste:** *Meine Arbeit* bzw. *Anfragen*, *Tickets* (Bearbeiter), der runde **＋**-Knopf, *Wissen* und *Ich*. Seiten schieben sich wie in einer App herein; Zurück per Knopf, Wisch vom linken Rand oder Zurück-Taste. Listen lassen sich nach unten ziehen zum Aktualisieren.
- **Melden (＋):** Problem melden mit Titel, Beschreibung, **Foto aufnehmen** oder **Datei**; Bearbeiter wählen zusätzlich Projekt, Typ und Priorität (wie am PC). Schon beim Tippen des Titels schlägt Helfi.Space passende Wissensartikel vor. Gibt es einen Servicekatalog, stehen seine Angebote als große Kacheln daneben – mit allen Feldarten, Pflichtfeldern und Genehmigung. Ein nicht abgeschickter Entwurf bleibt erhalten, bis der Tab geschlossen wird.
- **Ticket:** Kommentare wie ein Chat, Antwortleiste unten mit Fotos und Dateien; Bearbeiter blenden über *Alle* auch den Verlauf (Status, Zuweisungen …) ein – das Handy merkt sich die Wahl. Bearbeiter schreiben auch interne Notizen, nutzen Vorlagen, ändern Status, Bearbeiter, Priorität, Typ und Teilnehmer, verknüpfen Tickets und genehmigen Anfragen. Titel und Beschreibung ändern Bearbeiter und der Melder selbst.
- **Wissen:** Suche, Kategorien, *Zuletzt angesehen*, *Meistgelesen* und der Seitenbaum zum Durchklicken. Artikel mit Inhaltsverzeichnis, seitlich scrollenden Tabellen und Kommentaren. Bearbeitet werden Artikel am PC (*Im Desktop bearbeiten*). Benutzer sehen nur öffentliche Artikel.
- **Ich:** Name, E-Mail und Kennwort (lokale Konten), Sprache, **Zwei-Faktor-Anmeldung** direkt auf dem Handy (geheimer Schlüssel zum Kopieren und Knopf *In Authenticator-App öffnen* statt QR-Code, der QR-Code bleibt für ein zweites Gerät; danach die Wiederherstellungscodes zum Kopieren oder Teilen), Neuigkeiten und *Desktop-Ansicht*.
- **Als App installieren:** iPhone/iPad: in Safari *Teilen* → *Zum Home-Bildschirm*. Android: in Chrome ⋮ → *App installieren* (oder der Knopf unter *Ich → App installieren*). Helfi.Space startet dann im Vollbild mit eigenem Symbol; ein kleiner Service Worker hält nur die Programmdateien bereit und zeigt ohne Verbindung eine Hinweisseite. Neue Versionen kommen automatisch („Neue Version – Neu laden“).
- **Umschalten:** *Ich → Desktop-Ansicht* wechselt dauerhaft zur gewohnten Ansicht, im Benutzermenü führt *Handy-Ansicht* zurück. Seiten, die es nur am PC gibt (Administration, Berichte, Board …), öffnen sich in der Desktop-Ansicht.
- **Datenschutz:** Fotos werden ohne Standortdaten hochgeladen: Kamerafotos (JPEG) werden auf dem Handy immer neu gespeichert, dabei fallen Metadaten wie der Aufnahmeort (EXIF/GPS) weg; große Bilder (über 2560 px) werden zusätzlich verkleinert. Bilder, die der Browser nicht lesen kann (z. B. HEIC), gehen unverändert hoch. Ticketdaten, Anhänge und Antworten des Servers werden **nicht** auf dem Gerät zwischengespeichert (`Cache-Control: no-store`, auch Bilder in Wissensartikeln) – nur die Programmdateien. Nicht gesendete Entwürfe gehören zum Konto und werden beim Abmelden, bei abgelaufener Sitzung und bei einem Kontowechsel gelöscht; nicht gesendete Uploads löscht der Server nach einem Tag. Es wird nichts aus dem Internet geladen.

Die Desktop-Ansicht bleibt auch auf schmalen Bildschirmen benutzbar (Menü als Schublade, Listen als Karten, Dialoge im Vollbild).

## Emojis

In Kommentaren, Beschreibungen und Antwortvorlagen:

- **🙂-Knopf** in der Werkzeugleiste des Kommentarfelds (in anderen Textfeldern unten rechts): Auswahl mit Suche (deutsch und englisch, z. B. „daumen“ oder „drucker“), Gruppen und „Zuletzt verwendet“.
- **Beim Tippen:** `:dau` schlägt 👍 vor (Pfeiltasten, Enter oder Tab übernimmt, Esc schließt). Ein fertiger Kurzname wie `:tada:` wird sofort zu 🎉. Uhrzeiten wie `12:30` und Adressen bleiben unberührt.
- **Klassische Smileys** werden beim Tippen umgewandelt, sobald danach ein Leerzeichen kommt (oder beim Absenden): `:)` → 🙂, `;)` → 😉, `:D` → 😄, `:(` → 🙁, `:P` → 😛, `:O` → 😮, `<3` → ❤️, `(y)` → 👍. Nur wenn sie allein stehen, `C:)` bleibt also unverändert. **Strg+Z** macht die Umwandlung sofort rückgängig.
- Angezeigt wird mit der Emoji-Schrift des Betriebssystems; es wird nichts aus dem Internet geladen. In E-Mails kommen die Emojis ganz normal an.

## Antwortvorlagen

Für Antworten, die immer wieder gleich sind (z. B. „Bitte starten Sie den Rechner neu“):

- **Einfügen:** im Kommentarfeld auf **Vorlage** klicken, tippen zum Suchen, mit Enter oder Klick einfügen. Der Text landet an der Cursorposition und lässt sich vor dem Speichern noch anpassen. Funktioniert für Antworten und interne Notizen. Nur Bearbeiter sehen die Vorlagen.
- **Platzhalter:** `{melder}`, `{ticket}`, `{titel}`, `{bearbeiter}` (englisch `{reporter}`, `{title}`, `{agent}`) werden beim Einfügen ersetzt.
- **Anlegen:**
  - Text im Kommentarfeld schreiben und **Als Vorlage speichern** wählen.
  - Vorlagen für alle pflegen Admins unter *Administration → Antwortvorlagen*.
  - Persönliche Vorlagen pflegt jeder Bearbeiter in seinem *Profil*; sie sieht nur er selbst.
- **Beispiele übernehmen:** Unter *Administration → Antwortvorlagen* legt *Beispiele* zehn häufige Antworten für alle an (Eingang bestätigen, weitere Angaben nötig, bitte neu starten, Kennwort zurückgesetzt, Fernwartung vereinbaren, wartet auf Hersteller, Hardware bestellt, bekannte Störung, gelöst – bitte bestätigen, schließen ohne Rückmeldung), mit Platzhaltern, auf Deutsch (Sie-Form) oder Englisch. Vorhandene mit gleichem Titel werden übersprungen.

## Berichte

*Berichte* (für alle Bearbeiter sichtbar) zeigt, wer wie viele Tickets bearbeitet und erledigt hat:

- **Zeitraum:** letzte 7, 30 oder 90 Tage, dieses Jahr oder frei wählbar; optional ein Projekt.
- **Kennzahlen:** erstellt, erledigt, aktuell offen.
- **Diagramme:**
  - „Erledigt pro Bearbeiter“
  - „Erstellt und erledigt“ je Tag, ab 93 Tagen je Woche; beim Überfahren mit der Maus erscheinen die Werte
- **Tabelle je Bearbeiter**, nach jeder Spalte sortierbar und als CSV herunterladbar:
  - **Erledigt:** von der Person auf „Erledigt“ gesetzt (laut Verlauf)
  - **Offen zugewiesen:** aktueller Stand
  - **Bearbeitet:** Tickets mit eigener Änderung oder eigenem Kommentar
  - **Antworten und interne Notizen**
  - **Ø Lösungsdauer:** von „erstellt“ bis „erledigt“
- **Nach Komponente** (sobald Komponenten genutzt werden): im Zeitraum erstellte Tickets, davon offen, und Ø Lösungsdauer; ein Klick öffnet die gefilterte Liste
- **ITIL-Kennzahlen** für denselben Zeitraum:
  - **Servicequalität:** erledigte Anfragen und Störungen, beim ersten Kontakt gelöst (höchstens eine Antwort der IT, keine Rückfrage, nie wieder geöffnet), Quote der Wiedereröffnungen, Major Incidents. Eigene Tickets der IT zählen nicht.
  - **SLA-Einhaltung** für Reaktion und Lösung, gesamt und je Priorität (wenn SLAs eingeschaltet sind)
  - **Changes je Monat:** Arten, abgelehnte, Ergebnisse, Erfolgsquote und Anteil der Notfall-Changes
  - **Probleme:** neu, gelöst, offen, bekannte Fehler
  - **Zufriedenheit** (wenn die Umfrage eingeschaltet ist)

## Tastenkürzel

`?` zeigt alle Kürzel in der Oberfläche. Sie greifen nie, während man in ein Feld schreibt.

| Wo | Taste | Wirkung |
|---|---|---|
| überall | `c` | Ticket erstellen |
| | `/` | Suchen |
| | `g` dann `b` / `i` / `m` | Board / alle Tickets / Meine Arbeit |
| Ticket | `i` | mir zuweisen |
| | `a` | Bearbeiter wählen |
| | `m` | kommentieren |
| | `e` | Titel bearbeiten |
| | `l` | Stichwörter bearbeiten |
| | `.` | Aktionen mit Suche (Status, Priorität, Typ, Vorlage …) |
| | `Strg` + `Enter` | Kommentar speichern |
| Listen | `j` / `k` | nächstes / voriges Ticket |
| | `o` / `Enter` | markiertes Ticket öffnen |
| | `x` | markiertes Ticket auswählen (Mehrfachauswahl) |

`Enter` auf einem Link oder Knopf, der den Fokus hat, löst diesen aus. Die mit `j`/`k` markierte Zeile öffnet `Enter` nur, wenn der Fokus nicht auf einem Bedienelement liegt.

## Import aus einem anderen Ticketsystem

*Administration → Import*

Helfi.Space übernimmt Tickets mit Kommentaren und Anhängen aus

- **Zammad** (REST-API, Zugriffstoken),
- **Znuny / OTRS** (Webservice über das Generic Interface),
- **GLPI** (REST-API `apirest.php`, GLPI 9.5 bis 11),
- **Zendesk** (E-Mail und API-Token),
- **Freshdesk** (API-Schlüssel),
- **Jira** (Cloud über REST-API v3, Server/Data Center über v2), auch Service-Management-Projekte,
- einer **CSV-Datei** – Export aus jedem anderen System (z. B. osTicket, ServiceNow, Excel-Listen).

Die Zugangsdaten werden nicht gespeichert, sie gelten nur für den laufenden Import. Eine CSV-Datei bleibt höchstens zwei Stunden im Arbeitsspeicher.

1. **Quelle wählen und verbinden:**
   - **Zammad:** Adresse und Zugriffstoken (in Zammad unter *Profil → Token-Zugriff*, Berechtigung `ticket.agent`), alternativ Benutzer und Kennwort. Das Konto braucht Lesezugriff auf die Gruppen.
   - **Znuny / OTRS:** Einmalig in Znuny unter *Admin → Webservices → Webservice hinzufügen* das mitgelieferte Beispiel `GenericTicketConnectorREST` importieren. In Helfi.Space die volle Adresse des Webservice eintragen, z. B. `https://tickets.firma.local/otrs/nph-genericinterface.pl/Webservice/GenericTicketConnectorREST` (Znuny 7: `/znuny/` statt `/otrs/`), dazu Anmeldename und Kennwort eines Bearbeiters mit Leserechten auf die Queues. Neuere (`POST /Ticket/Search`) und ältere Webservices (`GET /Ticket`) gehen beide.
   - **GLPI:** In GLPI unter *Einrichtung → Allgemein → API* die REST-API aktivieren. Adresse bis einschließlich `apirest.php` (z. B. `https://glpi.firma.local/apirest.php`) und das persönliche Token des Kontos (*Einstellungen → Fernzugriffsschlüssel*), alternativ Benutzer und Kennwort; ein Anwendungs-Token nur, wenn in GLPI ein API-Client damit eingerichtet ist. Einheiten (Entities) werden zu Projekten; Folgeeinträge und Aufgaben werden Kommentare (private bleiben intern), Lösungen öffentliche Kommentare, die Kategorie ein Stichwort. Gelöschte Tickets (Papierkorb) bleiben weg.
   - **Zendesk:** Adresse (`https://example.zendesk.com`), E-Mail und API-Token (*Admin Center → Apps und Integrationen → APIs → Zendesk API*). Mit einem Administrator-Konto kommen über den inkrementellen Export auch archivierte Tickets mit, sonst nur die normale Ticketliste. Gruppen werden zu Projekten, Tags zu Stichwörtern; private Kommentare bleiben intern.
   - **Freshdesk:** Adresse (`https://example.freshdesk.com`) und API-Schlüssel aus dem Profil. Gruppen werden zu Projekten, private Notizen bleiben intern. Freshdesk liefert über seine Liste höchstens 30.000 Tickets; bei mehr bitte einen CSV-Export ergänzen. Eigene Status (ab Nummer 6) erscheinen als „Status 6“ … und werden in der Zuordnung von Hand verteilt.
   - **Jira:** Cloud mit Adresse, E-Mail und API-Token; Server/Data Center mit Adresse und Personal Access Token, alternativ Benutzername und Kennwort.
   - **CSV-Datei:** hochladen (Trennzeichen `;`, `,` oder Tab, UTF-8 oder Excel-Kodierung, höchstens 50 MB) und die Spalten zuordnen. Erkannte Spalten (z. B. „Betreff“, „Status“, „E-Mail“, „Erstellt am“) sind schon eingetragen, Pflicht ist nur der Titel. Eine Spalte *Projekt / Queue* verteilt die Tickets auf mehrere Projekte. Datumsangaben wie `02.01.2026 09:05` oder `2026-01-02 09:05` werden erkannt.
   - Bei einem internen Zertifikat die eigene Zertifizierungsstelle (PEM) eintragen.
2. **Projekte wählen** (Gruppen in Zammad, Zendesk und Freshdesk, Queues in Znuny, Einheiten in GLPI, Projekte bzw. Werte der Projektspalte) und festlegen, in welches Helfi.Space-Projekt sie kommen. Gibt es das Projekt nicht, wird es angelegt.
3. **Zuordnen:** Status und Typen des Quellsystems auf die vier Status und Typen von Helfi.Space verteilen. Vorschläge sind schon eingetragen, z. B. „pending reminder“ / „Waiting for customer“ → Wartet, „closed successful“ → Erledigt, „Incident“ / „Bug“ → Störung.
4. **Importieren:** Der Fortschritt wird angezeigt. Der Import lässt sich abbrechen.

Was übernommen wird:

- Titel, Beschreibung (als Text, HTML-Mails werden umgewandelt), Typ, Status, Priorität, Stichwörter (Zammad-Tags), Fälligkeit, Erstell- und Erledigt-Datum
- **Kommentare:** In Zammad, Znuny und Zendesk ist der erste für den Kunden sichtbare Artikel bzw. Kommentar die Beschreibung, alle weiteren werden Kommentare. Interne Notizen (Zammad „intern“, Znuny „nicht für den Kunden sichtbar“, interne Kommentare aus Service-Desk-Projekten und Kommentare mit eingeschränkter Sichtbarkeit) bleiben intern. Aus CSV: eine Spalte *Kommentare* wird eine interne Notiz.
- **Anhänge** bis zur gewählten Größe. Dateien einer internen Notiz hängen an dieser Notiz und bleiben intern. Kleine eingebettete Bilder (Logos in Signaturen) und der HTML-Teil von Mails werden übersprungen.

So werden Nummern und Personen behandelt:

- **Nummern:** `SUP-123` bleibt `SUP-123`, Zammad `#31011` wird z. B. `SD-31011`. Sehr lange Nummern (datumsbasiert, z. B. `2025030110000071` aus Znuny) und schon vergebene Nummern bekommen die nächste freie; ebenso Nummern, die einem inzwischen verschobenen Ticket gehörten. Die alte Nummer steht im Verlauf („importiert“). Neue Tickets schließen an die höchste Nummer an.
- **Personen** werden über die E-Mail-Adresse zugeordnet. Melder ohne Konto werden zu E-Mail-Kontakten, und meldet sich die Person später per AD oder SSO an, gehören ihr die Tickets. Bearbeiter werden nur zugewiesen, wenn sie in Helfi.Space schon Bearbeiter sind (über E-Mail, Anmeldename oder eindeutigen Namen), sonst steht ihr Name im Verlauf. Cloud-Systeme geben E-Mail-Adressen je nach Datenschutzeinstellung nicht heraus, dann wird nur der Name übernommen.

Außerdem gilt:

- Es werden **keine E-Mails** verschickt.
- **Schutz vor Missbrauch (SSRF):** Der Import verbindet sich nie mit lokalen Adressen (`127.x`, `::1`), Link-Local-Adressen (`169.254.x.x`, z. B. Metadaten-Dienste von Cloud-Servern) oder Multicast – auch nicht über einen Namen oder eine Weiterleitung, die dorthin zeigt. Systeme im eigenen Netz (`10.x`, `172.16–31.x`, `192.168.x`) sind erreichbar. Läuft das Quellsystem wirklich auf demselben Rechner und ist nur über `127.0.0.1` erreichbar, hebt `HELFI_IMPORT_ALLOW_LOCAL=1` in der `.env` die Sperre auf.
- Vor jedem Start eines Imports legt Helfi.Space eine Sicherung an (`helfi-vor-import-….sqlite`).
- **Wiederholbar:** Ein zweiter Lauf aktualisiert Tickets, die sich im Quellsystem seitdem geändert haben (dann gilt der Stand von dort; die geänderten Felder stehen im Verlauf). Unveränderte bleiben, wie sie in Helfi.Space bearbeitet wurden. Neue Kommentare und Anhänge werden ergänzt, doppelt wird nichts angelegt. So lässt sich vor der Umstellung einmal probehalber und am Stichtag noch einmal importieren. Bei CSV-Dateien dafür denselben *Namen der Quelle* verwenden; ohne Nummern-Spalte wird eine Zeile an Titel, Erstelldatum und Melder wiedererkannt.

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

`update.sh` merkt sich die laufende Version und holt die neue. Ist die mitgelieferte `docker-compose.yml` neuer, ersetzt es die alte und behält sie als `docker-compose.yml.alt-<Datum>-<Uhrzeit>`. Danach startet es den Container und wartet auf den Gesundheitscheck. Startet die neue Version nicht, fragt es nach und startet die vorherige Version mit der passenden Datenbanksicherung wieder (mit `-y` automatisch). Es entpackt nichts und baut nichts. Es läuft mit `/bin/sh`, auch auf einer Synology. Die Meldungen erscheinen auf Deutsch, wenn die Spracheinstellung deutsch ist (z. B. `LANG=de_DE.UTF-8`), sonst auf Englisch.

- **`docker compose up` schlägt fehl** (z. B. ungültige `docker-compose.yml`): `update.sh` meldet einen Fehler, stellt `.env` und `docker-compose.yml` wieder her und endet mit Exit-Code 1. Gibt es eine vorherige Version, fragt es vorher, ob sie wieder gestartet werden soll (mit `-y` automatisch).
- **Startet noch:** Ist die neue Version nach `HELFI_UPDATE_WAIT` noch „starting“ (z. B. Datenbank-Umstellung bei großen Datenbanken), fragt `update.sh`, ob es noch einmal warten soll (mit `-y` automatisch einmal).
- **Rückweg:** Danach steht in der `.env` wieder die vorherige Version. Spielt `update.sh` die Datenbank nicht zurück, sagt es das ausdrücklich, z. B. wenn die Sicherungen für diesen Benutzer nicht lesbar sind (dann `sudo ./update.sh -y`) oder wenn es keine bzw. nur eine unvollständige Sicherung gibt (dann wurde die Datenbank noch nicht umgestellt).

### Aufräumen

Mit der Zeit sammeln sich im Ordner ältere Sicherheitskopien der `docker-compose.yml` und geladene Image-Dateien aus dem Release. `./update.sh --cleanup` zeigt diese Dateien an und löscht sie erst nach Rückfrage (mit `-y` ohne). Die neueste `docker-compose.yml.alt-…` bleibt.

Gelöscht wird nur, was auf dieser festen Liste steht:

- ältere `docker-compose.yml.alt-…`
- `helfi-<Version>[-amd64|-arm64].tar[.gz]`
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
   Ist die Sicherung schon gepackt (`….sqlite.gz`, nach einem Tag), statt `cp` entpacken: `gunzip -c data/backups/helfi-vor-1.2.0-<Datum>.sqlite.gz > data/helfi.sqlite`

### Ohne Internet

Jedes Release enthält die Image-Datei (`helfi-<Version>-amd64.tar.gz` bzw. `-arm64`). Auf den Server kopieren und:

```sh
./update.sh --offline helfi-1.2.0-amd64.tar.gz 1.2.0
```

Ein relativer Pfad zur Image-Datei gilt ab dem aktuellen Ordner. Ohne Versionsangabe übernimmt `update.sh` die Version aus dem Image und hält sie in der `.env` fest; ist sie dort nicht erkennbar, bricht es ab, ohne etwas zu ändern.

### Herkunft prüfen (optional)

Jedes Release ist mit einem Herkunftsnachweis (Build-Provenance) signiert: Image und Image-Dateien stammen nachweislich aus dem CI-Lauf dieses Repositorys. Prüfen mit der GitHub-CLI:

```sh
gh attestation verify oci://ghcr.io/soleil0815/helfi.space.ticket:1.2.0 --owner soleil0815
gh attestation verify helfi-1.2.0-amd64.tar.gz --owner soleil0815
```

Die Image-Dateien lassen sich außerdem mit `sha256sum -c SHA256SUMS` gegen die Prüfsummen aus dem Release prüfen.

### Eigene Anpassungen an der docker-compose.yml

`update.sh` ersetzt die `docker-compose.yml` nur, wenn sie unverändert ist. Hast du sie angepasst (z. B. einen anderen Datenpfad), bleibt sie, wie sie ist. Die neue Fassung liegt dann als `docker-compose.yml.neu` daneben. Nach einem fehlgeschlagenen Update stellt `update.sh` die vorherige Version, deren Datenbanksicherung und die alte `docker-compose.yml` wieder her. Die alte Version hält es außerdem in der `.env` fest, damit Watchtower oder Dockhand die defekte nicht gleich wieder holen.

Weitere Variablen für `update.sh`: `HELFI_UPDATE_WAIT` (Wartezeit auf den Start, Standard 120 Sekunden) und `HELFI_IMAGE_REPO` (eigene Registry). Sie werden beim Aufruf gesetzt, nicht in der `.env`, z. B. `HELFI_UPDATE_WAIT=300 ./update.sh`. Für eine eigene Registry muss auch `image:` in der `docker-compose.yml` angepasst werden; die Datei gilt dann als angepasst und wird nicht mehr automatisch ersetzt.

### Hinweis „docker-compose.yml ist veraltet“

Die Datei hat eine Versionsnummer (`HELFI_COMPOSE_VERSION`). Braucht eine neue Programmversion eine neuere Datei, zeigt Helfi.Space Admins einen Hinweis. `./update.sh` übernimmt die neue Datei automatisch, alternativ lädst du sie aus dem Release.

---

## Sicherung

- Automatisch: täglich, vor jedem Versionswechsel, vor dem Löschen eines Projekts und vor jedem Import-Start, in `data/backups/`. Wird das Löschen eines Projekts abgelehnt (z. B. letztes Projekt), entsteht keine Sicherung.
- **Gepackt:** Sicherungen liegen als `helfi-….sqlite.gz` im Ordner, typischerweise nur noch ein Drittel bis ein Zehntel so groß. Jede gepackte Datei wird vor dem Umbenennen entpackt und mit dem Original verglichen. Ausnahme: Die Sicherung vor einem Versionswechsel (`helfi-vor-<Version>-….sqlite`) bleibt einen Tag ungepackt, weil `./update.sh` genau diese Datei zurückspielt, falls die neue Version nicht startet; danach wird sie bei der täglichen Sicherung gepackt. Ungepackte Sicherungen älterer Versionen packt Helfi.Space nach dem Start einmalig im Hintergrund, das Original verschwindet erst, wenn die gepackte Datei geprüft ist.
- Zurückspielen von Hand: `gunzip -c data/backups/helfi-….sqlite.gz > data/helfi.sqlite` (bei gestopptem Container, vorher `helfi.sqlite-wal`/`-shm` entfernen). `gzip` ist auf jedem Linux vorhanden.
- Jede Sicherung entsteht zuerst als `….part` und wird erst fertig umbenannt. Eine nach einem Absturz liegengebliebene `.part`-Datei wird nie verwendet und nach einer Stunde beim nächsten Aufräumen entfernt.
- Von Hand: *Administration → System → Jetzt sichern*. Dort stehen auch alle Sicherungen mit Art, Datum, Größe und dem belegten Platz insgesamt; einzelne lassen sich löschen.
- **Herunterladen:** Jede Sicherung lässt sich dort mit ⤓ als ZIP-Datei herunterladen, *Sichern und herunterladen* macht beides in einem Schritt. Die ZIP enthält die Datenbank (`helfi.sqlite`, gepackt deutlich kleiner) und eine `INFO.txt` mit der Anleitung zum Wiederherstellen. Die Anmeldesitzungen sind darin entfernt (sonst ließe sich mit der Datei jede angemeldete Sitzung übernehmen) – nach dem Zurückspielen melden sich alle neu an; für die Dauer des Downloads liegt kurz eine bereinigte Kopie im Sicherungsordner. Anhänge und `secret.key` sind mit Absicht nicht dabei: Mit dem Schlüssel ließen sich die gespeicherten Kennwörter entschlüsseln. Auf derselben Installation reicht die ZIP zum Zurückspielen; für eine neue Installation braucht es zusätzlich `secret.key` vom Docker-Host. Nur für Admins, jeder Download steht im Protokoll.
- **Mitsichern:** den ganzen Ordner `data/`, einschließlich `secret.key`. Ohne diese Datei lassen sich gespeicherte Kennwörter (Dienstkonto, Postfach, SSO) und 2FA-Schlüssel nicht mehr entschlüsseln. Helfi.Space startet dann nicht und meldet das im Protokoll. Alternativ `HELFI_SECRET` (mindestens 16 Zeichen) in der `.env` setzen, aber gleich bei der Einrichtung: Ein späterer Wechsel zwischen `secret.key` und `HELFI_SECRET` macht gespeicherte Daten unlesbar.
- Die Sicherungen in `data/backups/` enthalten nur die Datenbank. Anhänge (`data/attachments/`) und `secret.key` liegen daneben. Deshalb immer den ganzen Ordner `data/` auf ein anderes Laufwerk sichern.
- **Aufbewahrung:** *Administration → System → Sicherungen aufbewahren* (Standard 10, 1–100). Die Zahl gilt je Art: täglich, von Hand, vor Versionswechsel, vor Projekt-Löschen und vor Import. Ältere werden gelöscht, mindestens die neueste jeder Art bleibt immer. Aufgeräumt wird beim Speichern, beim Start und nach jeder Sicherung. `HELFI_BACKUP_KEEP_DAYS` gilt nicht mehr.

## Sicherheit

- Zwei-Faktor-Anmeldung nach RFC 6238. Jeder Code gilt nur einmal, nach 5 Fehlversuchen beginnt die Anmeldung von vorn. Der Schlüssel ist verschlüsselt gespeichert, die Wiederherstellungscodes nur als scrypt-Hash mit eigenem Salz je Code.
- Kennwörter lokaler Konten werden mit scrypt gespeichert. Hinterlegte Zugangsdaten (Dienstkonto, Postfach, SSO) sind mit AES-256-GCM verschlüsselt und werden nie an den Browser geschickt.
- Die Ersteinrichtung ist nur mit dem Einrichtungscode aus dem Container-Protokoll möglich.
- Nach mehreren falschen Kennwörtern wird die Anmeldung gebremst. Die Sitzungscookies sind `HttpOnly` und `SameSite`, außerdem gibt es CSRF-Schutz und eine strenge Content-Security-Policy.
- Leere Kennwörter werden nie ans AD weitergegeben, denn ein anonymer Bind würde sonst als Anmeldung durchgehen. Eingaben in LDAP-Filtern werden maskiert.
- Der Container läuft ohne root-Rechte (`PUID`/`PGID`, 0 ist nicht erlaubt), mit schreibgeschütztem Programmteil, ohne zusätzliche Linux-Rechte und mit `no-new-privileges` (siehe `docker-compose.yml`). Dateien in `data/` sind nur für diesen Benutzer lesbar.
- Anhänge werden zum Herunterladen ausgeliefert (nur Bilder werden direkt angezeigt), damit hochgeladene Dateien nie im Kontext von Helfi.Space ausgeführt werden.
- Gespeicherte Kennwörter bleiben an ihre Verbindung gebunden: Wer bei AD, IMAP, SMTP oder SSO Server, Port, Verschlüsselung, Dienstkonto bzw. Benutzer, Issuer oder Client-ID ändert, die Zertifikatsprüfung abschwächt (auch „Abgerufenes Zertifikat“ → „System-Zertifizierungsstellen“) oder ein anderes AD-Zertifikat hinterlegt, muss das Kennwort bzw. Geheimnis im selben Schritt neu eingeben, sonst wird nicht gespeichert. So geht ein gespeichertes Geheimnis nie an einen anderen Server. Verbindungstests mit geändertem Server oder abgeschwächter Prüfung senden das gespeicherte Kennwort ebenfalls nicht.
- Deaktivierte Konten bekommen bei der Anmeldung dieselbe Meldung wie bei einem falschen Kennwort.
- Das Image enthält nur, was läuft: keine Paketwerkzeuge von Node (npm, yarn, corepack), vom Datenbanktreiber nur die Datei für die eigene Plattform. Jedes Release wird vor der Freigabe mit Trivy geprüft; zusätzlich prüft die CI jeden Montag das veröffentlichte Image und legt ein Issue an, sobald behebbare Lücken (hoch/kritisch) auftauchen – dann hilft ein neues Release.
- **Sicherheitslücke gefunden?** Bitte nicht als öffentliches Issue, sondern vertraulich melden – siehe [SECURITY.md](SECURITY.md).

## Entwicklung

```sh
npm install
npm run dev                  # http://localhost:8080, Daten in ./data
npm test                     # Einzel-, API- und update.sh-Tests
sudo scripts/test-samba-ad.sh && HELFI_TEST_LDAP_HOST=dc01.firma.local npm run test:integration
```

Handbuch neu bauen (nach Änderungen an `docs/manual/`): `npm install --no-save playwright && npx playwright install chromium && node scripts/build-manual.mjs`.

Aufbau: `src/` Server (Express, better-sqlite3), `public/` Oberfläche (reines JavaScript ohne Build-Schritt), `src/i18n.js` und `public/js/i18n.js` für die Texte (de/en).

Neuigkeiten: `src/news.json`, je Version Punkte für `all`, `agent` oder `admin` (de/en). Neue Punkte kommen in einen Eintrag mit `"version": ""` (oben anlegen, falls es keinen gibt) – eine Nummer wird nie von Hand eingetragen: Beim Release ordnet `scripts/news-versions.mjs` jeden Punkt anhand der Release-Tags der Version zu, mit der er zum ersten Mal ausgeliefert wurde; Neues bekommt die gerade gebaute Version. Nach einem Release ist also kein Nacharbeiten nötig. Benutzer sehen die Punkte nach dem Update einmal, alle Versionen stehen unter *Neuigkeiten*.

Releases: *Actions → CI → Run workflow*, Branch `main`, bei „Release“ `patch`, `minor` oder `major` wählen. Die Version zählt sich selbst hoch (höchster Tag + 1), `package.json` muss nicht angepasst werden. Die CI testet, baut die Images für amd64 und arm64 nativ, prüft auf Schwachstellen und legt erst danach Tag, Images und GitHub-Release an. Der Tag wird vor den Image-Tags gesetzt und reserviert damit die Nummer: Scheitert danach ein Schritt, nimmt *Re-run failed jobs* dieselbe Nummer wieder auf (nur solange es dazu noch kein GitHub-Release gibt); ein neuer Release-Lauf zählt dagegen weiter, die reservierte Nummer bleibt dann übersprungen. Ein veröffentlichter Image-Tag wird nie mit einem anderen Image überschrieben. Das ist der einzige Weg zu einem Release: Ein von Hand gepushter Tag startet nichts. Es läuft immer nur ein Release gleichzeitig; freigegeben wird genau das geprüfte Image (gleicher Digest). Das Basis-Image ist per Digest festgelegt; neue Digests schlägt Dependabot wöchentlich vor.

CI sparsam: Pull Requests laufen immer durch die Tests; der AD-Integrationstest nur, wenn sich Anmeldung/AD, Abhängigkeiten oder die Workflows geändert haben, Image-Bau und Schwachstellen-Scan nur, wenn nicht ausschließlich Doku geändert wurde (`.github/scripts/changes.sh`). Ein neuer Push auf denselben PR bricht den alten Lauf ab. Nach dem Merge auf `main` wird nur das Image gebaut (hält den Build-Cache warm) – ein Release führt ohnehin alle Prüfungen erneut aus. Jeder Job hat ein Zeitlimit; Dependabot fasst kleinere Updates zu einem PR pro Woche zusammen.

## Lizenz

Copyright (C) 2026 soleil0815

Helfi.Space steht unter der **GNU Affero General Public License v3.0 oder später** (AGPL-3.0-or-later) – siehe [LICENSE](LICENSE).

Kurz gesagt (verbindlich ist nur der Lizenztext):

- Du darfst Helfi.Space kostenlos nutzen, auch im Unternehmen, und es anpassen.
- Wer Helfi.Space **verändert und anderen zur Verfügung stellt** – als Download oder **auch nur als Dienst über das Netz** (z. B. gehostet für Kunden) –, muss den vollständigen Quellcode seiner Fassung unter derselben Lizenz offenlegen. Eine geschlossene, kostenpflichtige Variante darf daraus nicht entstehen.
- Jede laufende Instanz zeigt deshalb einen Link **Quellcode** (Seitenleiste, Anmeldeseite, Handy unter *Ich*). Wer eine veränderte Fassung betreibt, setzt `HELFI_SOURCE_URL` in der `.env` auf den eigenen Quellcode.
- Hinweise auf den Urheber und die Lizenz dürfen nicht entfernt werden.

Versionen bis einschließlich 1.29.2 wurden unter der MIT-Lizenz veröffentlicht; für sie gilt diese weiter.

