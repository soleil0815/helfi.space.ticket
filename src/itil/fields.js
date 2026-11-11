// Extra fields per ticket type (problem, change). Only agents read and change them.
import { HttpError, forbidden, str } from '../lib/http.js';
import { isAgent, agentOn } from '../auth/session.js';

// name → { type: 'text' | 'bool' | 'enum' | 'datetime', max, values }
export const FIELD_DEFS = {
  problem: {
    rootCause: { type: 'text', max: 20000 },
    workaround: { type: 'text', max: 20000 },
    knownError: { type: 'bool' },
  },
  change: {
    changeType: { type: 'enum', values: ['standard', 'normal', 'emergency'] },
    phase: { type: 'enum', values: ['draft', 'approval', 'approved', 'rejected', 'scheduled', 'implementing', 'review', 'closed'], internal: true },
    reason: { type: 'text', max: 20000 },
    risk: { type: 'enum', values: ['low', 'medium', 'high'] },
    services: { type: 'text', max: 2000 },
    plannedStart: { type: 'datetime' },
    plannedEnd: { type: 'datetime' },
    implementationPlan: { type: 'text', max: 50000 },
    backoutPlan: { type: 'text', max: 50000 },
    testPlan: { type: 'text', max: 20000 },
    outcome: { type: 'enum', values: ['successful', 'issues', 'rolledBack'], internal: true },
    review: { type: 'text', max: 20000 },
  },
};

export function createFields(db, tickets) {
  const getAll = db.prepare('SELECT name, value FROM ticket_fields WHERE ticket_id=?');
  const upsert = db.prepare(`INSERT INTO ticket_fields(ticket_id, name, value) VALUES(?,?,?)
    ON CONFLICT(ticket_id, name) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

  function read(ticketId, type) {
    const defs = FIELD_DEFS[type] || {};
    const raw = Object.fromEntries(getAll.all(ticketId).map((r) => [r.name, r.value]));
    const out = {};
    for (const [name, d] of Object.entries(defs)) {
      const v = raw[name];
      out[name] = d.type === 'bool' ? v === '1' : (v ?? '');
    }
    return out;
  }

  function normalize(d, v) {
    if (d.type === 'bool') return v ? '1' : '0';
    if (d.type === 'enum') { if (v && !d.values.includes(v)) throw new HttpError(400, 'err.badRequest'); return v || ''; }
    if (d.type === 'datetime') { if (v && Number.isNaN(Date.parse(v))) throw new HttpError(400, 'err.badRequest'); return v ? new Date(v).toISOString() : ''; }
    return str(v, d.max || 20000);
  }

  /** Change fields; history entry per changed field (long texts without content) */
  function update(user, key, data = {}, { allowed = null } = {}) {
    if (!isAgent(user)) throw forbidden();
    const row = tickets.load(user, key);
    if (!agentOn(user, row.project_id)) throw forbidden();
    const defs = FIELD_DEFS[row.type];
    if (!defs) throw new HttpError(400, 'err.badRequest', 'type');
    const before = read(row.id, row.type);
    db.transaction(() => {
      for (const [name, value] of Object.entries(data)) {
        const d = defs[name];
        if (!d || (allowed && !allowed.includes(name)) || (d.internal && !allowed)) continue;
        const v = normalize(d, value);
        const old = d.type === 'bool' ? (before[name] ? '1' : '0') : before[name];
        if (String(old) === String(v)) continue;
        upsert.run(row.id, name, v);
        if (d.type === 'text') tickets.logActivity(row.id, user.id, 'changed', name);
        else tickets.logActivity(row.id, user.id, 'changed', name, old || null, v || null);
      }
      db.prepare("UPDATE tickets SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id);
    })();
    return read(row.id, row.type);
  }

  tickets.addDetailExtra((user, row) => (agentOn(user, row.project_id) && FIELD_DEFS[row.type] ? { fields: read(row.id, row.type) } : {}));

  return { read, update, defs: FIELD_DEFS };
}
