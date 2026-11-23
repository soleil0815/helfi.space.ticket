// Audit 2026-11 (content and display): limits for formatted text on the server (mails) and in the
// browser, autolink never carries a kept part into a link, CSV cells never start a formula,
// address check without quadratic runtime, one log entry is one line.
// The browser part needs Playwright with Chromium – skipped if missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mdToHtml, mdToText } from '../src/markdown.js';
import { isEmail } from '../src/mail/parse.js';
import { log, oneLine, recentLogLines } from '../src/lib/log.js';
import { csvText } from '../public/js/csv.js';
import { startServer } from './helpers/server.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
if (!chromium && process.env.NODE_PATH) {
  try { ({ chromium } = createRequire(`${process.env.NODE_PATH}/`)('playwright')); } catch { /* not there either */ }
}
const skip = !chromium && 'Playwright missing';
if (!chromium && process.env.HELFI_REQUIRE_BROWSER) throw new Error('Playwright with Chromium is required (HELFI_REQUIRE_BROWSER is set)');

const timed = (fn) => { const t0 = performance.now(); const r = fn(); return { r, ms: performance.now() - t0 }; };
const count = (s, re) => (s.match(re) || []).length;

test('Server: nested boxes and quotes are bounded (no deep recursion, no blow-up)', () => {
  const panels = timed(() => mdToHtml(`${':::info\n'.repeat(20000)}Text`));
  assert.ok(panels.ms < 2000, `took ${panels.ms} ms`);
  assert.ok(count(panels.r, /<blockquote/g) <= 8, 'at most 8 levels');
  const quotes = timed(() => mdToHtml(`${'>'.repeat(12499)} tief`));
  assert.ok(quotes.ms < 2000, `took ${quotes.ms} ms`);
  assert.ok(count(quotes.r, /<blockquote/g) <= 8);
  assert.match(quotes.r, /tief/, 'the text itself is kept');
  assert.ok(mdToText(`${'>'.repeat(5000)} x`).length < 100000);
  // normal nesting still works
  assert.equal(count(mdToHtml('> a\n> > b'), /<blockquote/g), 2);
  // lists: deeper indentation is not nested further
  const list = Array.from({ length: 200 }, (_, i) => `${' '.repeat(i * 2)}- p${i}`).join('\n');
  assert.ok(count(mdToHtml(list), /<ul/g) <= 8);
});

test('Server: tables keep at most 50 columns', () => {
  const wide = `|${' a |'.repeat(5000)}\n|${' --- |'.repeat(5000)}\n|${' x |'.repeat(5000)}`;
  const out = mdToHtml(wide);
  assert.ok(count(out, /<th /g) <= 50);
  assert.ok(count(out, /<td /g) <= 50);
});

test('Server: an autolink or link target never takes in a kept part (no markup inside href)', () => {
  for (const md of ['see http://ab`x`cd end', '[t](https://a`x`)', 'http://a**`x`**b']) {
    const out = mdToHtml(md);
    for (const [, href] of out.matchAll(/href="([^"]*)"/g)) assert.doesNotMatch(href, /[<>\u0001\u0002]|&lt;|code/, `${md} → ${out}`);
    assert.doesNotMatch(out, /href="[^"]*<code/);
  }
  assert.match(mdToHtml('see https://firma.local/x end'), /<a href="https:\/\/firma\.local\/x">/, 'normal links stay');
});

