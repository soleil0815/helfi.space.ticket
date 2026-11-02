// ITIL-Erweiterungen: Verknüpfungen, (später) SLA, Problem, Change, Wissen, Katalog …
import express from 'express';
import { requireRole } from '../auth/session.js';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { int, str, HttpError } from '../lib/http.js';
import { config, paths } from '../config.js';
import { t, hasKey, normalizeLang } from '../i18n.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createItilRoutes(ctx) {
  const r = express.Router();
  const { links, major, fields, problems, changes, approvals, tickets, kb, kbComments, catalog, cmdb, survey, itilReports } = ctx;

  // ---------- Verknüpfungen ----------
  r.post('/tickets/:key/links', requireRole('agent'), wrap(async (req, res) => {
    res.status(201).json({ links: links.add(req.user, req.params.key, { kind: str(req.body.kind, 20), target: req.body.target }) });
  }));
  r.delete('/tickets/:key/links/:id', requireRole('agent'), (req, res) => {
    res.json({ links: links.remove(req.user, req.params.key, int(req.params.id)) });
  });
  r.post('/tickets/:key/subtasks', requireRole('agent'), wrap(async (req, res) => {
    res.status(201).json(links.createSubtask(req.user, req.params.key, { title: req.body.title, assigneeId: req.body.assigneeId || null }));
  }));

  // ---------- Zusatzfelder (Problem, Change) ----------
  r.patch('/tickets/:key/fields', requireRole('agent'), wrap(async (req, res) => {
    res.json({ fields: fields.update(req.user, req.params.key, req.body || {}) });
  }));

  // ---------- Problem-Management ----------
  r.post('/tickets/:key/problem', requireRole('agent'), wrap(async (req, res) => {
    res.status(201).json({ ticket: problems.fromIncident(req.user, req.params.key, { title: req.body.title }) });
  }));
  r.get('/known-errors', requireRole('agent'), (req, res) => res.json({ knownErrors: problems.knownErrors() }));

  // ---------- Change-Management ----------
  r.post('/tickets/:key/change/transition', requireRole('agent'), wrap(async (req, res) => {
    res.json({ ticket: changes.transition(req.user, req.params.key, str(req.body.to, 20), { outcome: req.body.outcome || null, review: req.body.review ?? null }) });
  }));
  r.post('/tickets/:key/change/request-approval', requireRole('agent'), wrap(async (req, res) => {
    res.json({ ticket: changes.requestLate(req.user, req.params.key) });
  }));
  // Entscheidung: Change (Bearbeiter) oder Katalog-Anfrage (auch Nicht-Bearbeiter, z. B. Vorgesetzte)
  r.post('/tickets/:key/approval', wrap(async (req, res) => {
    const row = tickets.load(req.user, req.params.key);
    const decision = str(req.body.decision, 10);
    if (row.type === 'change') {
      if (!['agent', 'admin'].includes(req.user.role)) return res.status(403).json({ error: { code: 'err.forbidden' } });
      return res.json({ ticket: changes.decide(req.user, req.params.key, decision, req.body.comment) });
    }
    res.json({ ticket: catalog.decide(req.user, req.params.key, decision, req.body.comment) });
  }));
  r.get('/changes/calendar', requireRole('agent'), (req, res) => {
    const from = new Date(String(req.query.from || ''));
    const to = new Date(String(req.query.to || ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to - from > 400 * 864e5) return res.status(400).json({ error: { code: 'err.badRequest' } });
    res.json({ changes: changes.calendar(from.toISOString(), to.toISOString()) });
  });
  r.get('/changes/templates', requireRole('agent'), (req, res) => res.json({ templates: changes.standardTemplates() }));
  r.get('/approvals/mine', (req, res) => {
    res.json({ tickets: approvals.pendingFor(req.user.id).map((id) => tickets.ticketOut(tickets.rawById(id))) });
  });

  // ---------- Wissensdatenbank (Lesen: alle Angemeldeten, öffentliche Artikel; Schreiben: Bearbeiter) ----------
  r.get('/kb', (req, res) => {
    let articles = kb.search(req.user, str(req.query.q, 200), { category: str(req.query.category, 60) });
    if (req.user.role !== 'user') { const open = kbComments.openCounts(); articles = articles.map((a) => ({ ...a, openComments: open.get(a.id) || 0 })); }
    res.json({ articles, categories: kb.categories(req.user) });
  });
  // Kommentare
  r.get('/kb/:id/comments', (req, res) => res.json({ comments: kbComments.list(req.user, req.params.id) }));
  r.post('/kb/:id/comments', (req, res) => res.status(201).json({ comment: kbComments.add(req.user, req.params.id, req.body?.body) }));
  r.patch('/kb/comments/:cid', (req, res) => res.json({ comment: kbComments.setResolved(req.user, req.params.cid, !!req.body?.resolved) }));
  r.delete('/kb/comments/:cid', (req, res) => { kbComments.remove(req.user, req.params.cid); res.json({ ok: true }); });
  r.get('/kb/suggest', (req, res) => {
    // Vorschläge beim Melden: nur öffentliche Artikel, höchstens 3
    const q = str(req.query.q, 200);
    res.json({ articles: kb.search({ role: 'user' }, q, { limit: 3 }) });
  });
  // Bilder für Wissensartikel
  const kbUpload = multer({ dest: path.join(paths.attachments, '.tmp'), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
  r.post('/kb/images', requireRole('agent'), (req, res, next) => {
    kbUpload.single('file')(req, res, (err) => {
      const cleanup = () => { if (req.file) fs.rmSync(req.file.path, { force: true }); };
      if (err) { cleanup(); return next(err.code === 'LIMIT_FILE_SIZE' ? new HttpError(413, 'err.fileTooLarge') : new HttpError(400, 'err.badRequest', err.code)); }
      if (!req.file) return next(new HttpError(400, 'err.badRequest', 'file'));
      try { res.status(201).json(kb.addImage(req.user, { tmpPath: req.file.path, filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8') })); } catch (e) { cleanup(); next(e); }
    });
  });
  r.get('/kb/images/:token', (req, res) => {
    const f = kb.imageFile(req.user, req.params.token);
    if (!fs.existsSync(f.path)) throw new HttpError(404, 'err.notFound');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(f.path).on('error', () => res.end()).pipe(res);
  });
  r.get('/kb/tree', (req, res) => res.json({ tree: kb.tree(req.user) }));
  r.patch('/kb/:id/parent', requireRole('agent'), (req, res) => res.json({ article: kb.move(req.user, req.params.id, req.body?.parentId ?? null) }));
  r.get('/kb/:id/bundle', (req, res) => res.json({ articles: kb.bundle(req.user, req.params.id) }));
  // Vorlagen (vor /kb/:id, sonst wäre „templates“ eine Artikel-ID)
  r.get('/kb/templates', requireRole('agent'), (req, res) => res.json({ templates: kb.templates(req.user) }));
  r.get('/kb/templates/:id', requireRole('agent'), (req, res) => res.json({ template: kb.template(req.user, req.params.id) }));
  r.post('/kb/templates', requireRole('agent'), (req, res) => res.status(201).json({ template: kb.saveTemplate(req.user, null, req.body || {}) }));
  r.put('/kb/templates/:id', requireRole('agent'), (req, res) => res.json({ template: kb.saveTemplate(req.user, req.params.id, req.body || {}) }));
  r.delete('/kb/templates/:id', requireRole('agent'), (req, res) => { kb.removeTemplate(req.user, req.params.id); res.json({ ok: true }); });
  // Versionen
  r.get('/kb/:id/versions', requireRole('agent'), (req, res) => res.json({ versions: kb.versions(req.user, req.params.id) }));
  r.get('/kb/:id/versions/:v', requireRole('agent'), (req, res) => res.json({ version: kb.version(req.user, req.params.id, req.params.v) }));
  r.post('/kb/:id/versions/:v/restore', requireRole('agent'), (req, res) => res.json({ article: kb.restore(req.user, req.params.id, req.params.v) }));
  r.get('/kb/:id', (req, res) => res.json({ article: kb.get(req.user, req.params.id, { count: req.query.view === '1' }) }));
  r.post('/kb', requireRole('agent'), wrap(async (req, res) => res.status(201).json({ article: kb.create(req.user, req.body || {}) })));
  r.put('/kb/:id', requireRole('agent'), wrap(async (req, res) => res.json({ article: kb.update(req.user, req.params.id, req.body || {}) })));
  r.delete('/kb/:id', requireRole('agent'), (req, res) => { kb.remove(req.user, req.params.id); res.json({ ok: true }); });
  r.get('/tickets/:key/kb-draft', requireRole('agent'), (req, res) => res.json({ draft: kb.draftFromTicket(req.user, req.params.key) }));

  // ---------- Servicekatalog ----------
  // ---------- Zufriedenheit ----------
  r.post('/tickets/:key/rating', (req, res) => res.json({ ticket: survey.rateAsUser(req.user, req.params.key, req.body.rating, req.body.comment) }));
  r.get('/reports/itil', requireRole('agent'), (req, res) => res.json(itilReports.report(req.query)));
  r.get('/reports/satisfaction', requireRole('agent'), (req, res) => res.json(survey.report(req.query)));

  // ---------- Geräte und Dienste ----------
  r.get('/cis', requireRole('agent'), (req, res) => res.json({ items: cmdb.list(req.user, { q: str(req.query.q, 200), kind: str(req.query.kind, 20), status: str(req.query.status, 20) }) }));
  r.get('/cis/:id', requireRole('agent'), (req, res) => res.json({ item: cmdb.get(req.user, req.params.id) }));
  r.post('/cis', requireRole('agent'), (req, res) => res.status(201).json({ item: cmdb.create(req.user, req.body || {}) }));
  r.put('/cis/:id', requireRole('agent'), (req, res) => res.json({ item: cmdb.update(req.user, req.params.id, req.body || {}) }));
  r.delete('/cis/:id', requireRole('admin'), (req, res) => { cmdb.remove(req.user, req.params.id); res.json({ ok: true }); });
  r.post('/cis/import', requireRole('admin'), (req, res) => {
    const result = cmdb.importCsv(req.user, str(req.body?.csv, 5_000_000));
    const lang = normalizeLang(req.user.language);
    result.errors = result.errors.map((e) => ({ line: e.line, message: hasKey(e.error) ? t(lang, e.error, { detail: e.detail ?? '' }) : e.error }));
    res.json(result);
  });
  r.post('/tickets/:key/cis', requireRole('agent'), (req, res) => res.json({ cis: cmdb.link(req.user, req.params.key, req.body || {}) }));
  r.delete('/tickets/:key/cis/:id', requireRole('agent'), (req, res) => res.json({ cis: cmdb.unlink(req.user, req.params.key, req.params.id) }));

  r.get('/catalog', (req, res) => res.json({ items: catalog.list(req.user, { all: req.query.all === '1' }) }));
  r.get('/catalog/:id', (req, res) => res.json({ item: catalog.get(req.user, req.params.id) }));
  r.post('/catalog', requireRole('admin'), wrap(async (req, res) => res.status(201).json({ item: catalog.save(req.user, null, req.body || {}) })));
  r.put('/catalog/:id', requireRole('admin'), wrap(async (req, res) => res.json({ item: catalog.save(req.user, req.params.id, req.body || {}) })));
  r.delete('/catalog/:id', requireRole('admin'), (req, res) => { catalog.remove(req.user, req.params.id); res.json({ ok: true }); });
  r.post('/catalog/:id/order', wrap(async (req, res) => res.status(201).json({ ticket: catalog.order(req.user, req.params.id, req.body?.answers || {}) })));

  // ---------- Major Incident ----------
  r.post('/tickets/:key/broadcast', requireRole('agent'), wrap(async (req, res) => {
    res.json(major.broadcast(req.user, req.params.key, { body: req.body.body, resolve: !!req.body.resolve }));
  }));

  return r;
}
