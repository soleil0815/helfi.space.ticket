// Ready-made examples to take over (like the example components): shared canned responses,
// service catalog offerings and knowledge articles, each in German and English. Taken over in
// the language the admin chooses; whatever already exists under either title is skipped.
// Neutral placeholders only (firma.example, [in brackets]) – they are meant to be adapted.
import { HttpError, forbidden, str } from './lib/http.js';
import { isAgent } from './auth/session.js';

// ---------- Canned responses (shared, for all agents) ----------
// Placeholders: {melder}/{reporter}, {ticket}, {titel}/{title}, {bearbeiter}/{agent}
export const CANNED_EXAMPLES = [
  {
    key: 'received',
    de: { title: 'Eingang bestätigen', body: 'Hallo {melder},\n\nvielen Dank für Ihre Meldung – wir haben sie als {ticket} aufgenommen und kümmern uns darum. Sie hören von uns, sobald es Neuigkeiten gibt.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Confirm receipt', body: 'Hello {reporter},\n\nthank you for your report – we have recorded it as {ticket} and are taking care of it. You will hear from us as soon as there is news.\n\nKind regards\n{agent}' },
  },
  {
    key: 'moreInfo',
    de: { title: 'Weitere Angaben nötig', body: 'Hallo {melder},\n\ndamit wir weiterhelfen können, brauchen wir noch ein paar Angaben:\n\n- Seit wann tritt das Problem auf?\n- Welche Fehlermeldung erscheint genau? (Ein Bildschirmfoto hilft sehr.)\n- An welchem Gerät bzw. in welchem Raum?\n\nAntworten Sie einfach auf diese Nachricht.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'More details needed', body: 'Hello {reporter},\n\nto help you further we need a few more details:\n\n- Since when does the problem occur?\n- What exactly does the error message say? (A screenshot helps a lot.)\n- On which device or in which room?\n\nJust reply to this message.\n\nKind regards\n{agent}' },
  },
  {
    key: 'restart',
    de: { title: 'Bitte neu starten', body: 'Hallo {melder},\n\nbitte starten Sie den Rechner einmal komplett neu (**Start → Ein/Aus → Neu starten**, nicht nur abmelden) und probieren Sie es danach noch einmal. Klappt es dann immer noch nicht, geben Sie uns kurz Bescheid.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Please restart', body: 'Hello {reporter},\n\nplease restart the computer completely once (**Start → Power → Restart**, not just sign out) and try again afterwards. If it still does not work, just let us know.\n\nKind regards\n{agent}' },
  },
  {
    key: 'passwordReset',
    de: { title: 'Kennwort zurückgesetzt', body: 'Hallo {melder},\n\nIhr Kennwort ist zurückgesetzt. Das vorläufige Kennwort bekommen Sie **auf einem anderen Weg** (persönlich oder telefonisch) – nie per Mail. Bei der nächsten Anmeldung werden Sie aufgefordert, ein eigenes zu vergeben.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Password reset', body: 'Hello {reporter},\n\nyour password has been reset. You will get the temporary password **through another channel** (in person or by phone) – never by email. At your next sign-in you will be asked to choose your own.\n\nKind regards\n{agent}' },
  },
  {
    key: 'remote',
    de: { title: 'Fernwartung vereinbaren', body: 'Hallo {melder},\n\nam schnellsten lässt sich das per Fernwartung lösen. Wann passt es Ihnen? Schlagen Sie einfach zwei, drei Zeiten vor – ich melde mich dann und schaue mir das gemeinsam mit Ihnen an.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Arrange remote session', body: 'Hello {reporter},\n\nthe quickest way to solve this is a remote session. When suits you? Just suggest two or three times – I will get in touch and look at it together with you.\n\nKind regards\n{agent}' },
  },
  {
    key: 'external',
    de: { title: 'Wartet auf Hersteller', body: 'Hallo {melder},\n\nwir haben den Fall an den Hersteller bzw. Dienstleister weitergegeben und warten auf dessen Rückmeldung. Sobald wir etwas hören, melden wir uns bei Ihnen.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Waiting for vendor', body: 'Hello {reporter},\n\nwe have passed the case on to the vendor or service provider and are waiting for their reply. As soon as we hear back, we will get in touch.\n\nKind regards\n{agent}' },
  },
  {
    key: 'ordered',
    de: { title: 'Hardware bestellt', body: 'Hallo {melder},\n\ndas Gerät ist bestellt. Sobald es da und eingerichtet ist, melden wir uns, um die Übergabe abzustimmen.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Hardware ordered', body: 'Hello {reporter},\n\nthe device has been ordered. As soon as it has arrived and is set up, we will get in touch to arrange the handover.\n\nKind regards\n{agent}' },
  },
  {
    key: 'known',
    de: { title: 'Bekannte Störung', body: 'Hallo {melder},\n\nvielen Dank für den Hinweis – die Störung ist bekannt und wir arbeiten bereits daran. Sie müssen nichts weiter tun; wir melden uns, sobald alles wieder läuft.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Known outage', body: 'Hello {reporter},\n\nthanks for letting us know – the outage is known and we are already working on it. There is nothing else you need to do; we will get in touch as soon as everything works again.\n\nKind regards\n{agent}' },
  },
  {
    key: 'solved',
    de: { title: 'Gelöst – bitte bestätigen', body: 'Hallo {melder},\n\ndas Problem sollte jetzt behoben sein. Probieren Sie es bitte kurz aus. Falls doch noch etwas nicht stimmt, antworten Sie einfach auf diese Nachricht – dann öffnen wir das Ticket wieder.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Solved – please confirm', body: 'Hello {reporter},\n\nthe problem should be fixed now. Please give it a quick try. If something is still not right, just reply to this message – we will reopen the ticket.\n\nKind regards\n{agent}' },
  },
  {
    key: 'noReply',
    de: { title: 'Schließen ohne Rückmeldung', body: 'Hallo {melder},\n\nwir haben länger nichts von Ihnen gehört und schließen das Ticket {ticket} deshalb. Ist das Thema noch offen, antworten Sie einfach auf diese Nachricht – dann geht es weiter.\n\nViele Grüße\n{bearbeiter}' },
    en: { title: 'Closing without reply', body: 'Hello {reporter},\n\nwe have not heard from you for a while and are therefore closing ticket {ticket}. If the issue is still open, just reply to this message and we will continue.\n\nKind regards\n{agent}' },
  },
];

// ---------- Service catalog (created inactive: check, adjust approvers, then switch on) ----------
const f = (id, de, en, type = 'text', required = false, options = null) => ({ id, de, en, type, required, options });
export const CATALOG_EXAMPLES = [
  {
    key: 'onboarding', emoji: '👋',
    de: { title: 'Neue Mitarbeiterin / neuer Mitarbeiter', description: 'Konto, Postfach und Arbeitsplatz für eine neue Person einrichten lassen – bitte mindestens eine Woche vor dem ersten Arbeitstag.' },
    en: { title: 'New employee', description: 'Have an account, mailbox and workplace set up for a new person – please at least one week before the first working day.' },
    fields: [
      f('name', 'Name', 'Name', 'text', true), f('start', 'Erster Arbeitstag', 'First working day', 'date', true),
      f('dept', 'Abteilung / Bereich', 'Department / area'),
      f('device', 'Arbeitsgerät', 'Work device', 'select', true, { de: ['Notebook', 'PC', 'Kein Gerät nötig'], en: ['Notebook', 'PC', 'No device needed'] }),
      f('phone', 'Telefon / Headset nötig', 'Phone / headset needed', 'checkbox'),
      f('notes', 'Weitere Wünsche (Software, Laufwerke, Verteiler)', 'Further wishes (software, drives, distribution lists)', 'textarea'),
    ],
  },
  {
    key: 'offboarding', emoji: '📦',
    de: { title: 'Mitarbeiterin / Mitarbeiter verlässt uns', description: 'Konto sperren, Geräte zurücknehmen und Daten übergeben, wenn jemand ausscheidet.' },
    en: { title: 'Employee leaving', description: 'Disable the account, take back devices and hand over data when someone leaves.' },
    fields: [
      f('name', 'Name', 'Name', 'text', true), f('last', 'Letzter Arbeitstag', 'Last working day', 'date', true),
      f('forward', 'Mails weiterleiten an', 'Forward mails to'),
      f('data', 'Wer übernimmt Daten und Dateien?', 'Who takes over data and files?'),
      f('notes', 'Hinweise', 'Notes', 'textarea'),
    ],
  },
  {
    key: 'software', emoji: '💿',
    de: { title: 'Software installieren', description: 'Ein Programm auf deinem Rechner installieren lassen.' },
    en: { title: 'Install software', description: 'Have a program installed on your computer.' },
    fields: [
      f('software', 'Software (Name und Version)', 'Software (name and version)', 'text', true),
      f('computer', 'Rechnername (z. B. PC-0001)', 'Computer name (e.g. PC-0001)'),
      f('licence', 'Gibt es eine Lizenz?', 'Is there a licence?', 'select', true, { de: ['Ja', 'Nein', 'Weiß ich nicht', 'Kostenlos'], en: ['Yes', 'No', 'I do not know', 'Free of charge'] }),
      f('why', 'Wofür brauchst du sie?', 'What do you need it for?', 'textarea'),
    ],
  },
  {
    key: 'access', emoji: '🔑',
    de: { title: 'Zugriff auf Laufwerk oder Ordner', description: 'Berechtigung für ein Netzlaufwerk, einen Ordner oder ein Gruppenpostfach beantragen.' },
    en: { title: 'Access to a drive or folder', description: 'Request permission for a network drive, a folder or a shared mailbox.' },
    fields: [
      f('path', 'Laufwerk, Ordner oder Postfach', 'Drive, folder or mailbox', 'text', true),
      f('level', 'Zugriff', 'Access', 'select', true, { de: ['Lesen', 'Lesen und Schreiben'], en: ['Read', 'Read and write'] }),
      f('who', 'Für wen (falls nicht für dich)?', 'For whom (if not for you)?'),
      f('why', 'Begründung', 'Reason', 'textarea'),
    ],
  },
  {
    key: 'hardware', emoji: '🖥️',
    de: { title: 'Hardware bestellen', description: 'Zubehör oder ein neues Gerät anfordern.' },
    en: { title: 'Order hardware', description: 'Request accessories or a new device.' },
    fields: [
      f('item', 'Was wird gebraucht?', 'What is needed?', 'select', true, { de: ['Monitor', 'Headset', 'Tastatur und Maus', 'Dockingstation', 'Notebook', 'Sonstiges'], en: ['Monitor', 'Headset', 'Keyboard and mouse', 'Docking station', 'Notebook', 'Other'] }),
      f('details', 'Details (Anzahl, Modell, Wunsch)', 'Details (quantity, model, preference)'),
      f('why', 'Begründung', 'Reason', 'textarea'),
    ],
  },
  {
    key: 'guestWifi', emoji: '📶',
    de: { title: 'WLAN-Zugang für Gäste', description: 'Zugangsdaten für Besucher, Referenten oder Dienstleister.' },
    en: { title: 'Wi-Fi access for guests', description: 'Access data for visitors, speakers or contractors.' },
    fields: [
      f('guest', 'Name des Gastes / der Veranstaltung', 'Name of the guest / event', 'text', true),
      f('from', 'Von', 'From', 'date', true), f('to', 'Bis', 'To', 'date', true),
      f('count', 'Anzahl Zugänge', 'Number of accounts'),
    ],
  },
  {
    key: 'distribution', emoji: '📮',
    de: { title: 'Verteiler oder Gruppenpostfach', description: 'Neuen Mailverteiler oder ein gemeinsames Postfach einrichten oder ändern.' },
    en: { title: 'Distribution list or shared mailbox', description: 'Set up or change a mail distribution list or a shared mailbox.' },
    fields: [
      f('kind', 'Art', 'Kind', 'select', true, { de: ['Verteiler', 'Gruppenpostfach'], en: ['Distribution list', 'Shared mailbox'] }),
      f('name', 'Gewünschte Adresse (z. B. team@firma.example)', 'Desired address (e.g. team@firma.example)', 'text', true),
      f('members', 'Mitglieder', 'Members', 'textarea'),
    ],
  },
];

// ---------- Knowledge articles (created internal: adapt, then make them public) ----------
export const KB_EXAMPLES = [
  {
    key: 'goodTicket',
    de: {
      title: 'So meldest du ein Problem richtig', category: 'Erste Schritte',
      body: `Je genauer die Meldung, desto schneller die Lösung. Diese Angaben helfen uns am meisten:

## Was gehört in eine gute Meldung?

1. **Kurzer, eindeutiger Titel** – z. B. „Drucker im 2. OG druckt nicht“ statt „Problem“.
2. **Was genau passiert?** Was hast du gemacht, was hast du erwartet, was ist stattdessen passiert?
3. **Fehlermeldung** – am besten als Bildschirmfoto (Windows: **Win + Umschalt + S**, Mac: **Cmd + Umschalt + 4**).
4. **Seit wann?** Und tritt es immer auf oder nur manchmal?
5. **Wo?** Rechnername (steht meist auf einem Aufkleber, z. B. PC-0001) oder Raum.

:::tip
Ein Problem pro Meldung. Zwei verschiedene Anliegen bekommen zwei Tickets – so geht nichts unter.
:::

## Wie geht es weiter?

Du bekommst eine Bestätigung mit der Ticketnummer. Unter **Meine Anfragen** siehst du jederzeit den Stand und kannst Fragen beantworten oder Dateien nachreichen. Antworten per Mail landen automatisch im Ticket.`,
    },
    en: {
      title: 'How to report a problem well', category: 'Getting started',
      body: `The more precise the report, the faster the solution. These details help us most:

## What makes a good report?

1. **Short, clear title** – e.g. “Printer on the 2nd floor does not print” instead of “Problem”.
2. **What exactly happens?** What did you do, what did you expect, what happened instead?
3. **Error message** – ideally as a screenshot (Windows: **Win + Shift + S**, Mac: **Cmd + Shift + 4**).
4. **Since when?** And does it happen always or only sometimes?
5. **Where?** Computer name (usually on a sticker, e.g. PC-0001) or room.

:::tip
One problem per report. Two different issues get two tickets – that way nothing gets lost.
:::

## What happens next?

You get a confirmation with the ticket number. Under **My requests** you can see the status at any time and answer questions or add files. Replies by email end up in the ticket automatically.`,
    },
  },
  {
    key: 'vpn',
    de: {
      title: 'VPN einrichten (Homeoffice)', category: 'Anleitungen',
      body: `Mit dem VPN erreichst du von zu Hause die internen Laufwerke und Programme.

:::info
Ersetze die Angaben in eckigen Klammern durch eure eigenen, bevor du diesen Artikel für alle freigibst.
:::

## Einmalig einrichten

1. **[Name des VPN-Programms]** aus dem Softwarecenter installieren oder hier herunterladen: [Link].
2. Programm öffnen und eine neue Verbindung anlegen.
3. Als Server **vpn.firma.example** eintragen.
4. Mit deinem **normalen Anmeldenamen und Kennwort** anmelden.
5. Falls nach einem zweiten Faktor gefragt wird: Code aus der Authenticator-App eingeben.

## Täglich verbinden

Programm starten, **Verbinden** klicken – fertig. Zum Feierabend wieder trennen.

## Klappt nicht?

- Funktioniert das Internet zu Hause (z. B. eine Webseite aufrufen)?
- Kennwort kürzlich geändert? Dann das neue verwenden.
- Weiterhin Probleme: Ticket mit Bildschirmfoto der Fehlermeldung anlegen.`,
    },
    en: {
      title: 'Setting up VPN (home office)', category: 'How-to',
      body: `With the VPN you reach the internal drives and programs from home.

:::info
Replace the details in square brackets with your own before you make this article available to everyone.
:::

## Set up once

1. Install **[name of the VPN program]** from the software center or download it here: [link].
2. Open the program and create a new connection.
3. Enter **vpn.firma.example** as server.
4. Sign in with your **normal user name and password**.
5. If you are asked for a second factor: enter the code from the authenticator app.

## Connect every day

Start the program, click **Connect** – done. Disconnect again at the end of the day.

## Does not work?

- Does the internet work at home (e.g. open a website)?
- Changed your password recently? Then use the new one.
- Still problems: create a ticket with a screenshot of the error message.`,
    },
  },
  {
    key: 'printer',
    de: {
      title: 'Drucker hinzufügen (Windows)', category: 'Anleitungen',
      body: `So fügst du einen Netzwerkdrucker hinzu.

1. **Start → Einstellungen → Bluetooth und Geräte → Drucker und Scanner** öffnen.
2. **Gerät hinzufügen** klicken und kurz warten.
3. Den Drucker mit dem Namen deines Raums oder Stockwerks wählen (z. B. **DR-2OG-01**).
4. Erscheint er nicht: **Manuell hinzufügen** → **Freigegebenen Drucker über den Namen auswählen** → \`\\\\druckserver.firma.local\\DR-2OG-01\` eintragen.
5. Testseite drucken.

:::tip
Der Druckername steht meist auf einem Aufkleber am Gerät.
:::`,
    },
    en: {
      title: 'Adding a printer (Windows)', category: 'How-to',
      body: `This is how you add a network printer.

1. Open **Start → Settings → Bluetooth & devices → Printers & scanners**.
2. Click **Add device** and wait a moment.
3. Choose the printer named after your room or floor (e.g. **DR-2OG-01**).
4. If it does not appear: **Add manually** → **Select a shared printer by name** → enter \`\\\\druckserver.firma.local\\DR-2OG-01\`.
5. Print a test page.

:::tip
The printer name is usually on a sticker on the device.
:::`,
    },
  },
  {
    key: 'password',
    de: {
      title: 'Kennwort ändern oder vergessen', category: 'Anleitungen',
      body: `## Kennwort ändern

Am Windows-Rechner **Strg + Alt + Entf** drücken und **Kennwort ändern** wählen. Altes Kennwort einmal, neues zweimal eingeben.

## Gutes Kennwort

- mindestens 12 Zeichen, am besten ein Satz („Mein Kaffee ist um 8 Uhr fertig!“)
- nicht dasselbe wie privat oder bei anderen Diensten

## Kennwort vergessen oder Konto gesperrt?

Ticket anlegen oder bei der IT anrufen. Das neue vorläufige Kennwort bekommst du **nie per Mail**, sondern persönlich oder telefonisch.

:::warning
Die IT fragt dich nie nach deinem Kennwort – weder per Mail noch am Telefon. Solche Anfragen bitte sofort melden.
:::`,
    },
    en: {
      title: 'Changing or forgetting your password', category: 'How-to',
      body: `## Change your password

On the Windows computer press **Ctrl + Alt + Del** and choose **Change a password**. Enter the old password once and the new one twice.

## A good password

- at least 12 characters, ideally a sentence (“My coffee is ready at 8 o'clock!”)
- not the same as at home or for other services

## Forgot your password or account locked?

Create a ticket or call IT. You get the temporary password **never by email**, but in person or by phone.

:::warning
IT will never ask you for your password – neither by email nor on the phone. Please report such requests immediately.
:::`,
    },
  },
  {
    key: 'outOfOffice',
    de: {
      title: 'Abwesenheitsnotiz einrichten (Outlook)', category: 'Anleitungen',
      body: `1. In Outlook **Datei → Automatische Antworten** öffnen (im neuen Outlook: **Einstellungen → Konten → Automatische Antworten**).
2. **Automatische Antworten senden** einschalten.
3. Optional **Nur in diesem Zeitraum senden** mit Anfangs- und Enddatum.
4. Text für **Innerhalb meiner Organisation** und – falls gewünscht – **Außerhalb meiner Organisation** eintragen.
5. **OK** bzw. **Speichern**.

:::tip
Nenne eine Vertretung mit Mailadresse – dann muss niemand auf deine Rückkehr warten.
:::`,
    },
    en: {
      title: 'Setting up an out-of-office reply (Outlook)', category: 'How-to',
      body: `1. In Outlook open **File → Automatic Replies** (in the new Outlook: **Settings → Accounts → Automatic replies**).
2. Turn on **Send automatic replies**.
3. Optionally **Only send during this time range** with start and end date.
4. Enter the text for **Inside my organization** and – if wanted – **Outside my organization**.
5. **OK** or **Save**.

:::tip
Name a deputy with email address – then nobody has to wait for your return.
:::`,
    },
  },
];

const KINDS = { canned: CANNED_EXAMPLES, catalog: CATALOG_EXAMPLES, kb: KB_EXAMPLES };

/** List for the take-over dialog: key, title and a short description in both languages */
export function exampleList(kind) {
  const list = KINDS[kind];
  if (!list) throw new HttpError(404, 'err.notFound');
  const short = (s) => String(s || '').replace(/[#*:`>\-\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  return list.map((x) => ({
    key: x.key,
    emoji: x.emoji || null,
    de: { title: x.de.title, description: x.de.description || short(x.de.body) },
    en: { title: x.en.title, description: x.en.description || short(x.en.body) },
  }));
}