test('CSV: cells that look like a formula stay text', () => {
  assert.equal(csvText('=HYPERLINK("http://203.0.113.5","x")'), `"'=HYPERLINK(""http://203.0.113.5"",""x"")"`);
  for (const v of ['+1', '-2', '@SUM(A1)', '\t=1', '\r=1']) assert.ok(csvText(v).replace(/^"/, '').startsWith("'"), v);
  assert.equal(csvText('Anna Berger'), 'Anna Berger');
  assert.equal(csvText('Berger; Anna'), '"Berger; Anna"');
  assert.equal(csvText(null), '');
});

test('Address check: same answers, no quadratic runtime', () => {
  for (const [v, ok] of [['karl@firma.local', true], ['a@b.c.d', true], ['a@b', false], ['@b.c', false], ['a@.c', false], ['a@b.', false], ['a b@c.d', false], ['a@b@c.d', false], ['<a@b.c>', false], ['', false]]) {
    assert.equal(isEmail(v), ok, v);
  }
  // the old pattern needed seconds here (domain with many dots and a trailing space or @)
  for (const tail of [' ', '@']) {
    const { ms } = timed(() => isEmail(`a@${'b.'.repeat(20000)}${tail}`));
    assert.ok(ms < 50, `took ${ms} ms`);
  }
  const { ms: ms2 } = timed(() => isEmail(`${'a'.repeat(100000)}@${'b.'.repeat(100000)}`));
  assert.ok(ms2 < 50, `took ${ms2} ms`);
});

test('Log: one entry is one line (line breaks from outside are written visibly)', () => {
  assert.equal(oneLine('a\r\nb\nc'), 'a\\nb\\nc');
  assert.equal(oneLine('x y\u0007z'), 'x y z');
  log.warn('Passkey sign-in failed for id abc\n2026-11-23T00:00:00.000Z INFO  Admin login ok');
  const last = recentLogLines().at(-1);
  assert.equal(last.includes('\n'), false);
  assert.match(last, /abc\\n2026-11-23/);
});

let S; let browser;
before(async () => {
  S = await startServer('content');
  if (chromium) browser = await chromium.launch();
});
after(async () => { await browser?.close(); await S?.stop(); });

test('Browser: deep boxes, quotes, lists and huge tables are bounded; a broken comment does not stop the page', { skip }, async () => {
  const c = await browser.newContext({ extraHTTPHeaders: { 'X-Helfi-Request': '1' } });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await p.request.post(`${S.base}/api/auth/login`, { data: { username: 'admin', password: 'Sehrgeheim123' } })).status(), 200);
  await p.goto(`${S.base}/`);
  await p.waitForSelector('.sidebar');
  const r = await p.evaluate(async () => {
    const { renderDoc } = await import('/js/kbdoc.js');
    const run = (md) => { const t0 = performance.now(); const el = renderDoc(md); return { ms: performance.now() - t0, el }; };
    const depth = (el, sel) => { let max = 0; for (const x of el.querySelectorAll(sel)) { let d = 0; for (let y = x; y && y !== el; y = y.parentElement) if (y.matches(sel)) d++; max = Math.max(max, d); } return max; };
    const panels = run(`${':::info\n'.repeat(5000)}x`);
    const quotes = run(`${'>'.repeat(5000)} x`);
    const list = run(Array.from({ length: 300 }, (_, i) => `${' '.repeat(i * 2)}- p${i}`).join('\n'));
    const wide = run(`|${' a |'.repeat(20000)}\n|${' --- |'.repeat(3)}\n|${' x |'.repeat(3)}`);
    const tall = run(`| a | b |\n| --- | --- |\n${'| x | y |\n'.repeat(4000)}`);
    const ok = run('| a | b |\n| --- | --- |\n| 1 | 2 |');
    return {
      panels: [panels.ms, depth(panels.el, '.kb-panel')], quotes: [quotes.ms, depth(quotes.el, 'blockquote')],
      list: [list.ms, depth(list.el, 'ul')], wide: [wide.ms, wide.el.querySelectorAll('th').length, wide.el.textContent.length > 0],
      tall: [tall.ms, tall.el.querySelectorAll('td').length], ok: ok.el.querySelectorAll('td').length,
    };
  });
  assert.ok(r.panels[0] < 3000 && r.panels[1] <= 8, JSON.stringify(r.panels));
  assert.ok(r.quotes[0] < 3000 && r.quotes[1] <= 8, JSON.stringify(r.quotes));
  assert.ok(r.list[1] <= 8, JSON.stringify(r.list));
  assert.equal(r.wide[1], 0, 'too wide: shown as text');
  assert.ok(r.wide[2]);
  assert.ok(r.tall[1] <= 5000, JSON.stringify(r.tall));
  assert.equal(r.ok, 2, 'normal tables stay tables');
  // commentView falls back to plain text if the formatted view throws
  const fallback = await p.evaluate(async () => {
    const { commentView } = await import('/js/commentfield.js');
    const orig = Element.prototype.append;
    let n = 0;
    Element.prototype.append = function (...a) { if (++n === 3) throw new RangeError('Maximum call stack size exceeded'); return orig.apply(this, a); };
    try { return commentView({ format: 'md', body: '**fett** Text' }).textContent; } finally { Element.prototype.append = orig; }
  });
  assert.match(fallback, /Text/);
  assert.deepEqual(errors, []);
  await c.close();
});
