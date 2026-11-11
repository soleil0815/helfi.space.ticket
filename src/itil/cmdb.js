// Devices and services (lightweight CI registry): entries, links to tickets, history, CSV import.
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent, agentOn, projectScopeSql } from '../auth/session.js';

export const CI_KINDS = ['device', 'server', 'network', 'printer', 'phone', 'service', 'application', 'other'];
export const CI_STATUS = ['active', 'maintenance', 'retired'];
const MAX_PER_TICKET = 30;
const MAX_IMPORT = 5000;

// Column names and values as they typically appear in exports (de/en)
const COLUMNS = {
  name: ['name', 'hostname', 'gerät', 'geraet', 'bezeichnung', 'device', 'computer', 'computername'],
  kind: ['kind', 'type', 'typ', 'art', 'kategorie', 'category'],
  status: ['status', 'zustand', 'state'],
  location: ['location', 'standort', 'ort', 'raum', 'room'],
  owner: ['owner', 'user', 'benutzer', 'verantwortlich', 'nutzer', 'besitzer', 'email', 'e-mail'],
  ip: ['ip', 'ip-adresse', 'ipaddress', 'ip address', 'adresse'],
  serial: ['serial', 'seriennummer', 'serialnumber', 'serial number', 'sn'],
  vendor: ['vendor', 'hersteller', 'manufacturer'],
  model: ['model', 'modell'],
  description: ['description', 'beschreibung', 'notiz', 'notes', 'bemerkung'],
};
const KIND_WORDS = {
  device: ['device', 'gerät', 'geraet', 'pc', 'client', 'notebook', 'laptop', 'desktop', 'workstation', 'computer', 'arbeitsplatz'],
  server: ['server', 'vm', 'virtuelle maschine', 'host'],
  network: ['network', 'netzwerk', 'switch', 'router', 'firewall', 'access point', 'ap', 'wlan'],
  printer: ['printer', 'drucker', 'multifunktionsgerät', 'mfp', 'scanner'],
  phone: ['phone', 'telefon', 'handy', 'smartphone', 'mobiltelefon', 'tablet'],
  service: ['service', 'dienst', 'it-service'],
  application: ['application', 'anwendung', 'software', 'app', 'programm'],
};
const STATUS_WORDS = { active: ['active', 'aktiv', 'in betrieb', ''], maintenance: ['maintenance', 'wartung', 'reparatur', 'defekt'], retired: ['retired', 'ausgemustert', 'stillgelegt', 'entsorgt', 'inaktiv'] };
const lookup = (words, v, def) => {
  const x = String(v ?? '').trim().toLowerCase();
  return Object.keys(words).find((k) => k === x || words[k].includes(x)) || def;
};

