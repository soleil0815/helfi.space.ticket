// AI in the browser: functions switched off disappear, component suggestion accepted (desktop) and dismissed (phone).
// Needs Playwright with Chromium (not part of the dependencies) – if missing, the test is skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"component": "VPN", "reason": "Fernzugriff"}' } }] }));
  });
});

let S; let browser; let karl;
before(async () => {
  if (!chromium) return;
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer('aiclassifyui');
  await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  const p = (await S.admin('GET', '/api/projects')).body.projects[0];
  await S.admin('POST', `/api/projects/${p.id}/components`, { name: 'VPN', leadId: S.ids.anna });
  await S.admin('PUT', '/api/admin/settings', { settings: { 'ai.enabled': true, 'ai.baseUrl': `http://127.0.0.1:${fake.address().port}/v1`, 'ai.model': 'm', 'ai.reasoning': 'off', 'ai.classify': true, 'ai.summary': false } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); fake.close(); });

async function page(username, mobile = false) {
  const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username, password: 'Sehrgeheim123' } })).status(), 200);
  await p.request.patch(`${S.base}/api/me`, { data: { language: 'de' } });
  return { p, errors };
}
const settle = async () => { await new Promise((r) => setTimeout(r, 50)); await S.ctx.aiClassifier.idle(); };

test('Desktop: no summary when switched off; suggestion accepted', { skip }, async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Komme nicht ins Netz' })).body.ticket;
  await settle();
  const { p, errors } = await page('anna');
  await p.goto(`${S.base}/browse/${tk.key}`);
  await p.waitForSelector('.ai-suggest >> text=VPN');
  assert.equal(await p.locator('.ai-summary').count(), 0, 'summary switched off');
  await p.click('.ai-suggest .btn-primary');
  await p.waitForFunction(() => !document.querySelector('.ai-suggest'));
  const row = p.locator('.detail-row', { hasText: 'Komponente' });
  assert.equal((await row.locator('.detail-pick').textContent()).trim(), 'VPN');
  assert.equal((await S.admin('GET', `/api/tickets/${tk.key}`)).body.ticket.assignee.displayName, 'anna');
  assert.deepEqual(errors, []);
});

test('Phone: suggestion in the details, dismissed', { skip }, async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Etwas anderes' })).body.ticket;
  await settle();
  const { p, errors } = await page('anna', true);
  await p.goto(`${S.base}/m/t/${tk.key}`);
  await p.waitForSelector('.m-details-btn');
  await p.tap('.m-details-btn');
  await p.waitForSelector('.m-ai-suggest >> text=VPN');
  await p.tap('.m-ai-suggest-actions .m-btn:not(.m-btn-primary)');
  for (let i = 0; i < 40 && (await S.admin('GET', '/api/admin/ai/stats')).body.classify.rejected === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await S.admin('GET', '/api/admin/ai/stats')).body.classify.rejected, 1);
  assert.deepEqual(errors, []);
});

test('Admin: functions and hit rate on the AI page', { skip }, async () => {
  const { p, errors } = await page('admin');
  await p.goto(`${S.base}/admin/ai`);
  await p.waitForSelector('.ai-stats .ai-rate');
  assert.match(await p.$eval('.ai-stats', (e) => e.textContent), /50 %.*1 von 2/);
  assert.equal(await p.locator('.ai-functions input[type=checkbox]').count(), 6);
  assert.deepEqual(errors, []);
});
