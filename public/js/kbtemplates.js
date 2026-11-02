// Mitgelieferte Vorlagen für Wissensartikel (je Sprache). Eigene Vorlagen liegen in der Datenbank.
import { getLang } from './i18n.js';

const DE = [
  {
    id: 'howto', emoji: '📘', title: 'Anleitung', description: 'Schritt für Schritt erklären, wie etwas geht',
    body: `:::info
**Für wen?** Wer braucht diese Anleitung, und was ist danach erledigt?
:::

## Voraussetzungen

- [ ] Was muss vorher da sein (Konto, Rechte, Programm …)?

## Schritte

1. Erster Schritt
2. Zweiter Schritt
3. Dritter Schritt

## Ergebnis prüfen

So erkennst du, dass alles geklappt hat.

## Hilfe

Klappt etwas nicht? Melde ein Problem und nenne den Schritt, an dem es hakt.`,
  },
  {
    id: 'faq', emoji: '🛠️', title: 'Störung beheben (FAQ)', description: 'Fehlerbild, Ursache und Lösung',
    body: `## Fehlerbild

Was sieht man? Fehlermeldung wörtlich zitieren.

## Ursache

Warum passiert das?

## Lösung

1. Erster Schritt
2. Zweiter Schritt

:::tip
**Schnelle Abhilfe:** Was hilft sofort, bis es dauerhaft gelöst ist?
:::

## Wenn das nicht hilft

Problem melden und dabei Rechnername (z. B. PC-0001) und Uhrzeit angeben.`,
  },
  {
    id: 'checklist', emoji: '✅', title: 'Checkliste', description: 'Wiederkehrende Abläufe zum Abhaken',
    body: `Wofür ist diese Checkliste, und wer arbeitet sie ab?

## Vorbereitung

- [ ] Punkt 1
- [ ] Punkt 2

## Durchführung

- [ ] Punkt 1
- [ ] Punkt 2

## Abschluss

- [ ] Ergebnis dokumentiert
- [ ] Beteiligte informiert`,
  },
  {
    id: 'knownerror', emoji: '⚠️', title: 'Bekannter Fehler', description: 'Bekanntes Problem mit Workaround',
    body: `:::warning
**Bekannter Fehler** – wir arbeiten an einer dauerhaften Lösung.
:::

| Betrifft | Seit | Status |
| --- | --- | --- |
| Dienst oder Gerät | Datum | in Arbeit |

## Was passiert?

Beschreibung des Fehlers.

## Workaround

1. Erster Schritt
2. Zweiter Schritt

## Stand

Letzte Neuigkeiten mit Datum.`,
  },
];

const EN = [
  {
    id: 'howto', emoji: '📘', title: 'How-to', description: 'Explain step by step how something works',
    body: `:::info
**Who is this for?** Who needs this guide, and what is done afterwards?
:::

## Prerequisites

- [ ] What has to be in place first (account, permissions, program …)?

## Steps

1. First step
2. Second step
3. Third step

## Check the result

How to tell that everything worked.

## Help

Something not working? Report a problem and name the step where it fails.`,
  },
  {
    id: 'faq', emoji: '🛠️', title: 'Troubleshooting (FAQ)', description: 'Symptom, cause and solution',
    body: `## Symptom

What do you see? Quote the error message word for word.

## Cause

Why does it happen?

## Solution

1. First step
2. Second step

:::tip
**Quick fix:** what helps right away until it is solved for good?
:::

## If this does not help

Report a problem and state the computer name (e.g. PC-0001) and the time.`,
  },
  {
    id: 'checklist', emoji: '✅', title: 'Checklist', description: 'Recurring procedures to tick off',
    body: `What is this checklist for, and who works through it?

## Preparation

- [ ] Item 1
- [ ] Item 2

## Execution

- [ ] Item 1
- [ ] Item 2

## Wrap-up

- [ ] Result documented
- [ ] People involved informed`,
  },
  {
    id: 'knownerror', emoji: '⚠️', title: 'Known error', description: 'Known problem with workaround',
    body: `:::warning
**Known error** – we are working on a permanent fix.
:::

| Affects | Since | Status |
| --- | --- | --- |
| Service or device | Date | in progress |

## What happens?

Description of the error.

## Workaround

1. First step
2. Second step

## Status

Latest news with date.`,
  },
];

export const builtinTemplates = () => (getLang() === 'en' ? EN : DE);