/** Read CSV rows: separator ; , or tab, quotes as in Excel */
export function parseCsv(text) {
  // Strings only: the loop below runs over its length (never over a user-supplied object)
  if (typeof text !== 'string') return [];
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const sep = [';', '\t', ','].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export function createCmdb(db, tickets, users) {
  const SELECT = `SELECT c.*, u.display_name owner_name, u.email owner_email,
    (SELECT COUNT(*) FROM ticket_cis x JOIN tickets t ON t.id=x.ticket_id WHERE x.ci_id=c.id AND t.status<>'done') open_tickets,
    (SELECT COUNT(*) FROM ticket_cis x WHERE x.ci_id=c.id) all_tickets
    FROM config_items c LEFT JOIN users u ON u.id=c.owner_id`;
  const out = (c) => ({
    id: c.id, name: c.name, kind: c.kind, status: c.status, location: c.location, ip: c.ip, serial: c.serial, vendor: c.vendor, model: c.model,
    description: c.description, owner: c.owner_id ? { id: c.owner_id, displayName: c.owner_name, email: c.owner_email } : null,
    openTickets: c.open_tickets, totalTickets: c.all_tickets, updatedAt: c.updated_at,
  });
  const need = (user) => { if (!isAgent(user)) throw forbidden(); };

  function list(user, { q = '', kind = '', status = '', limit = 500 } = {}) {
    need(user);
    const where = []; const args = [];
    if (kind && CI_KINDS.includes(kind)) { where.push('c.kind=?'); args.push(kind); }
    if (status === 'all') { /* everything */ } else if (CI_STATUS.includes(status)) { where.push('c.status=?'); args.push(status); } else where.push("c.status<>'retired'");
    for (const w of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
      where.push("(c.name LIKE ? ESCAPE '\\' OR c.location LIKE ? ESCAPE '\\' OR c.ip LIKE ? ESCAPE '\\' OR c.serial LIKE ? ESCAPE '\\' OR c.model LIKE ? ESCAPE '\\' OR c.vendor LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
      const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      args.push(like, like, like, like, like, like, like);
    }
    return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name LIMIT ?`).all(...args, Math.min(int(limit) || 500, 2000)).map(out);
  }

  function get(user, id) {
    need(user);
    const c = db.prepare(`${SELECT} WHERE c.id=?`).get(int(id) || 0);
    if (!c) throw notFound();
    // Ticket history of the device: only tickets of the agent's projects
    const ps = projectScopeSql(user);
    const history = db.prepare(`SELECT t.*, p.key project_key FROM ticket_cis x JOIN tickets t ON t.id=x.ticket_id JOIN projects p ON p.id=t.project_id
      WHERE x.ci_id=? AND ${ps.sql} ORDER BY t.created_at DESC LIMIT 500`).all(c.id, ...ps.args)
      .map((t) => ({ key: `${t.project_key}-${t.number}`, title: t.title, type: t.type, status: t.status, priority: t.priority, createdAt: t.created_at, resolvedAt: t.resolved_at }));
    return { ...out(c), history };
  }

  function clean(data, { partial = false, current = {} } = {}) {
    const v = (k, max) => (data[k] === undefined && partial ? current[k] ?? '' : str(data[k], max).trim());
    const name = v('name', 120);
    if (!name) throw new HttpError(400, 'err.ciName');
    let ownerId = data.ownerId === undefined && partial ? current.owner_id ?? null : int(data.ownerId) || null;
    if (ownerId && !users.byId(ownerId)) ownerId = null;
    return {
      name, kind: CI_KINDS.includes(data.kind) ? data.kind : (partial ? current.kind : 'device') || 'device',
      status: CI_STATUS.includes(data.status) ? data.status : (partial ? current.status : 'active') || 'active',
      location: v('location', 200), ip: v('ip', 100), serial: v('serial', 100), vendor: v('vendor', 100), model: v('model', 100),
      description: v('description', 4000), owner_id: ownerId,
    };
  }
  const dupe = (name, id = 0) => { if (db.prepare('SELECT 1 FROM config_items WHERE name=? AND id<>?').get(name, id)) throw new HttpError(409, 'err.ciExists', name); };

  function create(user, data) {
    need(user);
    const c = clean(data || {});
    dupe(c.name);
    const id = db.prepare(`INSERT INTO config_items(name, kind, status, location, owner_id, ip, serial, vendor, model, description)
      VALUES(@name, @kind, @status, @location, @owner_id, @ip, @serial, @vendor, @model, @description)`).run(c).lastInsertRowid;
    return get(user, id);
  }
  function update(user, id, data) {
    need(user);
    const cur = db.prepare('SELECT * FROM config_items WHERE id=?').get(int(id) || 0);
    if (!cur) throw notFound();
    const c = clean(data || {}, { partial: true, current: cur });
    dupe(c.name, cur.id);
    db.prepare(`UPDATE config_items SET name=@name, kind=@kind, status=@status, location=@location, owner_id=@owner_id, ip=@ip, serial=@serial,
      vendor=@vendor, model=@model, description=@description, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run({ ...c, id: cur.id });
    return get(user, cur.id);
  }
  /** Delete only without tickets – otherwise the history would be lost; set "retired" instead */
  function remove(user, id) {
    if (user.role !== 'admin') throw forbidden();
    const c = db.prepare('SELECT id FROM config_items WHERE id=?').get(int(id) || 0);
    if (!c) throw notFound();
    if (db.prepare('SELECT 1 FROM ticket_cis WHERE ci_id=?').get(c.id)) throw new HttpError(409, 'err.ciInUse');
    db.prepare('DELETE FROM config_items WHERE id=?').run(c.id);
  }

  // ---------- Tickets ----------
  const forTicket = (ticketId) => db.prepare(`${SELECT} JOIN ticket_cis x ON x.ci_id=c.id WHERE x.ticket_id=? ORDER BY c.name`).all(ticketId).map(out);

  function link(user, key, { ciId, name } = {}) {
    need(user);
    const row = tickets.load(user, key);
    if (!agentOn(user, row.project_id)) throw forbidden();
    const c = ciId ? db.prepare('SELECT * FROM config_items WHERE id=?').get(int(ciId) || 0) : db.prepare('SELECT * FROM config_items WHERE name=?').get(str(name, 120).trim());
    if (!c) throw notFound();
    if (db.prepare('SELECT 1 FROM ticket_cis WHERE ticket_id=? AND ci_id=?').get(row.id, c.id)) return forTicket(row.id);
    if (db.prepare('SELECT COUNT(*) n FROM ticket_cis WHERE ticket_id=?').get(row.id).n >= MAX_PER_TICKET) throw new HttpError(400, 'err.ciLimit');
    db.prepare('INSERT INTO ticket_cis(ticket_id, ci_id) VALUES(?,?)').run(row.id, c.id);
    tickets.logActivity(row.id, user.id, 'ciLinked', null, null, c.name);
    return forTicket(row.id);
  }
  function unlink(user, key, ciId) {
    need(user);
    const row = tickets.load(user, key);
    if (!agentOn(user, row.project_id)) throw forbidden();
    const c = db.prepare('SELECT name FROM config_items WHERE id=?').get(int(ciId) || 0);
    if (c && db.prepare('DELETE FROM ticket_cis WHERE ticket_id=? AND ci_id=?').run(row.id, int(ciId)).changes) {
      tickets.logActivity(row.id, user.id, 'ciUnlinked', null, c.name, null);
    }
    return forTicket(row.id);
  }

  tickets.addDetailExtra((user, row) => (agentOn(user, row.project_id) ? { cis: forTicket(row.id) } : {}));

  // ---------- CSV import ----------
  function importCsv(user, text) {
    if (user.role !== 'admin') throw forbidden();
    const rows = parseCsv(text);
    if (rows.length < 2) throw new HttpError(400, 'err.ciImportEmpty');
    if (rows.length - 1 > MAX_IMPORT) throw new HttpError(400, 'err.ciImportTooMany', String(MAX_IMPORT));
    const head = rows[0].map((x) => x.trim().toLowerCase());
    const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, head.findIndex((x) => x === k || names.includes(x))]));
    if (col.name < 0) throw new HttpError(400, 'err.ciImportNoName');
    const result = { created: 0, updated: 0, errors: [] };
    const byName = db.prepare('SELECT * FROM config_items WHERE name=?');
    const ownerOf = (v) => {
      const x = String(v || '').trim();
      if (!x) return null;
      const u = x.includes('@') ? users.byEmail(x) : users.byName(x);
      return u?.id || null;
    };
    const run = db.transaction(() => {
      rows.slice(1).forEach((r, i) => {
        const cell = (k) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : undefined);
        try {
          const name = str(cell('name'), 120).trim();
          if (!name) throw new HttpError(400, 'err.ciName');
          const data = { name };
          for (const k of ['location', 'ip', 'serial', 'vendor', 'model', 'description']) if (col[k] >= 0) data[k] = cell(k);
          if (col.kind >= 0) data.kind = lookup(KIND_WORDS, cell('kind'), 'other');
          if (col.status >= 0) data.status = lookup(STATUS_WORDS, cell('status'), 'active');
          if (col.owner >= 0) data.ownerId = ownerOf(cell('owner'));
          const cur = byName.get(name);
          if (cur) { update(user, cur.id, data); result.updated++; } else { create(user, data); result.created++; }
        } catch (e) {
          if (result.errors.length < 50) result.errors.push({ line: i + 2, error: e.code || e.message, detail: e.detail || null });
        }
      });
    });
    run();
    return result;
  }

  return { list, get, create, update, remove, link, unlink, forTicket, importCsv };
}
