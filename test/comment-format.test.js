// Formatted comments (toolbar): stored with format 'md', shown formatted, mails with a readable text
// part and a safe HTML part; mails and system notes stay plain text; KB comments likewise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let S; let anna; let karl; const sent = [];
const wait = () => new Promise((r) => setTimeout(r, 60));
before(async () => {
  S = await startServer('commentformat');
  anna = await S.user('anna', 'agent');
  karl = await S.user('karl', 'user');
  S.ctx.mailer.enabled = () => true;
  S.ctx.mailer.send = async (m) => { sent.push(m); return true; };
});
after(() => S?.stop());

test('Markdown → mail text and HTML: readable, escaped, only safe links', async () => {
  const { mdToText, mdToHtml, mailHtml, MAIL_BODY } = await import('../src/markdown.js');
  const md = 'Hallo **Eva**, *bitte* prüfen:\n\n- Schritt `eins`\n  - Unterpunkt\n- [Doku](https://x.example/a) und ~~alt~~ @[Anna A](user:3)\n\n1. a\n2. b\n\n> Zitat <script>\n\n```\ncode <b>\n```\n\n![shot.png](/api/attachments/12) \\*kein* [x](javascript:alert(1)) [IT-1](/browse/IT-1)';
  const text = mdToText(md, 'de', 'https://helfi.firma.example');
  assert.match(text, /^Hallo Eva, bitte prüfen:/);
  assert.match(text, /- Schritt eins\n {2}- Unterpunkt/);
  assert.match(text, /Doku \(https:\/\/x\.example\/a\) und alt @Anna A/);
  assert.match(text, /\[Bild: shot\.png\] \*kein\*/, 'escaped star stays a star');
  assert.match(text, /IT-1 \(https:\/\/helfi\.firma\.example\/browse\/IT-1\)/);
  assert.doesNotMatch(text, /\*\*|~~|`/);
  const html = mdToHtml(md, { baseUrl: 'https://helfi.firma.example' });
  assert.match(html, /<strong>Eva<\/strong>/);
  assert.match(html, /<em>bitte<\/em>/);
  assert.match(html, /<ul[^>]*><li>Schritt <code[^>]*>eins<\/code><ul/);
  assert.match(html, /<ol[^>]*><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(html, /Zitat &lt;script&gt;/);
  assert.match(html, /code &lt;b&gt;<\/pre>/);
  assert.match(html, /<a href="https:\/\/helfi\.firma\.example\/browse\/IT-1">IT-1<\/a>/);
  assert.doesNotMatch(html, /<script|href="javascript/i);
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)/, 'unsafe link stays text');
  const page = mailHtml(`Hallo <b>\n\n${MAIL_BODY}\n\nhttps://h.example/x`, '<p>X</p>');
  assert.match(page, /Hallo &lt;b&gt;/);
  assert.match(page, /<p>X<\/p>/);
  assert.match(page, /<a href="https:\/\/h\.example\/x">/);
  // Pathological input stays fast
  const t0 = Date.now();
  mdToHtml(`${'*'.repeat(50000)}a${'['.repeat(20000)}`);
  mdToText(`${'~~'.repeat(30000)}`);
  assert.ok(Date.now() - t0 < 1500);
});

test('Ticket comment with format md: stored and mailed with an HTML part; plain comments without', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'Drucker' })).body.ticket;
  sent.length = 0;
  let r = await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Bitte **neu starten**:\n\n1. Aus\n2. An', format: 'md' });
  assert.equal(r.body.comment.format, 'md');
  await wait();
  const m = sent.find((x) => x.to === 'karl@firma.local');
  assert.match(m.text, /Bitte neu starten:\n\n1\. Aus\n2\. An/);
  assert.match(m.html, /<strong>neu starten<\/strong>/);
  assert.match(m.html, /hat auf Ihr Ticket/);
  sent.length = 0;
  r = await anna('POST', `/api/tickets/${tk.key}/comments`, { body: 'Ohne **Format**' });
  assert.equal(r.body.comment.format, 'text');
  await wait();
  assert.equal(sent.find((x) => x.to === 'karl@firma.local').html, undefined);
  // Users may format too; unknown formats become text
  r = await karl('POST', `/api/tickets/${tk.key}/comments`, { body: '*danke*', format: 'md' });
  assert.equal(r.body.comment.format, 'md');
  r = await karl('POST', `/api/tickets/${tk.key}/comments`, { body: 'x', format: 'html' });
  assert.equal(r.body.comment.format, 'text');
  // Mails and system notes stay plain text
  const c = S.ctx.tickets.addComment(null, tk.key, { body: '**aus Mail**', format: 'md' }, { source: 'email', authorEmail: 'karl@firma.local', skipPermission: true });
  assert.equal(c.format, 'text');
  const list = (await anna('GET', `/api/tickets/${tk.key}`)).body.ticket.comments;
  assert.deepEqual(list.map((x) => x.format), ['md', 'text', 'md', 'text', 'text']);
});

test('Mentions in formatted comments work as before', async () => {
  const tk = (await karl('POST', '/api/tickets', { title: 'VPN' })).body.ticket;
  const r = await anna('POST', `/api/tickets/${tk.key}/comments`, { body: `**Hinweis** für @[x](user:${S.ids.anna}) und @[y](user:${S.ids.karl})`, format: 'md', internal: true });
  assert.match(r.body.comment.body, new RegExp(`@\\[anna\\]\\(user:${S.ids.anna}\\)`));
  assert.match(r.body.comment.body, /@y/, 'customer in an internal note is not mentioned');
});

test('KB comments: format md, mail to the author with HTML part', async () => {
  const a = (await anna('POST', '/api/kb', { title: 'VPN einrichten', body: 'Text', visibility: 'internal' })).body.article;
  const tom = await S.user('tom', 'agent');
  sent.length = 0;
  const r = await tom('POST', `/api/kb/${a.id}/comments`, { body: 'Schritt 3 fehlt: **Neustart**', format: 'md' });
  assert.equal(r.body.comment.format, 'md');
  await wait();
  const m = sent.find((x) => x.to === 'anna@firma.local');
  assert.match(m.text, /Schritt 3 fehlt: Neustart/);
  assert.match(m.html, /<strong>Neustart<\/strong>/);
  assert.equal((await tom('POST', `/api/kb/${a.id}/comments`, { body: 'alt' })).body.comment.format, 'text');
});
