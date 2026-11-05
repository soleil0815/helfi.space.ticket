# Security / Sicherheit

*Deutsch weiter unten.*

## Reporting a vulnerability

Please **do not** report security problems as a public issue or pull request.

Report them confidentially via GitHub: **[Report a vulnerability](https://github.com/soleil0815/helfi.space.ticket/security/advisories/new)** (tab *Security → Advisories*). Only the maintainer sees the report.

Helpful details:

- affected version (shown at the bottom of the sidebar)
- what an attacker can do and under which conditions (signed in? which role? from outside?)
- steps to reproduce, ideally a minimal example
- please remove real data (addresses, names, passwords, domains) from logs and screenshots

You will get an answer within a few days. Fixes are released as a new version; the release notes and the in-app news mention security fixes. Please give us time to publish a fix before disclosing details.

## Supported versions

Only the **latest release** receives fixes. Updating is quick: `./update.sh` or your container manager (see README).

## Verifying releases

Images and offline image files carry signed build provenance; see *Updates → Verify the origin* in the README.

---

## Sicherheitslücke melden

Bitte Sicherheitsprobleme **nicht** als öffentliches Issue oder Pull Request melden.

Vertraulich melden über GitHub: **[Sicherheitslücke melden](https://github.com/soleil0815/helfi.space.ticket/security/advisories/new)** (Reiter *Security → Advisories*). Die Meldung sieht nur der Betreuer des Projekts.

Hilfreich sind:

- betroffene Version (steht unten in der Seitenleiste)
- was ein Angreifer tun kann und unter welchen Bedingungen (angemeldet? welche Rolle? von außen?)
- Schritte zum Nachstellen, am besten ein kleines Beispiel
- echte Daten (Adressen, Namen, Kennwörter, Domains) bitte aus Protokollen und Screenshots entfernen

Du bekommst innerhalb weniger Tage eine Antwort. Korrekturen erscheinen als neue Version; Release-Notizen und die Neuigkeiten im Programm nennen Sicherheitskorrekturen. Bitte gib uns Zeit für eine Korrektur, bevor du Details veröffentlichst.

## Unterstützte Versionen

Korrekturen gibt es nur für das **neueste Release**. Das Update geht schnell: `./update.sh` oder die Container-Verwaltung (siehe README).

## Releases prüfen

Images und Image-Dateien tragen einen signierten Herkunftsnachweis; siehe *Updates → Herkunft prüfen* in der README.