/**
 * Take over the chosen examples in one language. Skips what already exists under the German or
 * English title. Returns { added: [titles], skipped: [titles] }.
 */
export function createExamples({ db, canned, catalog, kb }) {
  function take(user, kind, keys, lang) {
    const list = KINDS[kind];
    if (!list) throw new HttpError(404, 'err.notFound');
    if (kind === 'kb' ? !isAgent(user) : user.role !== 'admin') throw forbidden();
    const l = lang === 'en' ? 'en' : 'de';
    const wanted = new Set((Array.isArray(keys) ? keys : []).map((k) => str(k, 40)));
    const exists = {
      canned: (title) => !!db.prepare('SELECT 1 FROM canned_responses WHERE owner_id IS NULL AND lower(title)=lower(?)').get(title),
      catalog: (title) => !!db.prepare('SELECT 1 FROM catalog_items WHERE lower(title)=lower(?)').get(title),
      kb: (title) => !!db.prepare('SELECT 1 FROM kb_articles WHERE lower(title)=lower(?)').get(title),
    }[kind];
    const added = [];
    const skipped = [];
    db.transaction(() => {
      for (const x of list) {
        if (!wanted.has(x.key)) continue;
        const v = x[l];
        if (exists(x.de.title) || exists(x.en.title)) { skipped.push(v.title); continue; }
        if (kind === 'canned') canned.create(user, { title: v.title, body: v.body, shared: true });
        else if (kind === 'catalog') {
          catalog.save(user, null, {
            title: v.title, description: v.description, emoji: x.emoji, active: false, sort: 100 + list.indexOf(x),
            fields: x.fields.map((fd) => ({ id: fd.id, label: fd[l], type: fd.type, required: fd.required, ...(fd.options ? { options: fd.options[l] } : {}) })),
          });
        } else kb.create(user, { title: v.title, body: v.body, category: v.category, visibility: 'internal', note: l === 'en' ? 'Example' : 'Beispiel' });
        added.push(v.title);
      }
    })();
    return { added, skipped };
  }
  return { list: exampleList, take };
}
