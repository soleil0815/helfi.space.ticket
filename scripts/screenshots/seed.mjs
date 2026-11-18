// Demo data for the screenshots: neutral names (firma.local, PC-0001, 10.0.10.x), German or English texts.
// Everything goes through the program's own API like a real installation; only times are moved back
// directly in the database so that lists, SLA and reports look lived-in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Small API client with its own session cookie */
function client(B, ip = '10.0.10.25') {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(B + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', 'X-Forwarded-For': ip, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${text.slice(0, 300)}`);
    return json;
  };
  call.upload = async (url, field, name, type, bytes) => {
    const fd = new FormData();
    fd.append(field, new Blob([bytes], { type }), name);
    const r = await fetch(B + url, { method: 'POST', headers: { 'X-Helfi-Request': '1', 'X-Forwarded-For': ip, cookie }, body: fd });
    if (r.status >= 300) throw new Error(`upload ${url}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  return call;
}

export async function seed(S) {
  const { B, db, ctx, T, lang, PASSWORD } = S;
  const d = { ids: {}, keys: {} };
  S.d = d;

  // ---------- Setup, people ----------
  const admin = client(B);
  await admin('POST', '/api/setup', { token: 'demo-setup', username: 'admin', displayName: 'Administrator', password: PASSWORD, email: 'admin@firma.local', language: lang, projectKey: 'IT', projectName: T('IT-Helpdesk', 'IT Help Desk') });
  const people = [
    ['a.berger', 'Anna Berger'], ['t.schulz', 'Tom Schulz'], ['l.wagner', 'Lena Wagner'], ['b.bauer', 'Bernd Bauer'],
    ['e.muster', 'Erika Muster'], ['m.mustermann', 'Max Mustermann'], ['j.klein', 'Jonas Klein'], ['c.chefin', 'Clara Chefin'], ['s.neu', 'Sophie Neumann'],
  ];
  for (const [u, n] of people) {
    d.ids[u] = (await admin('POST', '/api/users', { username: u, displayName: n, role: 'user', email: `${u}@firma.local`, password: PASSWORD })).user.id;
  }
  // Everyone has set up two-factor sign-in already (otherwise the reminder bar is in every picture);
  // Sophie is new and gets the passkey/2FA hints
  db.prepare("UPDATE users SET totp_enabled=1, passkey_prompt_until=-1 WHERE username<>'s.neu'").run();
  db.prepare('UPDATE users SET language=?').run(lang);
  const as = async (u) => { const x = client(B); await x('POST', '/api/auth/login', { username: u, password: PASSWORD }); return x; };
  const anna = await as('a.berger'); const tom = await as('t.schulz'); const lena = await as('l.wagner'); const bernd = await as('b.bauer');
  const erika = await as('e.muster'); const max = await as('m.mustermann'); const jonas = await as('j.klein'); const clara = await as('c.chefin');
  Object.assign(d, { admin, anna, tom, lena, bernd, erika, max, jonas, clara, as });

  // ---------- Settings ----------
  ctx.settings.setMany({
    'general.title': T('IT-Hilfecenter', 'IT Help Center'),
    'login.title': T('IT-Hilfecenter', 'IT Help Center'),
    'login.textDe': 'Willkommen im **IT-Hilfecenter**. Melde dich mit deinem Windows-Konto an.\nDringend? Telefon 0123-4567 oder it@firma.local',
    'login.textEn': 'Welcome to the **IT Help Center**. Sign in with your Windows account.\nUrgent? Phone 0123-4567 or it@firma.local',
    'login.userLabelDe': 'Windows-Anmeldename', 'login.userLabelEn': 'Windows user name',
    'imap.host': 'mail.firma.local', 'imap.user': 'helpdesk@firma.local', 'smtp.host': 'mail.firma.local', 'smtp.user': 'helpdesk@firma.local',
    'smtp.from': 'helpdesk@firma.local', 'smtp.fromName': T('IT-Hilfecenter', 'IT Help Center'),
    'imap.senderRules': JSON.stringify([{ pattern: '*@pve.firma.local', action: 'noreply', project: 'NET' }, { pattern: '*@newsletter.example', action: 'ignore' }]),
    'mfa.internalNetworks': '10.0.10.0/24\n10.0.20.0/24', 'mfa.ownAddresses': '203.0.113.10',
    'sla.enabled': true, 'survey.enabled': true, 'passkeys.enabled': true, 'reminder.unassignedDays': 2,
    'ldap.host': 'dc01.firma.local', 'ldap.baseDn': 'DC=firma,DC=local', 'ldap.bindDn': 'CN=svc-helfi,OU=Dienstkonten,DC=firma,DC=local',
  });

  // ---------- Projects and their people ----------
  const projects = (await admin('GET', '/api/projects')).projects;
  const it = projects.find((p) => p.key === 'IT');
  const net = (await admin('POST', '/api/projects', { key: 'NET', name: T('Netzwerk', 'Network') })).project;
  const ht = (await admin('POST', '/api/projects', { key: 'HT', name: T('Haustechnik', 'Facilities') })).project;
  await admin('PUT', `/api/projects/${it.id}/agents`, { lead: { userId: d.ids['a.berger'] }, deputy: { userId: d.ids['t.schulz'] }, members: [{ userId: d.ids['l.wagner'] }] });
  await admin('PUT', `/api/projects/${net.id}/agents`, { lead: { userId: d.ids['l.wagner'] }, deputy: { userId: d.ids['t.schulz'] }, members: [] });
  await admin('PUT', `/api/projects/${ht.id}/agents`, { lead: { userId: d.ids['b.bauer'] }, members: [] });
  await admin('PATCH', `/api/projects/${it.id}`, { description: T('Rechner, Drucker, Konten und Programme', 'Computers, printers, accounts and software'), portal: { show: true, description: T('Rechner, Drucker, Konten, Programme', 'Computers, printers, accounts, software'), intro: '', icon: 'monitor', color: 'blue' } });
  await admin('PATCH', `/api/projects/${net.id}`, { portal: { show: true, description: T('WLAN, VPN und Netzwerkdosen', 'Wi-Fi, VPN and network sockets'), icon: 'globe', color: 'purple' } });
  await admin('PATCH', `/api/projects/${ht.id}`, { description: T('Heizung, Wasser, Schlüssel, Räume', 'Heating, water, keys, rooms'), portal: { show: true, description: T('Heizung, Wasser, Schlüssel, Räume', 'Heating, water, keys, rooms'), intro: T('Bei Wasserschaden oder Stromausfall bitte sofort anrufen: 0123-4599.', 'In case of water damage or a power cut please call right away: 0123-4599.'), icon: 'home', color: 'orange' } });
  Object.assign(d, { it, net, ht });

  // Components from the examples, with responsible people
  await admin('POST', `/api/projects/${it.id}/components/examples`, { keys: ['it.workplace', 'it.printer', 'it.mail', 'it.account', 'it.software'], lang });
  await admin('POST', `/api/projects/${net.id}/components/examples`, { keys: ['it.network', 'it.vpn'], lang });
  await admin('POST', `/api/projects/${ht.id}/components/examples`, { keys: ['fac.heating', 'fac.water', 'fac.locks', 'fac.rooms'], lang });
  const comps = {};
  for (const p of [it, net, ht]) for (const x of (await admin('GET', `/api/projects/${p.id}/components`)).components) comps[x.name] = x;
  const comp = (re) => Object.values(comps).find((x) => re.test(x.name));
  await admin('PATCH', `/api/components/${comp(/Drucker|Print/).id}`, { leadId: d.ids['t.schulz'] });
  await admin('PATCH', `/api/components/${comp(/Arbeitsplatz|Workplace/).id}`, { leadId: d.ids['t.schulz'], deputyId: d.ids['a.berger'] });
  await admin('PATCH', `/api/components/${comp(/E-Mail|Email/).id}`, { leadId: d.ids['a.berger'] });
  await admin('PATCH', `/api/components/${comp(/VPN/).id}`, { leadId: d.ids['l.wagner'] });
  d.comp = comp;

  // ---------- Tickets ----------
  const keyRow = (key) => db.prepare("SELECT t.* FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key || '-' || t.number=?").get(key);
  /** Move a ticket (and its history) back in time */
  const ago = (key, minutes) => {
    const id = keyRow(key).id;
    const off = `-${minutes} minutes`;
    const shift = (tbl, col, where) => {
      try { db.prepare(`UPDATE ${tbl} SET ${col}=strftime('%Y-%m-%dT%H:%M:%fZ', ${col}, ?) WHERE ${where}=? AND ${col} IS NOT NULL`).run(off, id); } catch { /* no such column */ }
    };
    for (const col of ['created_at', 'updated_at', 'resolved_at']) shift('tickets', col, 'id');
    for (const tbl of ['comments', 'activity', 'attachments', 'sla_events']) shift(tbl, 'created_at', 'ticket_id');
    shift('ticket_ratings', 'rated_at', 'ticket_id');
  };
  const mk = async (who, data) => (await who('POST', '/api/tickets', data)).ticket;
  const set = (who, key, data) => who('PATCH', `/api/tickets/${key}`, data);
  d.ago = ago; d.mk = mk; d.set = set; d.keyRow = keyRow;

  const list = [
    // who, title, description, type, priority, assignee, status, labels, project, minutes ago
    [erika, T('Drucker PR-0001 im 2. OG druckt nicht', 'Printer PR-0001 on 2nd floor not printing'), T('Seit heute früh kommt beim Drucken „Papierstau Fach 2“, obwohl kein Papier klemmt.', 'Since this morning printing shows "Paper jam tray 2" although nothing is stuck.'), 'incident', 'high', 'a.berger', 'in_progress', [T('drucker', 'printer')], it, 190],
    [max, T('Neuer Laptop für Praktikantin', 'New laptop for intern'), T('Ab 1. Dezember startet eine Praktikantin. Bitte Laptop mit Office vorbereiten.', 'An intern starts on 1 December. Please prepare a laptop with Office.'), 'request', 'medium', 't.schulz', 'open', ['hardware'], it, 1500],
    [jonas, T('VPN bricht im Homeoffice ab', 'VPN drops when working from home'), T('Die VPN-Verbindung trennt sich etwa alle 20 Minuten.', 'The VPN connection drops roughly every 20 minutes.'), 'incident', 'highest', 'l.wagner', 'waiting', ['vpn'], net, 55],
    [erika, T('Zugriff auf Laufwerk Projekte', 'Access to the Projects drive'), T('Ich brauche Lesezugriff auf \\\\fs01\\projekte.', 'I need read access to \\\\fs01\\projects.'), 'request', 'low', null, 'open', [], it, 300],
    [max, T('Kennwort läuft bald ab – wie ändern?', 'Password expires soon – how to change it?'), T('Ich habe eine Meldung bekommen, dass mein Kennwort abläuft.', 'I got a message that my password is about to expire.'), 'question', 'low', 'a.berger', 'done', [T('konto', 'account')], it, 4000],
    [jonas, T('Bildschirm flackert an PC-0002', 'Screen flickers on PC-0002'), T('Der zweite Monitor flackert, wenn er sich einschaltet.', 'The second monitor flickers when it turns on.'), 'incident', 'medium', 't.schulz', 'in_progress', ['monitor'], it, 3000],
    [anna, T('Firmware der Switches aktualisieren', 'Update switch firmware'), T('Wartungsfenster am Samstag einplanen.', 'Plan a maintenance window on Saturday.'), 'task', 'medium', 'l.wagner', 'open', [T('wartung', 'maintenance')], net, 2000],
    [tom, T('Zertifikat für helfi.firma.local erneuern', 'Renew certificate for helfi.firma.local'), T('Läuft in 30 Tagen ab.', 'Expires in 30 days.'), 'task', 'high', 't.schulz', 'in_progress', [T('zertifikat', 'certificate')], it, 900],
    [erika, T('Teams-Kamera wird nicht erkannt', 'Teams camera not detected'), T('Die eingebaute Kamera ist in Teams grau.', 'The built-in camera is greyed out in Teams.'), 'incident', 'medium', 'l.wagner', 'open', [], it, 120],
    [max, T('Software-Wunsch: Notepad++', 'Software request: Notepad++'), T('Für die Bearbeitung von Konfigurationsdateien.', 'For editing configuration files.'), 'request', 'lowest', null, 'open', ['software'], it, 600],
    [jonas, T('Heizung im Raum 2.03 bleibt kalt', 'Radiator in room 2.03 stays cold'), T('Seit Montag wird der Heizkörper nicht mehr warm.', 'Since Monday the radiator does not get warm.'), 'incident', 'medium', 'b.bauer', 'in_progress', [], ht, 1300],
    [erika, T('Schlüssel für Lager im Keller', 'Key for the basement storeroom'), T('Ich brauche bis Freitag einen Schlüssel für das Lager.', 'I need a key for the storeroom by Friday.'), 'request', 'low', null, 'open', [], ht, 400],
    [max, T('WLAN im Besprechungsraum langsam', 'Wi-Fi slow in the meeting room'), T('Videokonferenzen ruckeln im Raum Rhein.', 'Video calls stutter in the room Rhine.'), 'incident', 'medium', null, 'open', ['wlan'], net, 240],
  ];
  d.t = [];
  for (const [who, title, description, type, priority, assignee, status, labels, project, minutes] of list) {
    const tk = await mk(who, { title, description, type, priority, labels, projectId: project.id });
    const agent = assignee === 'b.bauer' ? bernd : assignee === 'l.wagner' ? lena : assignee === 't.schulz' ? tom : anna;
    if (assignee) await set(agent, tk.key, { assigneeId: d.ids[assignee] });
    if (status === 'done') await agent('POST', `/api/tickets/${tk.key}/comments`, { body: T('Strg+Alt+Entf → „Kennwort ändern“. Danach einmal ab- und wieder anmelden.', 'Ctrl+Alt+Del → "Change a password". Then sign out and in once.') });
    if (status !== 'open') await set(agent, tk.key, { status });
    ago(tk.key, minutes);
    d.t.push(tk.key);
  }
  const [k1] = d.t;
  d.keys.printer = k1;
  d.keys.vpn = d.t[2];
  // A conversation in the first ticket
  await anna('POST', `/api/tickets/${k1}/comments`, { body: T('Hallo Frau Muster, ich schaue mir das gleich an. Erscheint die Meldung auch, wenn Sie vom Handy drucken?', 'Hello Ms Muster, I will look into it right away. Does the message also appear when you print from your phone?') });
  await erika('POST', `/api/tickets/${k1}/comments`, { body: T('Ja, leider auch vom Handy. 🙁', 'Yes, unfortunately from the phone as well. 🙁') });
  await anna('POST', `/api/tickets/${k1}/comments`, { body: T('Sensor an Fach 2 verschmutzt – Ersatzteil ist bestellt (Lieferung Donnerstag).', 'Sensor in tray 2 dirty – spare part ordered (delivery Thursday).'), internal: true });
  await anna('POST', `/api/tickets/${k1}/participants`, { userId: d.ids['m.mustermann'] });
  ago(k1, 0);

  // Older finished tickets: fill lists, reports and the pager
  const old = [
    T('Outlook fragt ständig nach dem Kennwort', 'Outlook keeps asking for the password'), T('Maus funktioniert nicht', 'Mouse not working'), T('Drucker im 1. OG offline', 'Printer on 1st floor offline'),
    T('Neues Headset benötigt', 'Need a new headset'), T('Excel stürzt beim Öffnen ab', 'Excel crashes on opening'), T('Kalender wird nicht synchronisiert', 'Calendar does not sync'),
    T('Zugang zum Intranet', 'Access to the intranet'), T('Monitor bleibt schwarz', 'Monitor stays black'), T('Konto gesperrt', 'Account locked'),
    T('Scanner speichert nicht im Ordner', 'Scanner does not save to folder'), T('Teams-Ton verzerrt', 'Teams audio distorted'), T('Dockingstation lädt nicht', 'Docking station does not charge'),
  ];
  const reporters = [erika, max, jonas];
  for (let i = 0; i < 120; i++) {
    const tk = await mk(reporters[i % 3], { title: old[i % old.length], type: i % 4 === 0 ? 'request' : 'incident', priority: ['low', 'medium', 'medium', 'high'][i % 4], projectId: it.id });
    const ag = [anna, tom, lena][i % 3];
    await set(ag, tk.key, { assigneeId: d.ids[['a.berger', 't.schulz', 'l.wagner'][i % 3]] });
    await ag('POST', `/api/tickets/${tk.key}/comments`, { body: T('Erledigt – bitte kurz testen.', 'Done – please give it a quick test.') });
    await set(ag, tk.key, { status: 'done' });
    ago(tk.key, 60 * 8 * (9 + i));
  }

  // Templates: for everyone, for a project, own
  await admin('POST', '/api/canned', { title: T('Rechner neu starten', 'Restart computer'), body: T('bitte starten Sie den Rechner einmal neu und melden Sie sich danach wieder.', 'please restart your computer once and let us know afterwards.'), shared: true });
  await admin('POST', '/api/canned', { title: T('Ticket erledigt', 'Ticket resolved'), body: T('das Problem ist behoben. Melden Sie sich gern, falls noch etwas ist.', 'the issue is fixed. Let us know if anything else comes up.'), shared: true });
  await anna('POST', '/api/canned', { title: T('Druckertreiber neu installieren', 'Reinstall printer driver'), body: T('bitte installieren Sie den Druckertreiber über das Softwarecenter neu.', 'please reinstall the printer driver from the software center.'), shared: true, projectId: it.id });
  await anna('POST', '/api/canned', { title: T('VPN-Client neu installieren', 'Reinstall VPN client'), body: T('bitte den VPN-Client über das Softwarecenter neu installieren.', 'please reinstall the VPN client via the software center.') });

  // Saved filters
  await admin('POST', '/api/filters', { name: T('Drucker offen', 'Printers open'), query: 'status=open,in_progress&q=' + encodeURIComponent(T('Drucker', 'Printer')), shared: true });
  await anna('POST', '/api/filters', { name: T('Meine dringenden', 'My urgent ones'), query: 'assignee=me&status=unresolved' });
  await anna('POST', '/api/filters', { name: T('Warten auf Rückmeldung', 'Waiting for reply'), query: 'status=waiting' });

  // An HTML mail with an inline picture
  const logo = fs.readFileSync(path.join(here, '../../public/icons/icon-192.png')).toString('base64');
  const mailHtml = T(
    '<p>Hallo IT-Team,</p><p>seit dem Update startet <b>Outlook</b> an PC-0003 nicht mehr. Fehlermeldung:</p><table cellpadding="6" style="border-collapse:collapse"><tr><td style="background:#FFECEB;color:#C9372C;border:1px solid #C9372C"><b>Outlook kann nicht gestartet werden.</b> Die Datei ist beschädigt.</td></tr></table><ul><li>Neustart hat nicht geholfen</li><li>Webmail funktioniert</li></ul><p>Viele Grüße<br><span style="color:#0C66E4;font-weight:bold">Jonas Klein</span><br>Verwaltung · Tel. 0123-4568</p><img src="cid:logo@firma" alt="Firma" width="64"><img src="https://tracker.example/o.gif" width="1" height="1">',
    '<p>Hello IT team,</p><p>since the update <b>Outlook</b> no longer starts on PC-0003. Error message:</p><table cellpadding="6" style="border-collapse:collapse"><tr><td style="background:#FFECEB;color:#C9372C;border:1px solid #C9372C"><b>Cannot start Outlook.</b> The file is damaged.</td></tr></table><ul><li>Restarting did not help</li><li>Webmail works</li></ul><p>Kind regards<br><span style="color:#0C66E4;font-weight:bold">Jonas Klein</span><br>Administration · Phone 0123-4568</p><img src="cid:logo@firma" alt="Company" width="64"><img src="https://tracker.example/o.gif" width="1" height="1">');
  const mail = ['From: Jonas Klein <j.klein@firma.local>', 'To: helpdesk@firma.local', `Subject: ${T('Outlook startet nicht', 'Outlook does not start')}`, 'Message-ID: <m1@firma.local>',
    'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="R"', '', '--R', 'Content-Type: multipart/alternative; boundary="A"', '',
    '--A', 'Content-Type: text/plain; charset=utf-8', '', T('Outlook startet an PC-0003 nicht mehr.', 'Outlook no longer starts on PC-0003.'), '',
    '--A', 'Content-Type: text/html; charset=utf-8', '', mailHtml, '', '--A--', '',
    '--R', 'Content-Type: image/png; name="logo.png"', 'Content-Transfer-Encoding: base64', 'Content-ID: <logo@firma>', 'Content-Disposition: inline; filename="logo.png"', '', logo, '', '--R--', ''].join('\r\n');
  const mt = await ctx.processor.process(await ctx.processor.parse(Buffer.from(mail)));
  d.keys.mail = mt?.key || mt?.ticket?.key;
  if (!d.keys.mail) d.keys.mail = db.prepare("SELECT p.key || '-' || t.number k FROM tickets t JOIN projects p ON p.id=t.project_id ORDER BY t.id DESC LIMIT 1").get().k;
  ago(d.keys.mail, 25);

  await (await import('./seed-itil.mjs')).seedItil(S);
  return d;
}
