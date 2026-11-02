// ITIL-Erweiterungen: Verknüpfungen, (später) SLA, Problem, Change, Wissen, Katalog …
import express from 'express';
import { requireRole } from '../auth/session.js';
import { int, str } from '../lib/http.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createItilRoutes(ctx) {
  const r = express.Router();
  const { links } = ctx;

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

  return r;
}
