// HTML-Mails: Bereinigung, eingebettete Bilder, Anzeige im abgeschotteten Rahmen, Rechte
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-html-'));
process.env.HELFI_DATA_DIR = dataDir;
process.env.HELFI_SETUP_TOKEN = 'code';
process.env.HELFI_LOG_LEVEL = 'error';

const { openDatabase } = await import('../src/db.js');
const { initMasterKey } = await import('../src/lib/crypto.js');
const { createApp } = await import('../src/app.js');
const { paths } = await import('../src/config.js');
const { sanitizeMailHtml, quoteStart, resolveCids, viewerDocument } = await import('../src/mail/html.js');

test('Bereinigung: Angriffsmuster werden entfernt', () => {
  const attacks = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<iframe src="https://example.com"></iframe>',
    '<object data="x"></object>', '<embed src="x">', '<form action="https://example.com"><input name=p></form>',
    '<svg><script>alert(1)</script></svg>', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<div style="background:url(https://example.com/t.gif)">x</div>', '<div style="behavior:url(x.htc)">x</div>',
    '<p style="position:fixed;top:0;left:0;width:100%">x</p>', '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<link rel=stylesheet href="https://example.com/x.css">', '<base href="https://example.com/">', '<style>@import "https://example.com/x.css";</style>',
    '<img src="https://example.com/pixel.gif" width=1 height=1>', '<img srcset="https://example.com/a.png 1x">',
    '<table background="https://example.com/bg.png"><tr><td>x</td></tr></table>', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
    '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
  ];
  const out = sanitizeMailHtml(`<p>Vorher</p>${attacks.join('')}<p>Nachher</p>`).html;
  for (const bad of [/<script/i, /onerror/i, /javascript:/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /<input/i, /<svg/i, /<math/i,
    /url\(/i, /behavior/i, /position/i, /<meta/i, /<link/i, /<base/i, /@import/i, /example\.com/i, /srcset/i, /background=/i, /data:text/i, /svg\+xml/i]) {
    assert.doesNotMatch(out, bad, String(bad));
  }
  assert.match(out, /Vorher/);
  assert.match(out, /Nachher/);
  const r = sanitizeMailHtml('<p>x</p><img src="https://tracker.example/p.gif"><img src="http://example.com/b.png">');
  assert.equal(r.blocked, 2);
});

