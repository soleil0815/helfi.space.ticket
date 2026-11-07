// Audit 2026-11c (decisions on open points of 2026-11b): forged agent sender with [KEY] in the
// subject, trusted proxy without X-Forwarded-For, release never overwrites a published image tag
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startServer } from './helpers/server.js';
import { createNetworkPolicy } from '../src/auth/network.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let S; let ctx; let db; let anna;
const eml = (lines) => Buffer.from(lines.join('\r\n'));
async function run(lines) { const p = ctx.processor; return p.process(await p.parse(eml(lines))); }

before(async () => {
  S = await startServer('audit-c');
  ctx = S.ctx; db = S.db;
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
  anna = await S.user('anna', 'agent');
  await S.user('bob', 'user');
});
after(() => S.stop());

test('Mail from an agent address matched only via [KEY] in the subject: internal note, no reopening', async () => {
  const tk = (await anna('POST', '/api/tickets', { title: 'Drucker', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Ich schaue es mir an.' }); // anna "participates" via a comment
  await anna('PATCH', `/api/tickets/${tk.key}`, { status: 'done' });
  const r = await run(['From: Anna (IT) <anna@firma.local>', 'To: helpdesk@firma.local', `Subject: [${tk.key}] Bitte Passwort hier eingeben`,
    'Message-ID: <forged1@evil.example>', '', 'Klicken Sie auf https://evil.example/login']);
  assert.equal(r.action, 'comment');
  const last = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id);
  assert.equal(last.internal, 1, 'not a public comment in the agent\'s name');
  assert.match(last.body, /sender cannot be verified/);
  assert.equal(ctx.tickets.rawById(tk.id).status, 'done', 'not reopened');
  assert.ok(!ctx.tickets.comments({ id: S.ids.bob, role: 'user' }, tk.id).some((c) => /evil\.example/.test(c.body)), 'reporter does not see it');
});

test('Reporter replying with [KEY] in the subject still becomes a public comment (unchanged)', async () => {
  const tk = (await anna('POST', '/api/tickets', { title: 'Monitor', reporter: { userId: S.ids.bob }, notifyReporter: false })).body.ticket;
  const r = await run(['From: bob@firma.local', 'To: helpdesk@firma.local', `Subject: Re: [${tk.key}] Monitor`, 'Message-ID: <bob1@firma.local>', '', 'geht wieder']);
  assert.equal(r.action, 'comment');
  const last = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(tk.id);
  assert.equal(last.internal, 0);
});

test('Trusted proxy that sends no X-Forwarded-For: request counts as external (2FA)', () => {
  const app = express();
  app.set('trust proxy', 'loopback, 10.0.10.5');
  const v = { 'mfa.internalNetworks': '10.0.10.0/24', 'mfa.external': 'all', 'mfa.internal': 'none', 'mfa.ownAddresses': '' };
  const p = createNetworkPolicy({ get: (k) => v[k] }, { gateway: null, resolver: async () => [] });
  try {
    const viaProxy = { app, ip: '10.0.10.5', socket: { remoteAddress: '10.0.10.5' }, headers: {} };
    assert.equal(p.classify(viaProxy).internal, false, 'proxy address itself is no client');
    assert.equal(p.classify(viaProxy).reason, 'proxyWithoutClient');
    assert.equal(p.mfaRequired(viaProxy, { role: 'user' }), true);
    // With X-Forwarded-For (req.ip = client resolved by Express) the client decides
    const internalClient = { app, ip: '10.0.10.25', socket: { remoteAddress: '10.0.10.5' }, headers: { 'x-forwarded-for': '10.0.10.25' } };
    assert.equal(p.classify(internalClient).internal, true);
    // A device in the network that is not the proxy stays internal without the header
    const direct = { app, ip: '10.0.10.30', socket: { remoteAddress: '10.0.10.30' }, headers: {} };
    assert.equal(p.classify(direct).internal, true);
    // HELFI_TRUST_PROXY as a range: devices in it that connect directly are not treated as proxies
    const range = express();
    range.set('trust proxy', 'loopback, 10.0.10.0/24');
    assert.equal(p.classify({ app: range, ip: '10.0.10.30', socket: { remoteAddress: '10.0.10.30' }, headers: {} }).internal, true);
  } finally { p.stop?.(); }
});

test('Release: version reserved as git tag before image tags, an existing image tag is never overwritten', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const pub = yml.slice(yml.indexOf('\n  publish:'));
  const reserve = pub.indexOf('Reserve the version (git tag)');
  assert.ok(reserve > 0, 'reservation step');
  assert.ok(reserve < pub.indexOf('Publish the checked image'), 'git tag before the image tags');
  assert.ok(pub.indexOf('Publish the checked image') < pub.indexOf('GitHub release'));
  assert.match(pub, /git\/refs" -f ref="refs\/tags\/v\$V" -f sha="\$GITHUB_SHA"/);
  const publish = pub.slice(pub.indexOf('Publish the checked image'), pub.indexOf('GitHub release'));
  assert.ok(publish.indexOf('imagetools inspect "$IMAGE:$v"') < publish.indexOf('imagetools create $tags'), 'checked before tagging');
  assert.match(publish, /exists already with another digest/);
  // "Re-run all jobs": the version reserved on this commit is used again (no gap, no orphan tag)
  const check0 = yml.slice(yml.indexOf('\n  release-check:'), yml.indexOf('\n  release-build:'));
  assert.match(check0, /GITHUB_RUN_ATTEMPT" -gt 1/);
  assert.match(check0, /--points-at "\$GITHUB_SHA"/);
  assert.match(check0, /MODE="tag:\$mine"/);
  // Tag check: only 404 means free, other API errors stop the release
  const check = pub.slice(pub.indexOf('Tag must not exist yet'), pub.indexOf('Merge candidate'));
  assert.match(check, /HTTP 404/);
  assert.doesNotMatch(check, />\/dev\/null 2>&1; then/);
});
