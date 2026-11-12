// ITIL extensions: links, (later) SLA, problem, change, knowledge, catalog …
import express from 'express';
import { requireRole, agentOn } from '../auth/session.js';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { int, str, HttpError } from '../lib/http.js';
import { config, paths } from '../config.js';
import { t, hasKey, normalizeLang } from '../i18n.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createItilRoutes(ctx) {
  const r = express.Router();
  const { links, major, fields, problems, changes, approvals, tickets, kb, kbComments, kbVotes, catalog, cmdb, survey, itilReports } = ctx;

  // ---------- Links ----------
  r.post('/tickets/:key/links', requireRole('agent'), wrap(async (req, res) => {
    res.status(201).json({ links: links.add(req.user, req.params.key, { kind: str(req.body.kind, 20), target: req.body.target }) });
  }));
  // Suggestions for the link picker: ?keys=IT-1,IT-2 (one ticket or a multi-select)
  r.get('/link-suggestions', requireRole('agent'), (req, res) => {
    const keys = str(req.query.keys, 2000).split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
    res.json(links.suggest(req.user, keys));
  });
  r.delete('/tickets/:key/links/:id', requireRole('agent'), (req, res) => {
    res.json({ links: links.remove(req.user, req.params.key, int(req.params.id)) });
  });
  r.post('/tickets/:key/subtasks', requireRole('agent'), wrap(async (req, res) => {
    res.status(201).json(links.createSubtask(req.user, req.params.key, { title: req.body.title, assigneeId: req.body.assigneeId || null }));
  }));

  // ---------- Extra fields (problem, change) ----------
  r.patch('/tickets/:key/fields', requireRole('agent'), wrap(async (req, res) => {
    res.json({ fields: fields.update(req.user, req.params.key, req.body || {}) });
  }));

  // ---------- Problem management ----------
  r.post('/tickets/:key/problem', requireRole('agent'), wrap(async (req, res) => {
    res.status(201).json({ ticket: problems.fromIncident(req.user, req.params.key, { title: req.body.title }) });
  }));
  r.get('/known-errors', requireRole('agent'), (req, res) => res.json({ knownErrors: problems.knownErrors(req.user) }));

  // ---------- Change management ----------
  r.post('/tickets/:key/change/transition', requireRole('agent'), wrap(async (req, res) => {
    res.json({ ticket: changes.transition(req.user, req.params.key, str(req.body.to, 20), { outcome: req.body.outcome || null, review: req.body.review ?? null }) });
  }));
  r.post('/tickets/:key/change/request-approval', requireRole('agent'), wrap(async (req, res) => {
    res.json({ ticket: changes.requestLate(req.user, req.params.key) });
  }));
  // Decision: change (agents) or catalog request (also non-agents, e.g. managers)
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
    res.json({ changes: changes.calendar(from.toISOString(), to.toISOString(), req.user) });
  });
  r.get('/changes/templates', requireRole('agent'), (req, res) => res.json({ templates: changes.standardTemplates() }));
  r.get('/approvals/mine', (req, res) => {
    res.json({ tickets: approvals.pendingFor(req.user.id).map((id) => { const row = tickets.rawById(id); return tickets.ticketOut(row, agentOn(req.user, row.project_id), req.user.id); }) });
  });

  // ---------- Knowledge base (read: all signed-in users, public articles; write: agents) ----------
  r.get('/kb', (req, res) => {
    let articles = kb.search(req.user, str(req.query.q, 200), { category: str(req.query.category, 60), project: str(req.query.project, 10) });
    if (req.user.role !== 'user') {
      const open = kbComments.openCounts();
      const votes = kbVotes.all();
      articles = articles.map((a) => ({ ...a, openComments: open.get(a.id) || 0, rating: votes.get(a.id) || { up: 0, down: 0 } }));
      // "Needs rework": most "not helpful" first (more than helpful), then the others as before
      if (req.query.sort === 'needsWork') {
        const need = (a) => a.rating.down - a.rating.up;
        articles = articles.filter((a) => a.rating.down > 0).sort((x, y) => need(y) - need(x) || y.rating.down - x.rating.down);
      }
    }
    // projects: with articles readable for the user (filter); writable: where the user may create articles
    res.json({ articles, categories: kb.categories(req.user, { project: str(req.query.project, 10) }), ...kb.projects(req.user) });
  });
  // Comments
  r.get('/kb/:id/comments', (req, res) => res.json({ comments: kbComments.list(req.user, req.params.id) }));
  r.post('/kb/:id/comments', (req, res) => res.status(201).json({ comment: kbComments.add(req.user, req.params.id, req.body?.body, req.body?.format) }));
  r.patch('/kb/comments/:cid', (req, res) => res.json({ comment: kbComments.setResolved(req.user, req.params.cid, !!req.body?.resolved) }));
  r.delete('/kb/comments/:cid', (req, res) => { kbComments.remove(req.user, req.params.cid); res.json({ ok: true }); });
  r.get('/kb/suggest', (req, res) => {
    // Suggestions when reporting: public articles only, at most 3
    const q = str(req.query.q, 200);
    res.json({ articles: kb.search({ role: 'user' }, q, { limit: 3 }) });
  });
  // Images for knowledge articles
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
    // Internal article images: not kept in the browser cache of a shared device (like ticket attachments)
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(f.path).on('error', () => res.end()).pipe(res);
  });
  r.get('/kb/tree', (req, res) => res.json({ tree: kb.tree(req.user) }));
  r.get('/kb/projects', (req, res) => res.json(kb.projects(req.user)));
  r.patch('/kb/:id/parent', requireRole('agent'), (req, res) => res.json({ article: kb.move(req.user, req.params.id, req.body?.parentId ?? null) }));
  r.get('/kb/:id/bundle', (req, res) => res.json({ articles: kb.bundle(req.user, req.params.id) }));
  // Templates (before /kb/:id, otherwise "templates" would be an article ID)
  r.get('/kb/templates', requireRole('agent'), (req, res) => res.json({ templates: kb.templates(req.user) }));
  r.get('/kb/templates/:id', requireRole('agent'), (req, res) => res.json({ template: kb.template(req.user, req.params.id) }));
  r.post('/kb/templates', requireRole('agent'), (req, res) => res.status(201).json({ template: kb.saveTemplate(req.user, null, req.body || {}) }));
  r.put('/kb/templates/:id', requireRole('agent'), (req, res) => res.json({ template: kb.saveTemplate(req.user, req.params.id, req.body || {}) }));
  r.delete('/kb/templates/:id', requireRole('agent'), (req, res) => { kb.removeTemplate(req.user, req.params.id); res.json({ ok: true }); });
  // Versions
  r.get('/kb/:id/versions', requireRole('agent'), (req, res) => res.json({ versions: kb.versions(req.user, req.params.id) }));
  r.get('/kb/:id/versions/:v', requireRole('agent'), (req, res) => res.json({ version: kb.version(req.user, req.params.id, req.params.v) }));
  r.post('/kb/:id/versions/:v/restore', requireRole('agent'), (req, res) => res.json({ article: kb.restore(req.user, req.params.id, req.params.v) }));
  r.get('/kb/:id', (req, res) => {
    const article = kb.get(req.user, req.params.id, { count: req.query.view === '1' });
    res.json({ article: { ...article, rating: kbVotes.summary(req.user, article.id) } });
  });
  // Rating: "Was this article helpful?"
  r.post('/kb/:id/vote', (req, res) => res.json({ rating: kbVotes.vote(req.user, req.params.id, req.body?.vote) }));
  r.post('/kb/:id/feedback', (req, res) => res.status(201).json({ rating: kbVotes.addFeedback(req.user, req.params.id, req.body?.body) }));
  r.get('/kb/:id/feedback', requireRole('agent'), (req, res) => res.json(kbVotes.feedback(req.user, req.params.id)));
  r.post('/kb/:id/rating/reset', requireRole('agent'), (req, res) => res.json({ rating: kbVotes.reset(req.user, req.params.id) }));
  r.post('/kb', requireRole('agent'), wrap(async (req, res) => res.status(201).json({ article: kb.create(req.user, req.body || {}) })));
  r.put('/kb/:id', requireRole('agent'), wrap(async (req, res) => res.json({ article: kb.update(req.user, req.params.id, req.body || {}) })));
  r.delete('/kb/:id', requireRole('agent'), (req, res) => { kb.remove(req.user, req.params.id); res.json({ ok: true }); });
  r.get('/tickets/:key/kb-draft', requireRole('agent'), (req, res) => res.json({ draft: kb.draftFromTicket(req.user, req.params.key) }));

  // ---------- Service catalog ----------
  // ---------- Satisfaction ----------
  r.post('/tickets/:key/rating', (req, res) => res.json({ ticket: survey.rateAsUser(req.user, req.params.key, req.body.rating, req.body.comment) }));
  r.get('/reports/itil', requireRole('agent'), (req, res) => res.json(itilReports.report(req.query, req.user)));
  r.get('/reports/satisfaction', requireRole('agent'), (req, res) => res.json(survey.report(req.query, req.user)));

  // ---------- Devices and services ----------
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

  r.get('/catalog', (req, res) => res.json({
    items: catalog.list(req.user, { all: req.query.all === '1' }),
    // Projects whose offerings this person may manage (admins: all; leads/deputies: their own)
    manageProjects: catalog.manageable(req.user).map((p) => ({ key: p.key, name: p.name })),
  }));
  r.get('/catalog/:id', (req, res) => res.json({ item: catalog.get(req.user, req.params.id) }));
  r.post('/catalog', requireRole('agent'), wrap(async (req, res) => res.status(201).json({ item: catalog.save(req.user, null, req.body || {}) })));
  r.put('/catalog/:id', requireRole('agent'), wrap(async (req, res) => res.json({ item: catalog.save(req.user, req.params.id, req.body || {}) })));
  r.delete('/catalog/:id', requireRole('agent'), (req, res) => { catalog.remove(req.user, req.params.id); res.json({ ok: true }); });
  r.post('/catalog/:id/order', wrap(async (req, res) => res.status(201).json({ ticket: catalog.order(req.user, req.params.id, req.body?.answers || {}) })));

  // ---------- Major Incident ----------
  r.post('/tickets/:key/broadcast', requireRole('agent'), wrap(async (req, res) => {
    res.json(major.broadcast(req.user, req.params.key, { body: req.body.body, resolve: !!req.body.resolve }));
  }));

  return r;
}
