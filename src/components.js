// Components: sub-areas of a project (e.g. "VPN & remote access") with a responsible person and
// an optional deputy. New tickets are matched by keywords in title/description or by the sender
// address; when nothing is assigned yet the ticket goes to the lead (or the deputy if the lead is
// inactive). Everything is optional: without components nothing changes.
import { HttpError, notFound, str, int } from './lib/http.js';
import { patternToRegExp } from './mail/rules.js';

export const MAX_COMPONENTS = 100; // per project
const MAX_KEYWORDS = 60;
const MAX_SENDERS = 30;
const TITLE_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
const MATCH_TEXT_LIMIT = 5000; // only the start of long descriptions is searched (mail footers and quotes add noise)

/** "vpn, FortiClient\nfernzugriff" → ['vpn', 'forticlient', 'fernzugriff'] */
export function parseList(v, { max, maxLen }) {
  const arr = Array.isArray(v) ? v : str(v, 20000).split(/[,;\n]+/);
  const out = [];
  for (const x of arr) {
    const s = str(x, 500).trim().toLowerCase().replace(/\s+/g, ' ');
    if (s && s.length <= maxLen && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
const parseKeywords = (v) => parseList(v, { max: MAX_KEYWORDS, maxLen: 60 });
// Sender pattern: address or pattern with * (like the mail sender rules), no blanks
const parseSenders = (v) => parseList(v, { max: MAX_SENDERS, maxLen: 254 }).filter((s) => !/\s/.test(s));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Keyword test: from 4 characters on also inside words ("drucker" finds "Netzwerkdrucker"),
 * short ones only as a whole word ("pc" must not match "pcie" or "epc").
 */
function keywordRegExp(word) {
  const e = escapeRe(word).replace(/ /g, '\\s+');
  return [...word].length >= 4 ? new RegExp(e, 'iu') : new RegExp(`(?<![\\p{L}\\p{N}])${e}(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Pure matching (also used by the test field): components in order (position), text and sender.
 * Sender patterns decide first (first component in order wins); otherwise the keyword score
 * (title hit 3, description hit 1, each keyword once); on a tie the earlier component wins.
 * Returns { component, kind: 'sender'|'keywords', words|pattern, score } or null.
 */
export function matchComponent(components, { title = '', description = '', sender = '' } = {}) {
  const addr = String(sender || '').trim().toLowerCase();
  if (addr) {
    for (const c of components) {
      const pattern = c.senders.find((p) => patternToRegExp(p).test(addr));
      if (pattern) return { component: c, kind: 'sender', pattern, score: null };
    }
  }
  const tt = String(title || '').slice(0, 300);
  const dd = String(description || '').slice(0, MATCH_TEXT_LIMIT);
  let best = null;
  for (const c of components) {
    let score = 0;
    const words = [];
    for (const w of c.keywords) {
      const re = keywordRegExp(w);
      const s = (re.test(tt) ? TITLE_WEIGHT : 0) + (re.test(dd) ? DESCRIPTION_WEIGHT : 0);
      if (s) { score += s; words.push(w); }
    }
    if (score && (!best || score > best.score)) best = { component: c, kind: 'keywords', words, score };
  }
  return best;
}

/** Text for the history: "Schlagwörter: vpn, forticlient" is built in the browser from kind + detail */
export function reasonDetail(m) {
  return m.kind === 'sender' ? m.pattern : (m.words || []).join(', ');
}

export function createComponents(db, users) {
  const out = (c) => ({
    id: c.id, projectId: c.project_id, name: c.name, description: c.description,
    leadId: c.lead_id, deputyId: c.deputy_id,
    lead: c.lead_id ? { id: c.lead_id, displayName: c.lead_name } : null,
    deputy: c.deputy_id ? { id: c.deputy_id, displayName: c.deputy_name } : null,
    keywords: c.keywords ? c.keywords.split('\n') : [], senders: c.senders ? c.senders.split('\n') : [],
    position: c.position, archived: !!c.archived,
    ticketCount: c.ticket_count ?? undefined, openCount: c.open_count ?? undefined,
  });
  const SELECT = `SELECT c.*, l.display_name lead_name, d.display_name deputy_name,
      (SELECT COUNT(*) FROM tickets t WHERE t.component_id=c.id) ticket_count,
      (SELECT COUNT(*) FROM tickets t WHERE t.component_id=c.id AND t.status<>'done') open_count
    FROM components c LEFT JOIN users l ON l.id=c.lead_id LEFT JOIN users d ON d.id=c.deputy_id`;

  function project(id) {
    const p = db.prepare('SELECT * FROM projects WHERE id=? OR key=?').get(int(id) || 0, str(id, 20).toUpperCase());
    if (!p) throw notFound();
    return p;
  }
  /** Lead/deputy: agents and admins only (they get the tickets) */
  function person(id, field) {
    if (id === null || id === undefined || id === '') return null;
    const n = int(id);
    const u = n ? users.byId(n) : null;
    if (!u || (u.role !== 'agent' && u.role !== 'admin')) throw new HttpError(400, 'err.badRequest', field);
    return n;
  }
  function raw(id) {
    const c = db.prepare(`${SELECT} WHERE c.id=?`).get(int(id) || 0);
    if (!c) throw notFound();
    return c;
  }

  function list(projectId, { includeArchived = false } = {}) {
    const p = project(projectId);
    return db.prepare(`${SELECT} WHERE c.project_id=? ${includeArchived ? '' : 'AND c.archived=0'} ORDER BY c.position, c.id`).all(p.id).map(out);
  }
  /** Active components of a project for matching (in order) */
  function active(projectId) {
    return db.prepare('SELECT * FROM components WHERE project_id=? AND archived=0 ORDER BY position, id').all(projectId).map((c) => ({
      id: c.id, name: c.name, description: c.description, leadId: c.lead_id, deputyId: c.deputy_id, projectId: c.project_id,
      keywords: c.keywords ? c.keywords.split('\n') : [], senders: c.senders ? c.senders.split('\n') : [],
    }));
  }
  /** Active components of all active projects (with project) – incoming mails are routed by them */
  function activeAll() {
    return db.prepare(`SELECT c.*, p.key project_key, p.name project_name FROM components c JOIN projects p ON p.id=c.project_id
      WHERE c.archived=0 AND p.archived=0 ORDER BY p.key, c.position, c.id`).all().map((c) => ({
      id: c.id, name: c.name, description: c.description, leadId: c.lead_id, deputyId: c.deputy_id, projectId: c.project_id,
      projectKey: c.project_key, projectName: c.project_name,
      keywords: c.keywords ? c.keywords.split('\n') : [], senders: c.senders ? c.senders.split('\n') : [],
    }));
  }
  /** Component by id (active, of an active project) or null */
  function activeById(id) { return activeAll().find((c) => c.id === (int(id) || 0)) || null; }
  function get(id) { return out(raw(id)); }

  /** Component of this project (active) or 400 – for ticket create/update */
  function forProject(projectId, id) {
    const c = db.prepare('SELECT * FROM components WHERE id=? AND project_id=? AND archived=0').get(int(id) || 0, projectId);
    if (!c) throw new HttpError(400, 'err.badRequest', 'componentId');
    return c;
  }

  function values(data, prev = null) {
    const name = data.name !== undefined ? str(data.name, 80).trim().replace(/\s+/g, ' ') : prev?.name;
    if (!name) throw new HttpError(400, 'err.componentName');
    return {
      name,
      description: data.description !== undefined ? str(data.description, 1000).trim() : (prev?.description ?? ''),
      lead_id: data.leadId !== undefined ? person(data.leadId, 'leadId') : (prev?.lead_id ?? null),
      deputy_id: data.deputyId !== undefined ? person(data.deputyId, 'deputyId') : (prev?.deputy_id ?? null),
      keywords: data.keywords !== undefined ? parseKeywords(data.keywords).join('\n') : (prev?.keywords ?? ''),
      senders: data.senders !== undefined ? parseSenders(data.senders).join('\n') : (prev?.senders ?? ''),
      archived: data.archived !== undefined ? (data.archived ? 1 : 0) : (prev?.archived ?? 0),
    };
  }
  const nameTaken = (projectId, name, exceptId = 0) => !!db.prepare('SELECT 1 FROM components WHERE project_id=? AND name=? AND id<>?').get(projectId, name, exceptId);

  function create(projectId, data = {}) {
    const p = project(projectId);
    if (db.prepare('SELECT COUNT(*) n FROM components WHERE project_id=?').get(p.id).n >= MAX_COMPONENTS) throw new HttpError(400, 'err.tooManyComponents');
    const v = values(data);
    if (nameTaken(p.id, v.name)) throw new HttpError(409, 'err.componentTaken');
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM components WHERE project_id=?').get(p.id).n;
    const info = db.prepare('INSERT INTO components(project_id,name,description,lead_id,deputy_id,keywords,senders,position,archived) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(p.id, v.name, v.description, v.lead_id, v.deputy_id, v.keywords, v.senders, pos, v.archived);
    return get(info.lastInsertRowid);
  }

  function update(id, data = {}) {
    const prev = raw(id);
    const v = values(data, prev);
    if (nameTaken(prev.project_id, v.name, prev.id)) throw new HttpError(409, 'err.componentTaken');
    db.prepare('UPDATE components SET name=?, description=?, lead_id=?, deputy_id=?, keywords=?, senders=?, archived=? WHERE id=?')
      .run(v.name, v.description, v.lead_id, v.deputy_id, v.keywords, v.senders, v.archived, prev.id);
    return get(prev.id);
  }

  /**
   * Delete: the field of its tickets becomes empty (ON DELETE SET NULL); each ticket gets the
   * same history entry as a manual component change, so the record shows what it was.
   */
  function remove(id, userId = null) {
    const c = raw(id);
    db.transaction(() => {
      db.prepare(`INSERT INTO activity(ticket_id,user_id,action,field,old_value,new_value)
        SELECT id, ?, 'changed', 'component', ?, NULL FROM tickets WHERE component_id=?`).run(userId, c.name, c.id);
      db.prepare('DELETE FROM components WHERE id=?').run(c.id);
    })();
    return { name: c.name, tickets: c.ticket_count };
  }

  /** New order: ids in the desired order (others keep their place behind them) */
  function reorder(projectId, ids) {
    const p = project(projectId);
    if (!Array.isArray(ids)) throw new HttpError(400, 'err.badRequest', 'ids');
    const own = db.prepare('SELECT id FROM components WHERE project_id=? ORDER BY position, id').all(p.id).map((r) => r.id);
    const wanted = [...new Set(ids.map((x) => int(x)).filter((x) => own.includes(x)))];
    const order = [...wanted, ...own.filter((x) => !wanted.includes(x))];
    const stmt = db.prepare('UPDATE components SET position=? WHERE id=?');
    db.transaction(() => order.forEach((cid, i) => stmt.run(i + 1, cid)))();
    return list(p.id, { includeArchived: true });
  }

  /** Take over example components (by key); existing names are skipped */
  function addExamples(projectId, keys, lang = 'de') {
    const p = project(projectId);
    const l = lang === 'en' ? 'en' : 'de';
    const wanted = new Set(Array.isArray(keys) ? keys.map(String) : []);
    const added = [];
    const skipped = [];
    db.transaction(() => {
      for (const set of EXAMPLES) {
        for (const ex of set.items) {
          if (!wanted.has(ex.key)) continue;
          const name = ex[l].name;
          // Already there (also under the name in the other language) → skip
          if (nameTaken(p.id, ex.de.name) || nameTaken(p.id, ex.en.name)) { skipped.push(name); continue; }
          added.push(create(p.id, { name, description: ex[l].description, keywords: ex.keywords }));
        }
      }
    })();
    return { added, skipped };
  }

  /** Test field: which component would a ticket get, and why */
  function test(projectId, { title, description, sender }) {
    const p = project(projectId);
    const m = matchComponent(active(p.id), { title: str(title, 300), description: str(description, MATCH_TEXT_LIMIT), sender: str(sender, 254) });
    if (!m) return { component: null };
    return { component: { id: m.component.id, name: m.component.name }, kind: m.kind, detail: reasonDetail(m), score: m.score };
  }

  return { list, active, activeAll, activeById, get, forProject, create, update, remove, reorder, addExamples, test, examples: () => EXAMPLES };
}

// ---------- Examples to take over ----------
// Keywords contain German and English terms, so the examples work for mixed mailboxes too.
export const EXAMPLES = [
  {
    key: 'it', de: 'IT-Support', en: 'IT support',
    items: [
      { key: 'it.workplace', de: { name: 'Arbeitsplatz & PC', description: 'Rechner, Notebooks, Monitore, Tastatur und Maus, Dockingstationen' }, en: { name: 'Workplace & PC', description: 'Computers, notebooks, monitors, keyboard and mouse, docking stations' },
        keywords: ['pc', 'rechner', 'computer', 'notebook', 'laptop', 'monitor', 'bildschirm', 'tastatur', 'keyboard', 'maus', 'mouse', 'dockingstation', 'docking', 'bluescreen', 'startet nicht', 'does not start'] },
      { key: 'it.printer', de: { name: 'Drucker & Scanner', description: 'Drucker, Multifunktionsgeräte, Scannen, Toner und Papierstau' }, en: { name: 'Printers & scanners', description: 'Printers, multifunction devices, scanning, toner and paper jams' },
        keywords: ['drucker', 'printer', 'drucken', 'print', 'scanner', 'scannen', 'scan', 'toner', 'papierstau', 'paper jam', 'kopierer', 'copier', 'multifunktion'] },
      { key: 'it.mail', de: { name: 'E-Mail & Kalender', description: 'Postfächer, Verteiler, Kalender, Abwesenheitsnotiz, Spam' }, en: { name: 'Email & calendar', description: 'Mailboxes, distribution lists, calendars, out-of-office, spam' },
        keywords: ['outlook', 'postfach', 'mailbox', 'kalender', 'calendar', 'verteiler', 'distribution list', 'abwesenheit', 'out of office', 'spam', 'phishing', 'thunderbird'] },
      { key: 'it.network', de: { name: 'Netzwerk & WLAN', description: 'Netzwerkdosen, WLAN, Internetzugang, Switches, langsame Verbindung' }, en: { name: 'Network & Wi-Fi', description: 'Network ports, Wi-Fi, internet access, switches, slow connections' },
        keywords: ['netzwerk', 'network', 'wlan', 'wifi', 'wi-fi', 'lan', 'internetzugang', 'switch', 'netzwerkdose', 'kein netz', 'no connection', 'keine verbindung', 'dns', 'dhcp', 'ip-adresse'] },
      { key: 'it.vpn', de: { name: 'VPN & Fernzugriff', description: 'VPN-Client, Homeoffice-Zugang, Remotedesktop' }, en: { name: 'VPN & remote access', description: 'VPN client, home office access, remote desktop' },
        keywords: ['vpn', 'forticlient', 'anyconnect', 'wireguard', 'openvpn', 'fernzugriff', 'remote access', 'homeoffice', 'home office', 'remotedesktop', 'remote desktop', 'rdp'] },
      { key: 'it.account', de: { name: 'Benutzerkonto & Kennwort', description: 'Anmeldung, Kennwort zurücksetzen, gesperrte Konten, Zwei-Faktor' }, en: { name: 'User account & password', description: 'Sign-in, password reset, locked accounts, two-factor' },
        keywords: ['kennwort', 'passwort', 'password', 'anmeldung', 'login', 'sign in', 'gesperrt', 'locked', 'konto', 'account', 'benutzerkonto', 'zwei-faktor', '2fa', 'mfa', 'authenticator'] },
      { key: 'it.phone', de: { name: 'Telefonie & Mobilgeräte', description: 'Festnetz, Headsets, Diensthandys, Tablets, Mobilfunk' }, en: { name: 'Telephony & mobile devices', description: 'Desk phones, headsets, company phones, tablets, mobile service' },
        keywords: ['telefonanlage', 'festnetz', 'desk phone', 'headset', 'handy', 'smartphone', 'iphone', 'android', 'tablet', 'ipad', 'sim', 'mobilfunk', 'durchwahl', 'voicemail', 'anrufbeantworter'] },
      { key: 'it.software', de: { name: 'Software & Lizenzen', description: 'Installation, Updates, Fachanwendungen, Office, Lizenzen' }, en: { name: 'Software & licences', description: 'Installation, updates, business applications, Office, licences' },
        keywords: ['software', 'programm', 'installation', 'installieren', 'install', 'update', 'lizenz', 'license', 'licence', 'microsoft 365', 'ms office', 'excel', 'powerpoint', 'teams', 'adobe', 'acrobat'] },
      { key: 'it.server', de: { name: 'Server & Speicher', description: 'Netzlaufwerke, Dateifreigaben, Sicherung, Server-Dienste' }, en: { name: 'Servers & storage', description: 'Network drives, file shares, backups, server services' },
        keywords: ['server', 'netzlaufwerk', 'network drive', 'laufwerk', 'freigabe', 'share', 'speicher', 'storage', 'datensicherung', 'backup', 'wiederherstellen', 'restore', 'speicherplatz', 'quota', 'nas'] },
      { key: 'it.web', de: { name: 'Webseite & Intranet', description: 'Öffentliche Webseite, Intranet, Inhalte und Zugriffe' }, en: { name: 'Website & intranet', description: 'Public website, intranet, content and access' },
        keywords: ['webseite', 'website', 'homepage', 'intranet', 'wiki', 'cms', 'wordpress', 'typo3', 'sharepoint', 'zertifikat', 'certificate', 'ssl'] },
    ],
  },
  {
    key: 'facility', de: 'Haustechnik', en: 'Facilities',
    items: [
      { key: 'fac.heating', de: { name: 'Heizung & Klima', description: 'Heizung, Lüftung, Klimaanlage, Raumtemperatur' }, en: { name: 'Heating & air conditioning', description: 'Heating, ventilation, air conditioning, room temperature' },
        keywords: ['heizung', 'heating', 'heizkörper', 'radiator', 'thermostat', 'klima', 'klimaanlage', 'air conditioning', 'lüftung', 'ventilation', 'zu kalt', 'too cold', 'zu warm', 'too warm', 'temperatur', 'kalt im', 'friere', 'warm im', 'zugluft', 'fenster klemmt'] },
      { key: 'fac.electric', de: { name: 'Elektrik & Licht', description: 'Steckdosen, Beleuchtung, Sicherungen, Stromausfall' }, en: { name: 'Electrics & lighting', description: 'Sockets, lighting, fuses, power cuts' },
        keywords: ['steckdose', 'socket', 'licht', 'light', 'lampe', 'lamp', 'leuchte', 'leuchtmittel', 'glühbirne', 'bulb', 'neonröhre', 'beleuchtung', 'lighting', 'strom', 'stromausfall', 'power cut', 'sicherung', 'fuse', 'fi-schalter', 'verlängerungskabel', 'kabeltrommel', 'jalousie', 'rollladen', 'blinds'] },
      { key: 'fac.locks', de: { name: 'Schließanlage & Schlüssel', description: 'Schlüssel, Transponder, Türen, Zutrittsrechte' }, en: { name: 'Locks & keys', description: 'Keys, transponders, doors, access rights' },
        keywords: ['schlüssel', 'transponder', 'schließanlage', 'locking system', 'schließzylinder', 'tür', 'door', 'türschloss', 'türöffner', 'klemmt', 'zutritt', 'access card', 'ausweis', 'badge', 'schließfach', 'locker', 'ausgesperrt', 'locked out'] },
      { key: 'fac.rooms', de: { name: 'Räume & Möbel', description: 'Büros, Besprechungsräume, Möbel, Umzüge, Reinigung' }, en: { name: 'Rooms & furniture', description: 'Offices, meeting rooms, furniture, moves, cleaning' },
        keywords: ['büro', 'besprechungsraum', 'meeting room', 'raumbuchung', 'möbel', 'furniture', 'stuhl', 'chair', 'bürostuhl', 'schreibtisch', 'desk', 'regal', 'shelf', 'schrank', 'cupboard', 'umzug', 'office move', 'aufbauen', 'abbauen'] },
      { key: 'fac.water', de: { name: 'Sanitär & Wasser', description: 'Toiletten, Waschbecken, Wasserhähne, Rohre, Wasserschaden' }, en: { name: 'Plumbing & water', description: 'Toilets, sinks, taps, pipes, water damage' },
        keywords: ['toilette', 'toilet', 'wc', 'klo', 'waschbecken', 'sink', 'wasserhahn', 'tap', 'faucet', 'abfluss', 'drain', 'verstopft', 'blocked', 'rohr', 'pipe', 'leck', 'leak', 'tropft', 'dripping', 'wasserschaden', 'water damage', 'warmwasser', 'hot water', 'spülmaschine', 'dishwasher', 'kaffeemaschine', 'coffee machine'] },
      { key: 'fac.cleaning', de: { name: 'Reinigung & Abfall', description: 'Reinigung, Hygieneartikel, Müll, Entsorgung' }, en: { name: 'Cleaning & waste', description: 'Cleaning, hygiene supplies, rubbish, disposal' },
        keywords: ['reinigung', 'cleaning', 'putzen', 'sauber', 'dreckig', 'dirty', 'verschmutzt', 'müll', 'rubbish', 'garbage', 'trash', 'mülleimer', 'abfall', 'waste', 'entsorgung', 'disposal', 'seife', 'soap', 'papierhandtücher', 'paper towels', 'toilettenpapier', 'toilet paper', 'ungeziefer', 'pests'] },
      { key: 'fac.building', de: { name: 'Gebäude & Außenanlagen', description: 'Aufzug, Fenster, Dach, Parkplatz, Fahrradständer, Winterdienst' }, en: { name: 'Building & grounds', description: 'Lift, windows, roof, car park, bike racks, winter service' },
        keywords: ['aufzug', 'fahrstuhl', 'lift', 'elevator', 'fenster', 'window', 'dach', 'roof', 'decke', 'ceiling', 'wand', 'wall', 'boden', 'floor', 'parkplatz', 'car park', 'parking', 'tiefgarage', 'fahrrad', 'bike', 'winterdienst', 'schnee', 'snow', 'glatteis', 'ice', 'garten', 'hecke', 'rasen'] },
      { key: 'fac.safety', de: { name: 'Sicherheit & Brandschutz', description: 'Rauchmelder, Feuerlöscher, Notausgänge, Alarmanlage, Erste Hilfe' }, en: { name: 'Safety & fire protection', description: 'Smoke detectors, fire extinguishers, emergency exits, alarm system, first aid' },
        keywords: ['rauchmelder', 'smoke detector', 'feuerlöscher', 'fire extinguisher', 'brandschutz', 'fire protection', 'brandmelder', 'fire alarm', 'notausgang', 'emergency exit', 'fluchtweg', 'escape route', 'alarmanlage', 'alarm system', 'einbruch', 'burglary', 'erste hilfe', 'first aid', 'verbandskasten', 'defibrillator', 'notbeleuchtung'] },
    ],
  },
  {
    key: 'admin', de: 'Verwaltung / Service', en: 'Administration / service',
    items: [
      { key: 'adm.access', de: { name: 'Zugänge & Berechtigungen', description: 'Neue Zugänge, Gruppen, Ordnerrechte, Rollen in Anwendungen' }, en: { name: 'Access & permissions', description: 'New accounts, groups, folder permissions, roles in applications' },
        keywords: ['berechtigung', 'permission', 'zugriff', 'access', 'zugang', 'freischaltung', 'freischalten', 'gruppe', 'group', 'rolle', 'role', 'ordnerrechte', 'rechte', 'rights'] },
      { key: 'adm.purchase', de: { name: 'Beschaffung', description: 'Bestellungen von Hardware, Software und Zubehör' }, en: { name: 'Procurement', description: 'Ordering hardware, software and accessories' },
        keywords: ['bestellung', 'purchase order', 'bestellen', 'beschaffung', 'procurement', 'purchase', 'kaufen', 'buy', 'angebot', 'quote', 'rechnung', 'invoice', 'neues gerät', 'new device'] },
      { key: 'adm.people', de: { name: 'Personal / On-/Offboarding', description: 'Neue und ausscheidende Mitarbeitende, Namensänderungen, Abteilungswechsel' }, en: { name: 'People / on-/offboarding', description: 'New and leaving staff, name changes, department moves' },
        keywords: ['onboarding', 'offboarding', 'neuer mitarbeiter', 'neue mitarbeiterin', 'new employee', 'new starter', 'eintritt', 'austritt', 'leaver', 'ausscheiden', 'namensänderung', 'name change', 'abteilungswechsel', 'praktikant', 'hilfskraft', 'gastwissenschaftler', 'visiting researcher', 'vertragsende', 'elternzeit', 'parental leave'] },
      { key: 'adm.finance', de: { name: 'Finanzen & Reisekosten', description: 'Rechnungen, Reisekosten, Erstattungen, Kostenstellen' }, en: { name: 'Finance & travel expenses', description: 'Invoices, travel expenses, reimbursements, cost centres' },
        keywords: ['reisekosten', 'travel expenses', 'dienstreise', 'business trip', 'erstattung', 'reimbursement', 'abrechnung', 'kostenstelle', 'cost centre', 'cost center', 'buchhaltung', 'accounting', 'zahlung', 'payment', 'mahnung', 'reminder notice', 'budget', 'drittmittel'] },
      { key: 'adm.events', de: { name: 'Veranstaltungen & Medientechnik', description: 'Seminare, Tagungen, Beamer, Mikrofone, Videokonferenzen in Räumen' }, en: { name: 'Events & media technology', description: 'Seminars, conferences, projectors, microphones, room video conferencing' },
        keywords: ['veranstaltung', 'event', 'tagung', 'konferenz', 'conference', 'seminar', 'workshop', 'catering', 'beamer', 'projector', 'leinwand', 'screen', 'mikrofon', 'microphone', 'lautsprecher', 'speaker', 'videokonferenz', 'video conference', 'hybrid', 'raumtechnik', 'medientechnik'] },
    ],
  },
];
