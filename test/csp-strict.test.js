// Content-Security-Policy without wildcard sources (ZAP "CSP: Wildcard Directive")
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

const S = await startServer('csp-strict');
after(() => S.stop());

function directives(header) {
  return Object.fromEntries(header.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
}

test('CSP of pages and API: no wildcard or scheme-wide sources, fonts only from the own server', async () => {
  for (const path of ['/', '/login', '/m/', '/sitemap.xml', '/api/bootstrap', '/js/app.js']) {
    const r = await fetch(`${S.base}${path}`);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, `CSP on ${path}`);
    const d = directives(csp);
    assert.deepEqual(d['font-src'], ["'self'"], `font-src on ${path}`);
    assert.deepEqual(d['default-src'], ["'self'"]);
    assert.deepEqual(d['script-src'], ["'self'"]);
    assert.deepEqual(d['object-src'], ["'none'"]);
    for (const [name, sources] of Object.entries(d)) {
      for (const src of sources) {
        assert.ok(!['*', 'https:', 'http:', "'unsafe-inline'", "'unsafe-eval'"].includes(src), `${name} ${src} on ${path}`);
      }
    }
  }
});
