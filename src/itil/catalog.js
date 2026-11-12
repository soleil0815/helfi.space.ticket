// Service catalog: offerings with a form; optional approval before processing.
import { HttpError, notFound, forbidden, str, int } from '../lib/http.js';
import { isAgent } from '../auth/session.js';
import { log } from '../lib/log.js';

export const FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'date'];

export function createCatalog(db, tickets, approvals, fieldsStore, settings, { mailer = null, users = null, baseUrl = '', t = null } = {}) {
  const parse = (j, d) => { try { const v = JSON.parse(j); return v ?? d; } catch { return d; } };
  const projectByKey = (key) => (key ? db.prepare('SELECT id, key, name FROM projects WHERE key=? AND archived=0').get(key) : null);
  /**
   * Projects whose service offerings this person may create and edit: admins all active projects,
   * otherwise only those they lead or stand in for. Other agents of a project may not.
   */
  function manageable(user) {
    if (!user) return [];
    if (user.role === 'admin') return db.prepare('SELECT id, key, name FROM projects WHERE archived=0 ORDER BY name').all();
    return db.prepare('SELECT id, key, name FROM projects WHERE archived=0 AND (lead_id=? OR deputy_id=?) ORDER BY name').all(user.id, user.id);
  }
  const managedKeys = (user) => new Set(manageable(user).map((p) => p.key));
  /** May edit this row: admins always, leads/deputies only offerings of their own projects */
  const canEdit = (user, r, keys = managedKeys(user)) => user?.role === 'admin' || (!!projectByKey(r.project_key) && keys.has(r.project_key));
  const approverRefs = (ids) => ids.map((x) => users?.byId(x)).filter(Boolean).map((u) => ({ id: u.id, displayName: u.display_name }));
  const out = (r, manage = false) => {
    const p = projectByKey(r.project_key);
    const approverIds = r.approver_ids.split(',').map(Number).filter(Boolean);
    return {
      id: r.id, title: r.title, description: r.description, emoji: r.emoji, fields: parse(r.fields, []),
      needsApproval: !!r.approver_ids, active: !!r.active,
      // Project for grouping; null = not yet assigned to any project (or the project is archived/gone)
      project: p ? { key: p.key, name: p.name } : null,
      ...(manage ? { projectKey: p ? p.key : '', approverIds, approvers: approverRefs(approverIds), approvalMode: r.approval_mode, sort: r.sort, canEdit: true } : {}),
    };
  };
  const byProject = (a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || String(a.project?.name || '').localeCompare(String(b.project?.name || '')) || 0;

  /** all: management view – admins everything, leads/deputies the offerings of their projects */
  function list(user, { all = false } = {}) {
    const keys = managedKeys(user);
    const manage = all && (user.role === 'admin' || keys.size > 0);
    let rows = db.prepare(`SELECT * FROM catalog_items ${manage ? '' : 'WHERE active=1'} ORDER BY sort, title`).all();
    if (manage) rows = rows.filter((r) => canEdit(user, r, keys));
    return rows.map((r) => out(r, manage)).sort(byProject);
  }
  function get(user, id) {
    const r = db.prepare('SELECT * FROM catalog_items WHERE id=?').get(int(id) || 0);
    const edit = !!r && canEdit(user, r);
    if (!r || (!r.active && !edit)) throw notFound();
    return out(r, edit);
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
    const keys = managedKeys(user);
    if (user.role !== 'admin' && !keys.size) throw forbidden();
    const existing = id ? db.prepare('SELECT * FROM catalog_items WHERE id=?').get(int(id) || 0) : null;
    if (id && !existing) throw notFound();
    if (existing && !canEdit(user, existing, keys)) throw forbidden();
    const title = str(data.title, 120).trim();
    if (!title) throw new HttpError(400, 'err.titleRequired');
    // Project: leads/deputies only their own; admins may leave it open (sorted in later)
    const key = str(data.projectKey, 10).toUpperCase();
    if (key && !projectByKey(key)) throw new HttpError(400, 'err.catalogProject');
    if (user.role !== 'admin' && !key) throw new HttpError(400, 'err.catalogProject');
    if (user.role !== 'admin' && !keys.has(key)) throw forbidden();
    const approverIds = (Array.isArray(data.approverIds) ? data.approverIds : []).map(Number).filter((x) => users?.byId(x)?.active);
    const vals = [title, str(data.description, 4000), str(data.emoji, 16), key, JSON.stringify(cleanFields(data.fields)),
      approverIds.join(','), data.approvalMode === 'all' ? 'all' : 'any', data.active === false ? 0 : 1, int(data.sort) || 0];
    if (existing) {
      db.prepare('UPDATE catalog_items SET title=?, description=?, emoji=?, project_key=?, fields=?, approver_ids=?, approval_mode=?, active=?, sort=? WHERE id=?').run(...vals, existing.id);
      return get(user, existing.id);
    }
    const nid = db.prepare('INSERT INTO catalog_items(title, description, emoji, project_key, fields, approver_ids, approval_mode, active, sort) VALUES(?,?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid;
    return get(user, nid);
  }
  function remove(user, id) {
    const r = db.prepare('SELECT * FROM catalog_items WHERE id=?').get(int(id) || 0);
    if (!r) return;
    if (!canEdit(user, r)) throw forbidden();
    db.prepare('DELETE FROM catalog_items WHERE id=?').run(r.id);
  }

  /** Request from the catalog: validate answers, create ticket, request approval if needed */
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
      tickets.logActivity(tk.id, user.id, 'approvalRequested', null, null, ids.map((x) => users?.byId(x)?.display_name).filter(Boolean).join(', '));
      for (const aid of ids) notify(users?.byId(aid), 'mail.catalogApproval.subject', 'mail.catalogApproval.body', tk, { requester: user.display_name || user.username });
    }
    return tickets.detail(user, tk.id);
  }

  const fieldOf = (ticketId, name) => db.prepare('SELECT value FROM ticket_fields WHERE ticket_id=? AND name=?').get(ticketId, name)?.value;
  const setField = (ticketId, name, value) => db.prepare(`INSERT INTO ticket_fields(ticket_id, name, value) VALUES(?,?,?)
    ON CONFLICT(ticket_id, name) DO UPDATE SET value=excluded.value`).run(ticketId, name, value);

  /** Decision on a catalog request */
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
      // Reply to the reporter (mail like any reply); resolved if rejected
      tickets.addComment(user, row.id, { body: text }, { skipPermission: true });
      if (result === 'rejected') tickets.update({ ...user, role: 'agent' }, row.id, { status: 'done' }, { quietResolved: true, resolution: 'rejected' });
    }
    return tickets.detail(user, row.id);
  }

  async function send(to, subjectKey, bodyKey, tk, extra) {
    if (!mailer?.enabled?.() || !t || !to?.email || !to.active) return;
    const lang = to.language || settings.get('general.defaultLanguage');
    const vars = { key: tk.key, title: tk.title, link: `${baseUrl}/browse/${tk.key}`, app: settings.get('general.title') || 'Helfi.Space', ...extra };
    await mailer.send({ to: to.email, subject: t(lang, subjectKey, vars), text: t(lang, bodyKey, vars), ticketId: tk.id });
  }
  const notify = (...a) => send(...a).catch((e) => log.warn('Approval mail failed', { error: e.message }));

  tickets.addDetailExtra((user, row) => {
    const state = fieldOf(row.id, 'approvalState');
    if (!state || row.type === 'change') return {};
    return { approval: { state, items: approvals.current(row.id).items, mode: fieldOf(row.id, 'approvalMode') || 'any', canDecide: state === 'pending' && approvals.isPendingApprover(row.id, user.id) } };
  });

  return { list, get, save, remove, order, decide, fieldOf, manageable };
}
