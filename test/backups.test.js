// Tests: configure the number of backups, cleanup, delete individual backups
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.js';

let S; let paths;
before(async () => {
  S = await startServer('backups');
  ({ paths } = await import('../src/config.js'));
});
after(() => S.stop());

const files = () => fs.readdirSync(paths.backups).filter((f) => /\.sqlite(\.gz)?$/.test(f)).sort();
function fake(name, ageMin) {
  fs.mkdirSync(paths.backups, { recursive: true });
  const f = path.join(paths.backups, name);
  fs.writeFileSync(f, 'x'.repeat(100));
  const t = Date.now() / 1000 - ageMin * 60;
  fs.utimesSync(f, t, t);
}

test('Default 10, overview with kind and total size', async () => {
  for (let i = 0; i < 12; i++) fake(`helfi-taeglich-2026-10-${String(i + 1).padStart(2, '0')}.sqlite`, 1000 - i);
  const r = await S.admin('GET', '/api/admin/system');
  assert.equal(r.status, 200);
  assert.equal(r.body.backupKeep, 10);
  const daily = r.body.backups.filter((b) => b.kind === 'daily');
  assert.equal(daily.length, 12, 'not cleaned up yet');
  assert.equal(daily[0].name, 'helfi-taeglich-2026-10-12.sqlite', 'newest first');
  assert.ok(r.body.backupsSize >= 1200);
});

test('Changing the count cleans up immediately, values are clamped', async () => {
  let r = await S.admin('PUT', '/api/admin/settings', { settings: { 'backup.keep': 3 } });
  assert.equal(r.status, 200);
  let daily = files().filter((f) => f.includes('taeglich'));
  assert.deepEqual(daily, ['helfi-taeglich-2026-10-10.sqlite', 'helfi-taeglich-2026-10-11.sqlite', 'helfi-taeglich-2026-10-12.sqlite']);

  r = await S.admin('PUT', '/api/admin/settings', { settings: { 'backup.keep': 0 } });
  assert.equal(S.ctx.settings.get('backup.keep'), 1, 'at least 1');
  daily = files().filter((f) => f.includes('taeglich'));
  assert.deepEqual(daily, ['helfi-taeglich-2026-10-12.sqlite'], 'the newest one stays');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'backup.keep': 5000 } });
  assert.equal(S.ctx.settings.get('backup.keep'), 100, 'at most 100');
  await S.admin('PUT', '/api/admin/settings', { settings: { 'backup.keep': 2 } });
});

test('Manual backups are counted, version and pre-delete backups separately', async () => {
  fake('helfi-vor-1.8.0-a.sqlite', 500);
  fake('helfi-vor-1.9.0-a.sqlite', 400);
  fake('helfi-vor-loeschen-HR-a.sqlite', 300);
  for (let i = 0; i < 3; i++) {
    const r = await S.admin('POST', '/api/admin/backup');
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 1100)); // distinct timestamp in the name
  }
  const left = files();
  assert.equal(left.filter((f) => f.startsWith('helfi-manuell-')).length, 2);
  // The backup before deleting a project is its own kind and is not pushed out by manual ones (Audit 2026-11)
  assert.ok(left.includes('helfi-vor-loeschen-HR-a.sqlite'), 'backup before project deletion stays');
  // Backups before a version change (incl. the one created at startup) count separately
  assert.ok(left.includes('helfi-vor-1.9.0-a.sqlite'));
});

test('Deleting a single backup: admins only, only files from the backup folder', async () => {
  const agent = await S.user('agent1', 'agent');
  const name = files().find((f) => f.includes('taeglich'));
  let r = await agent('DELETE', `/api/admin/backups/${name}`);
  assert.equal(r.status, 403);
  fs.writeFileSync(path.join(paths.backups, '..', 'helfi-geheim.sqlite'), 'x');
  for (const bad of ['..%2Fhelfi-geheim.sqlite', '%2E%2E%2Fhelfi-geheim.sqlite', 'helfi.db', 'fremd.sqlite']) {
    r = await S.admin('DELETE', `/api/admin/backups/${bad}`);
    assert.equal(r.status, 404, bad);
  }
  assert.ok(fs.existsSync(path.join(paths.backups, '..', 'helfi-geheim.sqlite')));
  r = await S.admin('DELETE', `/api/admin/backups/${name}`);
  assert.equal(r.status, 200);
  assert.ok(!files().includes(name));
  r = await S.admin('DELETE', `/api/admin/backups/${name}`);
  assert.equal(r.status, 404);
});
