// ITIL-Erweiterungen: Verknüpfungen, (später) SLA, Problem, Change, Wissen, Katalog …
import express from 'express';
import { requireRole } from '../auth/session.js';
import { int, str } from '../lib/http.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createItilRoutes(ctx) {
  const r = express.Router();
  const { links, major, fields, problems, changes, approvals, tickets } = ctx;

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
  r.post('/tickets/:key/approval', requireRole('agent'), wrap(async (req, res) => {
    res.json({ ticket: changes.decide(req.user, req.params.key, str(req.body.decision, 10), req.body.comment) });
  }));
  r.get('/changes/calendar', requireRole('agent'), (req, res) => {
    const from = new Date(String(req.query.from || ''));
    const to = new Date(String(req.query.to || ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to - from > 400 * 864e5) return res.status(400).json({ error: { code: 'err.badRequest' } });
    res.json({ changes: changes.calendar(from.toISOString(), to.toISOString()) });
  });
  r.get('/changes/templates', requireRole('agent'), (req, res) => res.json({ templates: changes.standardTemplates() }));
  r.get('/approvals/mine', requireRole('agent'), (req, res) => {
    res.json({ tickets: approvals.pendingFor(req.user.id).map((id) => tickets.ticketOut(tickets.rawById(id))) });
  });

  // ---------- Major Incident ----------
  r.post('/tickets/:key/broadcast', requireRole('agent'), wrap(async (req, res) => {
    res.json(major.broadcast(req.user, req.params.key, { body: req.body.body, resolve: !!req.body.resolve }));
  }));

  return r;
}
