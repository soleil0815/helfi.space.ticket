// Owner decision: change approvers without agent rights on the change's project see the plan
// read-only (what they need to decide) – nothing else agent-only, no edit, no transitions.
// The UI parts need Playwright with Chromium and are skipped if it is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

const plan = {
  changeType: 'normal', reason: 'Firmware mit Sicherheitsluecke', risk: 'high', services: 'Firewall 10.0.10.1',
  plannedStart: '2026-11-21T08:00:00Z', plannedEnd: '2026-11-21T10:00:00Z',
  implementationPlan: 'Firmware 7.4 einspielen und neu starten', backoutPlan: 'Altes Image zuruecksichern', testPlan: 'VPN-Anmeldung pruefen',
};
let S; let anna; let hma; let plain; let zoe; let HM; let browser;

before(async () => {
  S = await startServer('audit11f-changeplan');
  anna = await S.user('anna', 'agent'); // legacy all-projects agent
  hma = await S.user('hma', 'user'); // agent of another project only
  plain = await S.user('plain', 'user'); // no project at all
  zoe = await S.user('zoe', 'user');
  HM = (await S.admin('POST', '/api/projects', { key: 'HM', name: 'Haustechnik' })).body.project.id;
  await S.admin('PUT', `/api/projects/${HM}/agents`, { members: [{ userId: S.ids.hma }] });
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S.stop(); });

async function changeInApproval(title, approverIds, { ci = null } = {}) {
  const key = (await anna('POST', '/api/tickets', { title, type: 'change', projectId: 1, description: 'Beschreibung des Changes' })).body.ticket.key;
  assert.equal((await anna('PATCH', `/api/tickets/${key}/fields`, plan)).status, 200);
  if (ci) assert.equal((await anna('POST', `/api/tickets/${key}/cis`, { name: ci })).status, 200);
  await anna('POST', `/api/tickets/${key}/comments`, { body: 'Interne Notiz zum Change', internal: true });
  S.ctx.settings.set('change.approvers', approverIds.join(','));
  assert.equal((await anna('POST', `/api/tickets/${key}/change/transition`, { to: 'approval' })).status, 200);
  return key;
}

test('Change approver without project rights gets the plan read-only, nothing else agent-only', async () => {
  const ci = (await anna('POST', '/api/cis', { name: 'fw-01', kind: 'network', ip: '10.0.10.1', location: 'Serverraum' }));
  assert.equal(ci.status, 201, JSON.stringify(ci.body));
  const key = await changeInApproval('Firewall-Update', [S.ids.hma, S.ids.plain], { ci: 'fw-01' });
  for (const [who, call] of [['hma', hma], ['plain', plain]]) {
    const r = await call('GET', `/api/tickets/${key}`);
    assert.equal(r.status, 200, who);
    const tk = r.body.ticket;
    assert.equal(tk.change.canDecide, true, who);
    assert.deepEqual(tk.change.next, [], `${who}: no transitions`);
    const p = tk.change.plan;
    assert.ok(p, `${who}: plan included`);
    for (const n of ['changeType', 'reason', 'risk', 'services', 'implementationPlan', 'backoutPlan', 'testPlan']) assert.equal(p[n], plan[n], `${who}: ${n}`);
    assert.equal(p.plannedStart, '2026-11-21T08:00:00.000Z');
    assert.equal(p.plannedEnd, '2026-11-21T10:00:00.000Z');
    assert.deepEqual(p.cis, [{ name: 'fw-01', kind: 'network' }], `${who}: CI name and kind only`);
    assert.equal(p.outcome, undefined);
    assert.equal(p.review, undefined);
    assert.equal(tk.description, 'Beschreibung des Changes');
    // Still nothing agent-only beyond the plan
    assert.equal(tk.fields, undefined, `${who}: no editable fields`);
    assert.equal(tk.cis, undefined, `${who}: no CMDB details`);
    assert.equal(tk.links, undefined, `${who}: no links`);
    assert.ok(!JSON.stringify(r.body).includes('Interne Notiz'), `${who}: no internal notes`);
    assert.ok(!JSON.stringify(r.body).includes('Serverraum'), `${who}: no CI location`);
  }
  // The approver still cannot change the plan or move the phase
  for (const call of [hma, plain]) {
    const pf = await call('PATCH', `/api/tickets/${key}/fields`, { reason: 'geaendert' });
    assert.ok([403, 404].includes(pf.status), `PATCH fields → ${pf.status}`);
    const tr = await call('POST', `/api/tickets/${key}/change/transition`, { to: 'implementing' });
    assert.ok([403, 404].includes(tr.status), `transition → ${tr.status}`);
  }
  assert.equal((await anna('GET', `/api/tickets/${key}`)).body.ticket.fields.reason, plan.reason);
  // After deciding (earlier approver) the plan stays visible to them
  assert.equal((await plain('POST', `/api/tickets/${key}/approval`, { decision: 'approve' })).status, 200);
  const after = (await plain('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(after.change.canDecide, false);
  assert.equal(after.change.plan.reason, plan.reason);
});

test('Change plan: users without rights who are not approvers see nothing new', async () => {
  const key = await changeInApproval('Switch-Tausch', [S.ids.plain]);
  // zoe follows the change as participant (sees the ticket) but is no approver
  const pr = await anna('POST', `/api/tickets/${key}/participants`, { userId: S.ids.zoe });
  assert.ok(pr.status < 300, JSON.stringify(pr.body));
  const r = await zoe('GET', `/api/tickets/${key}`);
  assert.equal(r.status, 200, 'zoe sees the ticket as participant');
  assert.equal((await hma('GET', `/api/tickets/${key}`)).status, 404, 'hma (no approver here) does not see it');
  for (const [who, call] of [['zoe', zoe]]) {
    const r = await call('GET', `/api/tickets/${key}`);
    assert.equal(r.body.ticket.change, undefined, `${who}: no change data`);
    assert.ok(!JSON.stringify(r.body).includes(plan.implementationPlan), `${who}: no plan text`);
  }
  // Agents of the project keep their full, editable view
  const tk = (await anna('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.fields.implementationPlan, plan.implementationPlan);
  assert.equal(tk.change.plan, undefined);
});

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}

test('Desktop: approval box of an approver without project rights shows the plan read-only', { skip }, async () => {
  const key = await changeInApproval('Router-Update', [S.ids.plain]);
  const { p, errors } = await page('plain');
  await p.goto(`${S.base}/browse/${key}`);
  const box = p.locator('.change-box');
  await box.locator('.change-plan').waitFor();
  assert.match(await box.locator('.change-plan').innerText(), /Firmware 7\.4 einspielen und neu starten/);
  assert.match(await box.locator('.change-plan').innerText(), /Altes Image zuruecksichern/);
  assert.match(await box.locator('.change-plan').innerText(), /Hoch/);
  assert.equal(await box.locator('textarea, select, input[type=datetime-local]').count(), 0, 'nothing editable');
  assert.equal(await box.locator('.approval-actions button').count(), 2, 'approve and reject');
  assert.deepEqual(errors, []);
});

test('Phone: approval card of an approver without project rights shows the plan read-only', { skip }, async () => {
  const key = await changeInApproval('Drucker-Update', [S.ids.plain]);
  const { p, errors } = await page('plain', true);
  await p.goto(`${S.base}/m/t/${key}`);
  const card = p.locator('.m-approval');
  await card.locator('.change-plan').waitFor();
  assert.match(await card.locator('.change-plan').innerText(), /Firmware 7\.4 einspielen und neu starten/);
  assert.equal(await card.locator('.m-approval-actions button').count(), 2);
  assert.deepEqual(errors, []);
});
