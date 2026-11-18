// Demo data for the ITIL part: devices & services, knowledge base, major incident, problem, change,
// service catalog with approval, ratings
export async function seedItil(S) {
  const { db, T, d } = S;
  const { admin, anna, tom, lena, bernd, erika, max, jonas, clara, mk, set, ago, it, net, ht } = d;
  const ids = d.ids;
  const day = (n, h) => { const x = new Date(); x.setDate(x.getDate() + n); x.setHours(h, 0, 0, 0); return x.toISOString(); };

  // Devices & services
  const csv = [T('Hostname;Typ;Standort;IP-Adresse;Seriennummer;Hersteller;Modell;Benutzer', 'Hostname;Type;Location;IP address;Serial number;Vendor;Model;User'),
    `PC-0001;Notebook;${T('Raum 1.12', 'Room 1.12')};10.0.10.21;SN-4711;Lenovo;ThinkPad T14;e.muster`,
    `PC-0002;PC;${T('Raum 1.14', 'Room 1.14')};10.0.10.22;SN-4712;Dell;OptiPlex 7010;m.mustermann`,
    `PC-0003;Notebook;${T('Raum 2.03', 'Room 2.03')};10.0.10.23;SN-4713;Lenovo;ThinkPad T14;j.klein`,
    `SRV-FILE01;Server;${T('Serverraum', 'Server room')};10.0.10.5;;HPE;ProLiant DL360;`,
    `SRV-MAIL01;Server;${T('Serverraum', 'Server room')};10.0.10.6;;HPE;ProLiant DL360;`,
    `SW-CORE;Switch;${T('Serverraum', 'Server room')};10.0.10.1;;;;`,
    `PR-0001;${T('Drucker', 'Printer')};${T('Flur 2. OG', 'Hallway 2nd floor')};10.0.10.40;;Kyocera;TASKalfa 2554ci;`,
    `VPN;${T('Dienst', 'Service')};;vpn.firma.local;;;;`,
    `${T('E-Mail', 'Email')};${T('Dienst', 'Service')};;mail.firma.local;;;;`].join('\n');
  await admin('POST', '/api/cis/import', { csv });
  const ci = Object.fromEntries((await anna('GET', '/api/cis')).items.map((x) => [x.name, x.id]));
  d.ci = ci;
  await anna('POST', `/api/tickets/${d.keys.printer}/cis`, { ciId: ci['PR-0001'] });

  // Knowledge base: public and internal articles in the projects, a page tree, versions, comments, ratings
  const kb = async (who, a) => (await who('POST', '/api/kb', a)).article;
  const printer = await kb(anna, { projectId: it.id, title: T('Drucker: „Papierstau Fach 2“ ohne Papierstau', 'Printer: "Paper jam tray 2" without a jam'), category: T('Drucker', 'Printers'), visibility: 'public',
    body: T('**Ursache:** verschmutzter Sensor in Fach 2.\n\n1. Fach 2 herausziehen.\n2. Sensor links hinten mit einem trockenen Tuch reinigen.\n3. Fach wieder einsetzen.\n\n:::info\nHilft das nicht, bitte ein Ticket mit der Druckernummer (z. B. PR-0001) melden.\n:::',
      '**Cause:** dirty sensor in tray 2.\n\n1. Pull out tray 2.\n2. Clean the sensor at the back left with a dry cloth.\n3. Put the tray back.\n\n:::info\nIf that does not help, please report a ticket with the printer number (e.g. PR-0001).\n:::') });
  const vpn = await kb(lena, { projectId: net.id, title: T('VPN im Homeoffice einrichten', 'Set up VPN when working from home'), category: 'VPN', visibility: 'public',
    body: T('Mit dem VPN erreichen Sie von zu Hause die Laufwerke und das Intranet.\n\n1. VPN-Client aus dem Softwarecenter installieren.\n2. Mit dem Windows-Konto anmelden.\n3. Bei „Verbindung aktiv halten“ den Haken setzen.',
      'With the VPN you reach the drives and the intranet from home.\n\n1. Install the VPN client from the software center.\n2. Sign in with your Windows account.\n3. Tick "Keep connection alive".') });
  await kb(lena, { parentId: vpn.id, title: T('VPN unter macOS', 'VPN on macOS'), visibility: 'public', body: T('Auf dem Mac den Client aus dem Self Service installieren.', 'On a Mac install the client from Self Service.') });
  await kb(lena, { parentId: vpn.id, title: T('VPN-Fehler 809', 'VPN error 809'), visibility: 'public', body: T('Fehler 809: Router zu Hause blockiert IPsec. Router neu starten oder Hotspot testen.', 'Error 809: the home router blocks IPsec. Restart the router or try a hotspot.') });
  const pw = await kb(anna, { projectId: it.id, title: T('Kennwort ändern', 'Change your password'), category: T('Konto', 'Account'), visibility: 'public', body: T('Strg+Alt+Entf → Kennwort ändern.', 'Ctrl+Alt+Del → Change a password.') });
  await anna('PUT', `/api/kb/${pw.id}`, { title: pw.title, category: pw.category, visibility: 'public', projectId: it.id,
    body: T('Strg+Alt+Entf → **Kennwort ändern**. Das neue Kennwort braucht mindestens 12 Zeichen.\n\nUnterwegs: im Webmail unter Einstellungen → Kennwort.',
      'Ctrl+Alt+Del → **Change a password**. The new password needs at least 12 characters.\n\nOn the road: in webmail under Settings → Password.') });
  await kb(tom, { projectId: it.id, title: T('Dateiserver neu starten', 'Restart the file server'), category: 'Server', visibility: 'internal', body: T('Nur außerhalb der Arbeitszeit. Vorher Benutzer informieren.', 'Only outside working hours. Inform users first.') });
  await kb(bernd, { projectId: ht.id, title: T('Heizkörper entlüften', 'Bleed a radiator'), category: T('Heizung', 'Heating'), visibility: 'public', body: T('Entlüftungsschlüssel beim Hausmeister abholen. Ventil oben am Heizkörper eine halbe Umdrehung öffnen, bis Wasser kommt.', 'Pick up the bleed key from the caretaker. Open the valve at the top of the radiator half a turn until water comes out.') });
  await kb(bernd, { projectId: ht.id, title: T('Raum buchen', 'Book a room'), category: T('Räume', 'Rooms'), visibility: 'public', body: T('Besprechungsräume im Kalender als Raum hinzufügen.', 'Add meeting rooms to the calendar invitation as a room.') });
  await anna('POST', `/api/kb/${printer.id}/comments`, { body: T('Gilt auch für die Drucker im 1. OG.', 'Also applies to the printers on the 1st floor.') });
  await erika('POST', `/api/kb/${printer.id}/vote`, { vote: 1 });
  await jonas('POST', `/api/kb/${printer.id}/vote`, { vote: 1 });
  await erika('POST', `/api/kb/${pw.id}/vote`, { vote: 1 });
  for (const [who, text] of [[max, T('Wo finde ich das am Mac?', 'Where do I find this on a Mac?')], [jonas, T('Die Mindestlänge stimmt nicht mehr.', 'The minimum length is out of date.')]]) {
    await who('POST', `/api/kb/${pw.id}/vote`, { vote: -1 });
    await who('POST', `/api/kb/${pw.id}/feedback`, { body: text });
  }
  // Onboarding: a page tree with two versions and a comment
  const onb = await kb(tom, { projectId: it.id, title: T('Onboarding neuer Mitarbeiter', 'Onboarding new employees'), category: T('Konto', 'Account'), visibility: 'public', body: T('Alles für den ersten Arbeitstag.', 'Everything for the first working day.') });
  const acc = await kb(anna, { parentId: onb.id, title: T('Konten anlegen', 'Create accounts'), visibility: 'public',
    body: T('# Überblick\nSo legst du die Konten für neue Mitarbeiter an.\n\n## Schritte\n1. Konto im AD anlegen\n2. Postfach einrichten\n3. Gruppen zuweisen\n\n:::warning\nKennwort nie per Mail verschicken.\n:::',
      '# Overview\nThis is how you create the accounts for new employees.\n\n## Steps\n1. Create the account in AD\n2. Set up the mailbox\n3. Assign groups\n\n:::warning\nNever send passwords by email.\n:::') });
  await tom('PUT', `/api/kb/${acc.id}`, { title: acc.title, visibility: 'public', note: T('Gruppen und Lizenz ergänzt', 'Added groups and licence'),
    body: T('# Überblick\nSo legst du die Konten für neue Mitarbeiter an. Das dauert etwa 15 Minuten.\n\n## Schritte\n1. Konto im AD anlegen\n2. Postfach im Exchange einrichten\n3. Gruppen „Mitarbeiter“ und Abteilung zuweisen\n4. Lizenz zuweisen\n\n:::warning\nKennwort nie per Mail verschicken.\n:::',
      '# Overview\nThis is how you create the accounts for new employees. It takes about 15 minutes.\n\n## Steps\n1. Create the account in AD\n2. Set up the mailbox in Exchange\n3. Assign the groups "Staff" and the department\n4. Assign a licence\n\n:::warning\nNever send passwords by email.\n:::') });
  await kb(anna, { parentId: acc.id, title: T('E-Mail-Postfach', 'Mailbox'), visibility: 'public', body: T('Postfach im Exchange-Admin-Center anlegen.', 'Create the mailbox in the Exchange admin center.') });
  await kb(anna, { parentId: acc.id, title: T('Windows-Konto', 'Windows account'), visibility: 'public', body: T('Konto in der OU „Mitarbeiter“ anlegen.', 'Create the account in the OU "Staff".') });
  await kb(anna, { parentId: onb.id, title: T('Arbeitsplatz einrichten', 'Set up the workstation'), visibility: 'public', body: T('Notebook aus dem Lager, Dockingstation, zwei Monitore.', 'Notebook from the store, docking station, two monitors.') });
  await erika('POST', `/api/kb/${acc.id}/comments`, { body: T('Bei mir fehlte noch der Zugang zum Laufwerk P: – gehört das auch auf die Liste?', 'I was still missing access to drive P: – does that belong on the list too?') });
  d.kb = { printer, vpn, pw, onb, acc };

  // Major incident with subtasks, affected tickets and device
  const mi = await mk(anna, { title: T('Dateiserver SRV-FILE01 nicht erreichbar', 'File server SRV-FILE01 unreachable'), type: 'incident', projectId: it.id, description: T('Laufwerke H: und P: sind seit 9:10 Uhr nicht erreichbar.', 'Drives H: and P: unreachable since 9:10.') });
  await set(anna, mi.key, { impact: 'high', urgency: 'high', assigneeId: ids['a.berger'], status: 'in_progress' });
  await anna('POST', `/api/tickets/${mi.key}/cis`, { ciId: ci['SRV-FILE01'] });
  for (const [who, title] of [[erika, T('Laufwerk P: fehlt', 'Drive P: missing')], [max, T('Kann Projektordner nicht öffnen', 'Cannot open project folder')], [jonas, T('Excel-Datei lässt sich nicht speichern', 'Excel file cannot be saved')]]) {
    const t = await mk(who, { title, projectId: it.id });
    await anna('POST', `/api/tickets/${mi.key}/links`, { kind: 'causes', target: t.key });
  }
  await anna('POST', `/api/tickets/${mi.key}/subtasks`, { title: T('Hardware-Status im iLO prüfen', 'Check hardware status in iLO'), assigneeId: ids['t.schulz'] });
  const st2 = await anna('POST', `/api/tickets/${mi.key}/subtasks`, { title: T('Benutzer per Rundmail informieren', 'Inform users by broadcast email'), assigneeId: ids['a.berger'] });
  await set(anna, (st2.ticket || st2.subtask || st2).key, { status: 'done' }).catch(() => {});
  await set(anna, mi.key, { major: true });
  await anna('POST', `/api/tickets/${mi.key}/broadcast`, { body: T('Der Dateiserver ist gestört. Wir arbeiten daran, nächste Info um 10:30 Uhr.', 'The file server is down. We are working on it, next update at 10:30.') });
  ago(mi.key, 35);
  // Declared a major incident only in its own scene: otherwise its banner is in every picture
  await set(anna, mi.key, { major: false });
  d.keys.major = mi.key;

  // Problem from recurring VPN incidents
  const v1 = await mk(max, { title: T('VPN trennt sich ständig', 'VPN keeps disconnecting'), type: 'incident', projectId: net.id });
  const prob = (await lena('POST', `/api/tickets/${d.keys.vpn}/problem`, { title: T('VPN-Abbrüche alle 20 Minuten', 'VPN drops every 20 minutes') })).ticket;
  await set(lena, prob.key, { description: T('Seit Anfang des Monats melden Kolleginnen im Homeoffice, dass das VPN etwa alle 20 Minuten trennt.', 'Since the start of the month colleagues working from home report that the VPN drops about every 20 minutes.') });
  await lena('POST', `/api/tickets/${prob.key}/links`, { kind: 'causes', target: v1.key });
  await lena('PATCH', `/api/tickets/${prob.key}/fields`, { rootCause: T('Leerlauf-Timeout der Firewall (20 Minuten) trennt Tunnel ohne Datenverkehr.', 'Firewall idle timeout (20 minutes) drops tunnels without traffic.'), workaround: T('Im VPN-Client „Verbindung aktiv halten“ einschalten.', 'Enable "Keep connection alive" in the VPN client.'), knownError: true });
  await set(lena, prob.key, { assigneeId: ids['l.wagner'], status: 'in_progress' });
  await lena('POST', `/api/tickets/${prob.key}/cis`, { ciId: ci.VPN });
  d.keys.problem = prob.key;

  // Changes: one waiting for the second approval, two scheduled (overlapping)
  S.ctx.settings.setMany({ 'change.approvers': `${ids['t.schulz']},${ids['l.wagner']}`, 'change.approvalMode': 'all',
    'change.standardTemplates': JSON.stringify([{ title: T('Firmware-Update Switch', 'Switch firmware update'), risk: 'low', services: T('Netzwerk Gebäude A', 'Network building A'), implementationPlan: T('Firmware laden, Switch neu starten', 'Upload firmware, restart switch'), backoutPlan: T('Vorherige Firmware zurückspielen', 'Restore previous firmware'), testPlan: T('Ping auf alle Etagen', 'Ping all floors') }]) });
  const ch = await mk(lena, { title: T('Firewall: Leerlauf-Timeout für VPN auf 8 Stunden', 'Firewall: VPN idle timeout to 8 hours'), type: 'change', projectId: net.id, description: T('Das Leerlauf-Timeout der Firewall trennt VPN-Tunnel nach 20 Minuten ohne Verkehr. Es soll auf 8 Stunden steigen.', 'The firewall idle timeout drops VPN tunnels after 20 minutes without traffic. It is to be raised to 8 hours.') });
  await lena('PATCH', `/api/tickets/${ch.key}/fields`, { changeType: 'normal', risk: 'medium', reason: T(`Behebt ${prob.key}: VPN-Abbrüche im Homeoffice.`, `Fixes ${prob.key}: VPN drops when working from home.`), services: 'VPN', plannedStart: day(3, 18), plannedEnd: day(3, 19),
    implementationPlan: T('Regel „VPN-Idle“ auf 28800 s setzen, Richtlinie aktivieren.', 'Set rule "VPN idle" to 28800 s, activate the policy.'), backoutPlan: T('Alten Wert 1200 s wiederherstellen.', 'Restore the old value 1200 s.'), testPlan: T('VPN 30 Minuten ohne Verkehr offen lassen.', 'Leave the VPN open for 30 minutes without traffic.') });
  await lena('POST', `/api/tickets/${ch.key}/links`, { kind: 'relates', target: prob.key });
  await lena('POST', `/api/tickets/${ch.key}/cis`, { ciId: ci.VPN });
  await lena('POST', `/api/tickets/${ch.key}/change/transition`, { to: 'approval' });
  await tom('POST', `/api/tickets/${ch.key}/approval`, { decision: 'approve', comment: T('Passt, bitte nach 18 Uhr.', 'Fine, please after 6 pm.') });
  d.keys.change = ch.key;
  const ch2 = await mk(tom, { title: T('Firmware-Update Switch', 'Switch firmware update'), type: 'change', projectId: net.id });
  await tom('PATCH', `/api/tickets/${ch2.key}/fields`, { changeType: 'standard', risk: 'low', reason: T('Sicherheitslücke in der alten Firmware', 'Vulnerability in old firmware'), services: T('Netzwerk Gebäude A', 'Network building A'), plannedStart: day(3, 18), plannedEnd: day(3, 20), implementationPlan: 'Firmware', backoutPlan: 'Rollback' });
  await tom('POST', `/api/tickets/${ch2.key}/change/transition`, { to: 'scheduled' });
  const ch3 = await mk(anna, { title: T('Exchange-Sicherheitsupdate', 'Exchange security update'), type: 'change', projectId: it.id });
  await anna('PATCH', `/api/tickets/${ch3.key}/fields`, { changeType: 'normal', risk: 'medium', reason: T('Monatliches Sicherheitsupdate', 'Monthly security update'), testPlan: T('Mail senden und empfangen', 'Send and receive mail'), services: T('E-Mail', 'Email'), plannedStart: day(8, 19), plannedEnd: day(8, 21), implementationPlan: 'CU', backoutPlan: 'Snapshot' });
  await anna('POST', `/api/tickets/${ch3.key}/change/transition`, { to: 'approval' });
  for (const a of [tom, lena]) await a('POST', `/api/tickets/${ch3.key}/approval`, { decision: 'approve' });
  await anna('POST', `/api/tickets/${ch3.key}/change/transition`, { to: 'scheduled' });

  // Service catalog: IT with approval, facilities from its lead, one not yet sorted in
  const cat = async (who, x) => (await who('POST', '/api/catalog', x)).item;
  const onboarding = await cat(admin, { projectKey: 'IT', title: T('Neuer Mitarbeiter', 'New employee'), emoji: '🧑‍💼', description: T('Konto, Postfach und Arbeitsplatz einrichten', 'Set up account, mailbox and workstation'), approverIds: [ids['c.chefin']], approvalMode: 'any',
    fields: [{ id: 'name', label: T('Name', 'Name'), type: 'text', required: true }, { id: 'start', label: T('Erster Arbeitstag', 'First working day'), type: 'date', required: true },
      { id: 'device', label: T('Gerät', 'Device'), type: 'select', options: T('Notebook\nPC\nkein Gerät', 'Notebook\nPC\nno device'), required: true }, { id: 'vpn', label: T('VPN-Zugang', 'VPN access'), type: 'checkbox' },
      { id: 'notes', label: T('Hinweise', 'Notes'), type: 'textarea' }] });
  await cat(admin, { projectKey: 'IT', title: T('Software-Wunsch', 'Software request'), emoji: '💿', description: T('Programm installieren lassen', 'Have a program installed'), approverIds: [ids['c.chefin']],
    fields: [{ id: 'sw', label: T('Programm', 'Program'), type: 'text', required: true }, { id: 'why', label: T('Wofür?', 'What for?'), type: 'textarea', required: true }] });
  await cat(admin, { projectKey: 'IT', title: T('Zugriff auf Laufwerk', 'Access to a drive'), emoji: '📁', description: T('Lese- oder Schreibrechte auf einen Ordner', 'Read or write access to a folder'),
    fields: [{ id: 'path', label: T('Ordner', 'Folder'), type: 'text', required: true }, { id: 'right', label: T('Recht', 'Permission'), type: 'select', options: T('Lesen\nSchreiben', 'Read\nWrite'), required: true }] });
  await cat(admin, { projectKey: 'IT', title: T('Kennwort zurücksetzen', 'Reset password'), emoji: '🔑', description: T('Wenn das Konto gesperrt ist', 'If your account is locked'), fields: [] });
  await cat(bernd, { projectKey: 'HT', title: T('Schlüssel beantragen', 'Request a key'), emoji: '🗝️', description: T('Für Büro, Lager oder Schrank', 'For office, storeroom or cabinet'), approverIds: [ids['c.chefin']], fields: [{ id: 'room', label: T('Raum', 'Room'), type: 'text', required: true }] });
  await cat(bernd, { projectKey: 'HT', title: T('Möbel umstellen', 'Move furniture'), emoji: '🪑', description: T('Schreibtisch, Schrank, Regal', 'Desk, cabinet, shelf'), fields: [{ id: 'what', label: T('Was?', 'What?'), type: 'textarea', required: true }] });
  await cat(admin, { title: T('Parkplatz beantragen', 'Request a parking space'), emoji: '🅿️', description: T('Stellplatz in der Tiefgarage', 'Space in the underground car park'), fields: [] });
  const order = (await max('POST', `/api/catalog/${onboarding.id}/order`, { answers: { name: 'Paula Beispiel', start: day(20, 8).slice(0, 10), device: T('Notebook', 'Notebook'), vpn: true } })).ticket;
  d.catalog = { onboarding };
  d.keys.order = order.key;

  // Finished with rating
  const r1 = await mk(erika, { title: T('Outlook-Profil reparieren', 'Repair Outlook profile'), projectId: it.id });
  await set(anna, r1.key, { assigneeId: ids['a.berger'] });
  await anna('POST', `/api/tickets/${r1.key}/comments`, { body: T('Profil repariert, Outlook startet wieder.', 'Profile repaired, Outlook starts again.') });
  S.sent.length = 0;
  await set(anna, r1.key, { status: 'done' });
  await new Promise((r) => setTimeout(r, 200));
  const rateMail = S.sent.find((m) => m.to === 'e.muster@firma.local' && /\/rate\//.test(m.text || ''));
  d.rateToken = rateMail ? /\/rate\/([\w-]+)/.exec(rateMail.text)[1] : null;
  for (const [who, stars, text] of [[max, 5, T('Super schnell, danke!', 'Super fast, thanks!')], [jonas, 4, ''], [erika, 3, T('Hat zwei Tage gedauert.', 'Took two days.')], [max, 5, ''], [jonas, 5, T('Sehr freundlich.', 'Very friendly.')]]) {
    const t = await mk(who, { title: T('Erledigte Anfrage', 'Resolved request'), projectId: it.id });
    await set(tom, t.key, { assigneeId: ids['t.schulz'] });
    await tom('POST', `/api/tickets/${t.key}/comments`, { body: 'OK' });
    await set(tom, t.key, { status: 'done' });
    await who('POST', `/api/tickets/${t.key}/rating`, { rating: stars, comment: text });
    ago(t.key, 60 * 24 * 2);
  }
  await anna('POST', `/api/tickets/${d.t[5]}/cis`, { ciId: ci['PC-0002'] });
  // Unlinked VPN incident: "possible cause" and similar tickets when linking
  d.keys.vpn2 = (await mk(jonas, { title: T('VPN langsam beim Kopieren großer Dateien', 'VPN slow when copying large files'), type: 'incident', projectId: net.id })).key;
  // Closed with a resolution: duplicate and rejected (the newest done tickets: top of the list)
  const dup = await mk(max, { title: T('Drucker 2. Stock geht nicht', 'Printer 2nd floor not working'), projectId: it.id });
  await anna('POST', `/api/tickets/${dup.key}/resolve`, { resolution: 'duplicate', duplicateOf: d.keys.printer, reason: '' });
  const rej = await mk(jonas, { title: T('Bitte Spielekonsole für die Teeküche', 'Please a games console for the tea kitchen'), projectId: it.id });
  await anna('POST', `/api/tickets/${rej.key}/resolve`, { resolution: 'rejected', reason: T('Eine Spielekonsole können wir leider nicht über die IT anschaffen.', 'Unfortunately IT cannot purchase a games console.') });
  d.keys.toReject = (await mk(erika, { title: T('Neuer Kaffeevollautomat für den 2. Stock', 'New coffee machine for the 2nd floor'), projectId: it.id, description: T('Der alte ist kaputt.', 'The old one is broken.') })).key;
  // A mention for Anna in an internal note
  await tom('POST', `/api/tickets/${d.t[1]}/comments`, { body: T('@[Anna Berger](user:' + ids['a.berger'] + ') kannst du das Notebook bis Freitag mit Office einrichten?', '@[Anna Berger](user:' + ids['a.berger'] + ') could you set up the notebook with Office by Friday?'), internal: true, format: 'md' }).catch(() => {});
  // Administration: people from the Active Directory, the IT agent group, an emergency access, two backups
  db.prepare("UPDATE projects SET agent_group='Helpdesk' WHERE id=?").run(it.id);
  db.prepare("INSERT OR IGNORE INTO project_agents(project_id,user_id,source) VALUES(?,?,'group')").run(it.id, ids['j.klein']);
  const { addEmergencyLog } = await import('../../src/emergency.js');
  addEmergencyLog(db, { at: new Date(Date.now() - 9 * 86400000).toISOString(), action: 'reset', username: 'admin', mfaReset: true });
  await admin('POST', '/api/admin/backup', {}).catch(() => {});
  void db;
}
