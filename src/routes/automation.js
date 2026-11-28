// Automation rules (see src/automation.js): managed by admins (all projects) and by the lead/deputy of a
// project (its own rules). Every route checks the right on the project of the rule itself.
import express from 'express';
import { requireAuth } from '../auth/session.js';
import { agentOn } from '../auth/access.js';
import { forbidden, int } from '../lib/http.js';

export function createAutomationRoutes(ctx) {
  const { automation, db, users } = ctx;
  const r = express.Router();
  r.use('/automation', requireAuth);

  r.get('/automation/rules', (req, res) => {
    res.json({ rules: automation.list(req.user, req.query.projectId), projects: automation.manageable(req.user).map((p) => ({ id: p.id, key: p.key, name: p.name })) });
  });
  // Choices for the editor of one project: its components and the people who may be assigned/notified
  r.get('/automation/options', (req, res) => {
    const pid = req.query.projectId ? int(req.query.projectId) : null;
    if (!automation.canManage(req.user, pid)) throw forbidden();
    const components = pid ? db.prepare('SELECT id, name FROM components WHERE project_id=? AND archived=0 ORDER BY position, name').all(pid) : [];
    const people = pid
      ? db.prepare("SELECT id FROM users WHERE active=1 AND role IN ('agent','admin') ORDER BY display_name").all()
        .map((x) => users.byId(x.id)).filter((u) => u && agentOn(u, pid)).map((u) => ({ id: u.id, displayName: u.display_name }))
      : [];
    res.json({ components, people });
  });
  r.post('/automation/rules', (req, res) => res.status(201).json({ rule: automation.create(req.user, req.body || {}) }));
  r.patch('/automation/rules/:id', (req, res) => res.json({ rule: automation.update(req.user, req.params.id, req.body || {}) }));
  r.delete('/automation/rules/:id', (req, res) => res.json(automation.remove(req.user, req.params.id)));
  r.post('/automation/order', (req, res) => res.json({ rules: automation.reorder(req.user, req.body?.projectId, req.body?.ids) }));
  r.get('/automation/rules/:id/runs', (req, res) => res.json({ runs: automation.runs(req.user, req.params.id, req.query.limit) }));
  // Preview: which tickets the (possibly unsaved) rule would hit – changes nothing
  r.post('/automation/preview', (req, res) => res.json(automation.preview(req.user, req.body || {}, req.body?.ruleId || null)));
  r.get('/automation/templates', (req, res) => {
    if (!automation.manageable(req.user).length) throw forbidden();
    res.json({ templates: automation.templates(req.query.lang || req.user.language) });
  });
  r.post('/automation/templates/:key', (req, res) => res.status(201).json({
    rule: automation.addTemplate(req.user, req.params.key, { projectId: req.body?.projectId, name: req.body?.name, lang: req.body?.lang || req.user.language }),
  }));
  return r;
}
