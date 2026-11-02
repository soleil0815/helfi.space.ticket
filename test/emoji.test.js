// Emojis: Suche, Kurznamen beim Tippen und unverfälschte Speicherung
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-emoji-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { EMOJIS } = await import('../public/js/emoji-data.js');
const { searchEmojis, shortcodeAt, completedShortcode, emoticonBefore, EMOTICONS } = await import('../public/js/emoji.js');

test('Liste: eindeutige Kurznamen und Zeichen, jedes mit Suchwörtern', () => {
  assert.ok(EMOJIS.length > 200);
  assert.equal(new Set(EMOJIS.map((e) => e.code)).size, EMOJIS.length);
  assert.equal(new Set(EMOJIS.map((e) => e.char)).size, EMOJIS.length);
  for (const e of EMOJIS) {
    assert.match(e.code, /^[a-z0-9_+-]+$/, e.code);
    assert.ok(e.words.length && e.words[0], e.code);
  }
});

test('Suche deutsch und englisch, Kurzname zuerst', () => {
  assert.equal(searchEmojis('daumen')[0].char, '👍');
  assert.equal(searchEmojis('thumbsup')[0].char, '👍');
  assert.equal(searchEmojis(':drucker')[0].char, '🖨️');
  assert.equal(searchEmojis('erledigt')[0].char, '✅');
  assert.deepEqual(searchEmojis('gibtesnicht'), []);
  assert.equal(searchEmojis('a', 5).length, 5);
});

test('Kurznamen beim Tippen erkennen, Uhrzeiten und Adressen nicht', () => {
  assert.deepEqual(shortcodeAt('Danke :dau', 10), { start: 6, query: 'dau' });
  assert.deepEqual(shortcodeAt(':ok', 3), { start: 0, query: 'ok' });
  assert.equal(shortcodeAt('Treffen 12:30', 13), null);
  assert.equal(shortcodeAt('https://helfi.firma.local', 25), null);
  assert.equal(shortcodeAt('Hinweis: x', 10), null);
  assert.equal(shortcodeAt('nur :a', 6), null, 'mindestens zwei Zeichen');
  const done = completedShortcode('Super :tada:', 12);
  assert.equal(done.emoji.char, '🎉');
  assert.equal(done.start, 6);
  assert.equal(completedShortcode('Zeit 10:15:', 11), null);
});

test('Klassische Smileys: nur wenn sie allein stehen', () => {
  assert.deepEqual(emoticonBefore('Danke :)', 8), { start: 6, original: ':)', char: '🙂' });
  assert.equal(emoticonBefore(':-)', 3).char, '🙂', 'längste Form zuerst');
  assert.equal(emoticonBefore(';)', 2).char, '😉');
  assert.equal(emoticonBefore('Gut :D', 6).char, '😄');
  assert.equal(emoticonBefore('x <3', 4).char, '❤️');
  assert.equal(emoticonBefore('(y)', 3).char, '👍');
  assert.equal(emoticonBefore('Laufwerk C:)', 12), null, 'direkt angehängt → nicht');
  assert.equal(emoticonBefore('https://x', 7), null);
  assert.equal(emoticonBefore('(siehe Liste:)', 14), null);
  assert.equal(emoticonBefore('a :d', 4), null, 'Kleinschreibung bei D nicht');
  for (const [k, v] of Object.entries(EMOTICONS)) assert.equal(emoticonBefore(k, k.length).char, v, k);
});

test('Emojis bleiben in Ticket und Kommentar erhalten', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { initMasterKey } = await import('../src/lib/crypto.js');
  const { createApp } = await import('../src/app.js');
  const { paths } = await import('../src/config.js');
  initMasterKey();
  const db = await openDatabase(paths.db);
  const built = createApp(db);
  built.ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  const server = await new Promise((r) => { const s = built.app.listen(0, '127.0.0.1', () => r(s)); });
  after(async () => { await new Promise((r) => setTimeout(r, 100)); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await call('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' })).status, 200);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  const text = 'Drucker 🖨️ geht wieder ✅ 👍🏽 🧑‍💻';
  const key = (await call('POST', '/api/tickets', { title: 'Drucker 🖨️ druckt nicht', description: text })).body.ticket.key;
  assert.equal((await call('POST', `/api/tickets/${key}/comments`, { body: `Danke 🙏 ${text}` })).status, 201);
  const tk = (await call('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.title, 'Drucker 🖨️ druckt nicht');
  assert.equal(tk.description, text);
  assert.ok(tk.comments.some((c) => c.body === `Danke 🙏 ${text}`));
  // Oberfläche: ohne langes Zwischenspeichern, damit nach einem Update sofort die neue Fassung kommt
  const js = await fetch(`${base}/js/emoji.js`);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  assert.ok(js.headers.get('etag'));
  // fetch() hängt bei If-None-Match selbst „no-cache“ an – deshalb hier node:http
  const { get } = await import('node:http');
  const status = await new Promise((r) => get(`${base}/js/emoji.js`, { headers: { 'If-None-Match': js.headers.get('etag') } }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(status, 304, 'unverändert → nicht neu übertragen');
});
