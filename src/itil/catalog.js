// Servicekatalog: Angebote mit Formular; optional Genehmigung vor der Bearbeitung.
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent } from '../auth/session.js';
import { log } from '../lib/log.js';

export const FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'date'];

export function createCatalog(db, tickets, approvals, fieldsStore, settings, { mailer = null, users = null, baseUrl = '', t = null } = {}) {
  const parse = (j, d) => { try { const v = JSON.parse(j); return v ?? d; } catch { return d; } };
  const out = (r, admin = false) => ({
    id: r.id, title: r.title, description: r.description, emoji: r.emoji, fields: parse(r.fields, []),
    needsApproval: !!r.approver_ids, active: !!r.active,
    ...(admin ? { projectKey: r.project_key, approverIds: r.approver_ids.split(',').map(Number).filter(Boolean), approvalMode: r.approval_mode, sort: r.sort } : {}),
  });

  function list(user, { all = false } = {}) {
    const admin = all && user.role === 'admin';
    return db.prepare(`SELECT * FROM catalog_items ${admin ? '' : 'WHERE active=1'} ORDER BY sort, title`).all().map((r) => out(r, admin));
  }
  function get(user, id) {
    const r = db.prepare('SELECT * FROM catalog_items WHERE id=?').get(int(id) || 0);
    if (!r || (!r.active && user.role !== 'admin')) throw notFound();
    return out(r, user.role === 'admin');
  }

  function cleanFields(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 30).map((f, i) => {
      const type = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
      const label = str(f?.label, 200).trim();
      if (!label) throw new HttpError(400, 'err.catalogField');
      const options = type === 'select' ? (Array.isArray(f.options) ? f.options : String(f.options || '').split('\n')).map((o) => str(o, 200).trim()).filter(Boolean).slice(0, 50) : undefined;
      if (type === 'select' && !options.length) throw new HttpError(400, 'err.catalogField');
      return { id: str(f?.id, 40).replace(/[^\w-]/g, '') || `f${i + 1}`, label, type, required: !!f?.required, ...(options ? { options } : {}) };
    });
  }
  function save(user, id, data) {
    if (user.role !== 'admin') throw forbidden();
    const title = str(data.title, 120).trim();
    if (!title) throw new HttpError(400, 'err.titleRequired');
    const approverIds = (Array.isArray(data.approverIds) ? data.approverIds : []).map(Number).filter((x) => users?.byId(x)?.active);
    const vals = [title, str(data.description, 4000), str(data.emoji, 16), str(data.projectKey, 10).toUpperCase(), JSON.stringify(cleanFields(data.fields)),
      approverIds.join(','), data.approvalMode === 'all' ? 'all' : 'any', data.active === false ? 0 : 1, int(data.sort) || 0];
    if (id) {
      if (!db.prepare('SELECT 1 FROM catalog_items WHERE id=?').get(int(id))) throw notFound();
      db.prepare('UPDATE catalog_items SET title=?, description=?, emoji=?, project_key=?, fields=?, approver_ids=?, approval_mode=?, active=?, sort=? WHERE id=?').run(...vals, int(id));
      return get(user, id);
    }
    const nid = db.prepare('INSERT INTO catalog_items(title, description, emoji, project_key, fields, approver_ids, approval_mode, active, sort) VALUES(?,?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid;
    return get(user, nid);
  }
  function remove(user, id) {
    if (user.role !== 'admin') throw forbidden();
    db.prepare('DELETE FROM catalog_items WHERE id=?').run(int(id) || 0);
  }

  /** Anfrage aus dem Katalog: Antworten prüfen, Ticket anlegen, ggf. Genehmigung anfragen */
  function order(user, id, answers = {}) {
    if (!isAgent(user) && !settings.get('general.allowSelfService')) throw new HttpError(403, 'err.selfServiceOff');
    const r = db.prepare('SELECT * FROM catalog_items WHERE id=? AND active=1').get(int(id) || 0);
    if (!r) throw notFound();
    const fields = parse(r.fields, []);
    const lines = [];
    for (const f of fields) {
      let v = answers?.[f.id];
      if (f.type === 'checkbox') v = v ? '✔' : '';
      else v = str(v, f.type === 'textarea' ? 10000 : 500).trim();
      if (f.type === 'select' && v && !f.options.includes(v)) throw new HttpError(400, 'err.badRequest', f.id);
      if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'err.badRequest', f.id);
      if (f.required && !v) throw new HttpError(400, 'err.catalogRequired', f.label);
      if (v) lines.push(f.type === 'textarea' ? `**${f.label}:**\n${v}` : `**${f.label}:** ${v}`);
    }
    const project = r.project_key ? tickets.projects.get(r.project_key) : null;
    const first = fields.find((f) => f.type === 'text' && answers?.[f.id]);
    const title = first ? `${r.title}: ${str(answers[first.id], 120)}` : r.title;
    const tk = tickets.create(user, { title, description: lines.join('\n\n'), type: 'request', projectId: project?.id }, { source: 'web' });
    db.prepare("INSERT INTO ticket_fields(ticket_id, name, value) VALUES(?, 'catalogItem', ?)").run(tk.id, String(r.id));
    const ids = approvals.approverUsers(r.approver_ids.split(',').filter(Boolean)).map((u) => u.id).filter((x) => x !== user.id);
    if (ids.length) {
      approvals.request(tk.id, ids);
      db.prepare("INSERT INTO ticket_fields(ticket_id, name, value) VALUES(?, 'approvalState', 'pending'), (?, 'approvalMode', ?)").run(tk.id, tk.id, r.approval_mode);
      tickets.logActivity(tk.id, null, 'approvalRequested', null, null, String(ids.length));
      for (const aid of ids) notify(users?.byId(aid), 'mail.catalogApproval.subject', 'mail.catalogApproval.body', tk, { requester: user.display_name || user.username });
    }
    return tickets.detail(user, tk.id);
  }

  const fieldOf = (ticketId, name) => db.prepare('SELECT value FROM ticket_fields WHERE ticket_id=? AND name=?').get(ticketId, name)?.value;
  const setField = (ticketId, name, value) => db.prepare(`INSERT INTO ticket_fields(ticket_id, name, value) VALUES(?,?,?)
    ON CONFLICT(ticket_id, name) DO UPDATE SET value=excluded.value`).run(ticketId, name, value);

  /** Entscheidung über eine Katalog-Anfrage */
  function decide(user, key, decision, comment) {
    const row = tickets.load(user, key);
    if (fieldOf(row.id, 'approvalState') !== 'pending') throw new HttpError(400, 'err.alreadyDecided');
    approvals.decide(user, row.id, decision, comment);
    tickets.logActivity(row.id, user.id, 'approval', decision, null, str(comment, 200) || null);
    const result = approvals.outcome(row.id, fieldOf(row.id, 'approvalMode') || 'any');
    if (result === 'approved' || result === 'rejected') {
      setField(row.id, 'approvalState', result);
      const msgKey = result === 'approved' ? 'catalog.approvedNote' : 'catalog.rejectedNote';
      const lang = settings.get('general.defaultLanguage');
      const text = `${t ? t(lang, msgKey) : result}${comment ? `\n\n„${str(comment, 2000)}“` : ''}`;
      // Antwort an den Melder (Mail wie jede Antwort); bei Ablehnung erledigt
      tickets.addComment(user, row.id, { body: text }, { skipPermission: true });
      if (result === 'rejected') tickets.update({ ...user, role: 'agent' }, row.id, { status: 'done' }, { quietResolved: true });
    }
    return tickets.detail(user, row.id);
  }

  async function send(to, subjectKey, bodyKey, tk, extra) {
    if (!mailer?.enabled?.() || !t || !to?.email || !to.active) return;
    const lang = to.language || settings.get('general.defaultLanguage');
    const vars = { key: tk.key, title: tk.title, link: `${baseUrl}/browse/${tk.key}`, app: settings.get('general.title') || 'Helfi.Space', ...extra };
    await mailer.send({ to: to.email, subject: t(lang, subjectKey, vars), text: t(lang, bodyKey, vars), ticketId: tk.id });
  }
  const notify = (...a) => send(...a).catch((e) => log.warn('Genehmigungs-Mail fehlgeschlagen', { error: e.message }));

  tickets.addDetailExtra((user, row) => {
    const state = fieldOf(row.id, 'approvalState');
    if (!state || row.type === 'change') return {};
    return { approval: { state, items: approvals.current(row.id).items, mode: fieldOf(row.id, 'approvalMode') || 'any', canDecide: state === 'pending' && approvals.isPendingApprover(row.id, user.id) } };
  });

  return { list, get, save, remove, order, decide, fieldOf };
}