test('Erlaubt: Gestaltung, Tabellen, sichere Links, eingebettete Bilder', () => {
  const r = sanitizeMailHtml('<table cellpadding="4" style="border-collapse:collapse"><tr><td style="color:#C9372C;font-weight:bold;padding:4px 8px">Fehler</td></tr></table>'
    + '<a href="https://firma.local/hilfe">Hilfe</a> <a href="mailto:it@firma.local">IT</a><img src="cid:logo@firma" alt="Logo"><img src="data:image/png;base64,iVBORw0KGgo=">');
  assert.match(r.html, /<table cellpadding="4" style="border-collapse:collapse">/);
  assert.match(r.html, /style="color:#C9372C;font-weight:bold;padding:4px 8px"/);
  assert.match(r.html, /href="https:\/\/firma\.local\/hilfe" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(r.html, /href="mailto:it@firma\.local"/);
  assert.deepEqual(r.cids, ['logo@firma']);
  assert.match(r.html, /data:image\/png/);
  assert.equal(resolveCids(r.html, new Map([['logo@firma', 7]])).match(/src="\/api\/attachments\/7"/).length, 1);
  assert.doesNotMatch(resolveCids(r.html, new Map()), /cid:/, 'unbekannte Bilder fallen weg');
  assert.equal(sanitizeMailHtml('<p>&nbsp;</p><br><script>x</script>'), null, 'leer → kein HTML');
});

test('Zitierten Verlauf erkennen und einklappen', () => {
  assert.ok(quoteStart('<p>Danke</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">Von: x</div>') > 0, 'Outlook');
  assert.ok(quoteStart('<div>Ok</div><div class="gmail_quote">Am Mo schrieb:</div>') > 0, 'Gmail');
  assert.ok(quoteStart('<p>Ja</p><blockquote type="cite">alt</blockquote>') > 0, 'Apple/Thunderbird');
  assert.ok(quoteStart('<p>Gut</p><p>-----Ursprüngliche Nachricht-----<br>Von: x</p>') > 0, 'Textmarke');
  assert.equal(quoteStart('<p>Nur neu</p>'), -1);
  const r = sanitizeMailHtml('<p>Läuft wieder</p><div class="gmail_quote">Am Montag schrieb IT:<blockquote>Bitte neu starten</blockquote></div>', { collapseQuote: true });
  assert.match(r.html, /^<p>Läuft wieder<\/p><details class="helfi-quote"><summary><\/summary>/);
  assert.match(viewerDocument(r.html, { quoteText: 'Zitat <x>' }), /<summary>Zitat &lt;x&gt;<\/summary>/);
  // aus der Mail selbst lässt sich der Aufklapper nicht vortäuschen
  assert.doesNotMatch(sanitizeMailHtml('<details class="helfi-quote"><summary></summary>x</details>').html, /class=/);
  assert.doesNotMatch(sanitizeMailHtml('<p>a</p><blockquote type="cite">b</blockquote>').html, /<details/, 'nur bei Antworten');
});

let server; let base; let db; let ctx;
before(async () => {
  initMasterKey();
  db = await openDatabase(paths.db);
  const built = createApp(db);
  ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1' }, body: JSON.stringify({ token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' }) });
  assert.equal(r.status, 200);
  ctx.settings.set('imap.user', 'helpdesk@firma.local');
});
after(async () => { await new Promise((r) => setTimeout(r, 100)); server?.close(); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
  };
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const htmlMail = (id, subject, html, extra = []) => Buffer.from([
  'From: Erika Muster <erika@firma.local>', 'To: helpdesk@firma.local', `Subject: ${subject}`, `Message-ID: <${id}@firma.local>`, ...extra,
  'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="R"', '',
  '--R', 'Content-Type: multipart/alternative; boundary="A"', '',
  '--A', 'Content-Type: text/plain; charset=utf-8', '', 'Drucker PR-0001 druckt nicht.', '',
  '--A', 'Content-Type: text/html; charset=utf-8', '', html, '',
  '--A--', '',
  '--R', 'Content-Type: image/png; name="logo.png"', 'Content-Transfer-Encoding: base64', 'Content-ID: <logo@firma>', 'Content-Disposition: inline; filename="logo.png"', '', PNG, '',
  '--R--', '',
].join('\r\n'));

let key;
test('HTML-Mail → Ticket mit formatierter Fassung; Logo eingebettet, nicht in der Anhangsliste', async () => {
  const p = ctx.processor;
  const r = p.process(await p.parse(htmlMail('h1', 'Drucker', '<p>Drucker <b>PR-0001</b> druckt nicht.</p><img src="cid:logo@firma"><img src="https://tracker.example/p.gif"><script>alert(1)</script>')));
  assert.equal(r.action, 'ticket');
  key = r.key;
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  const tk = (await admin('GET', `/api/tickets/${key}`)).body.ticket;
  assert.equal(tk.descriptionHtml, true);
  assert.equal(tk.description, 'Drucker PR-0001 druckt nicht.');
  assert.deepEqual(tk.attachments, [], 'eingebettetes Logo nicht in der Liste');
  const v = await admin('GET', `/api/tickets/${key}/mail-html`);
  assert.equal(v.status, 200);
  assert.match(v.headers.get('content-type'), /text\/html/);
  const csp = v.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.match(v.body, /<b>PR-0001<\/b>/);
  assert.doesNotMatch(v.body, /<script>alert/);
  assert.doesNotMatch(v.body, /tracker\.example/);
  assert.match(v.body, /1 Bild\(er\) aus dem Internet/);
  const img = /src="\/api\/attachments\/(\d+)"/.exec(v.body);
  assert.ok(img, 'Logo verweist auf gespeicherten Anhang');
  const file = await fetch(`${base}/api/attachments/${img[1]}`, { headers: { cookie: '' } });
  assert.notEqual(file.status, 200, 'ohne Anmeldung nicht abrufbar');
  assert.equal((await admin('GET', `/api/attachments/${img[1]}`)).status, 200);
});

test('Antwort per HTML-Mail: Kommentar mit formatierter Fassung, Verlauf eingeklappt', async () => {
  const p = ctx.processor;
  const r = p.process(await p.parse(htmlMail('h2', `Re: [${key}] Drucker`, '<p>Geht wieder, danke!</p><div class="gmail_quote">Am Montag schrieb IT:<blockquote>Bitte neu starten</blockquote></div>', [`In-Reply-To: <h1@firma.local>`])));
  assert.equal(r.action, 'comment');
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  const c = (await admin('GET', `/api/tickets/${key}`)).body.ticket.comments.at(-1);
  assert.equal(c.hasHtml, true);
  const v = await admin('GET', `/api/tickets/${key}/mail-html?comment=${c.id}`);
  assert.match(v.body, /<p>Geht wieder, danke!<\/p><details class="helfi-quote"><summary>Zitierten Text anzeigen<\/summary>/);
  // unbekannter Kommentar
  assert.equal((await admin('GET', `/api/tickets/${key}/mail-html?comment=999999`)).status, 404);
});

test('Rechte: Fremde sehen die formatierte Fassung nicht; nach Bearbeiten gilt der Text', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  await admin('POST', '/api/users', { username: 'karl', displayName: 'Karl', role: 'user', password: 'Sehrgeheim123', email: 'karl@firma.local' });
  const karl = client();
  await karl('POST', '/api/auth/login', { username: 'karl', password: 'Sehrgeheim123' });
  assert.equal((await karl('GET', `/api/tickets/${key}/mail-html`)).status, 404);
  assert.equal((await fetch(`${base}/api/tickets/${key}/mail-html`)).status, 401);
  assert.equal((await admin('PATCH', `/api/tickets/${key}`, { description: 'Drucker PR-0001 druckt nicht (bearbeitet).' })).status, 200);
  assert.equal((await admin('GET', `/api/tickets/${key}`)).body.ticket.descriptionHtml, false);
  assert.equal((await admin('GET', `/api/tickets/${key}/mail-html`)).status, 404);
});

test('Reine Textmail: keine formatierte Fassung', async () => {
  const p = ctx.processor;
  const r = p.process(await p.parse(Buffer.from(['From: max@firma.local', 'To: helpdesk@firma.local', 'Subject: Nur Text', 'Message-ID: <t1@firma.local>', '', 'Hallo'].join('\r\n'))));
  const admin = client();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'Sehrgeheim123' });
  assert.equal((await admin('GET', `/api/tickets/${r.key}`)).body.ticket.descriptionHtml, false);
});
