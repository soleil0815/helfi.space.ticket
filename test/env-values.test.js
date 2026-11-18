// .env values Helfi.Space cannot use (typically a comment that slipped into the value from an old env.example):
// the default applies – never silently "off" – and the variable is reported by name (log, admin warning,
// diagnosis package), never by value.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Before the server (and with it config.js) is loaded
process.env.HELFI_BASE_URL = 'https://helfi.firma.local';
process.env.HELFI_SECURE_COOKIES = 'false';
process.env.HELFI_SESSION_HOURS = '12   hours until sign-out';
const { startServer } = await import('./helpers/server.js');

let S; let readEnv; let L;
before(async () => {
  S = await startServer('envvalues');
  ({ readEnv } = await import('../src/config.js'));
  L = await import('../src/lib/log.js');
});
after(() => S.stop());

const HTTPS = { HELFI_BASE_URL: 'https://helfi.firma.local' };

test('Old env.example line: the comment in the value no longer switches secure cookies off', () => {
  const e = readEnv({ ...HTTPS, HELFI_SECURE_COOKIES: 'true   cookies over HTTPS only (default: on if HELFI_BASE_URL starts with https://)' });
  assert.equal(e.secureCookies, true);
  assert.deepEqual(e.problems, ['HELFI_SECURE_COOKIES']);
  // Same over plain HTTP: default off, still reported
  const h = readEnv({ HELFI_BASE_URL: 'http://10.0.10.5:8080', HELFI_SECURE_COOKIES: 'true cookies over HTTPS only' });
  assert.equal(h.secureCookies, false);
  assert.deepEqual(h.problems, ['HELFI_SECURE_COOKIES']);
});

test('Valid values: yes/no words in German and English, lists, empty → default, no reports', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'ja', 'on', ' on ']) assert.equal(readEnv({ HELFI_SECURE_COOKIES: v }).secureCookies, true, v);
  for (const v of ['0', 'false', 'no', 'nein', 'off']) {
    const e = readEnv({ ...HTTPS, HELFI_SECURE_COOKIES: v });
    assert.equal(e.secureCookies, false, v);
    assert.deepEqual(e.problems, [], v);
  }
  assert.equal(readEnv({ ...HTTPS, HELFI_SECURE_COOKIES: '' }).secureCookies, true);
  const ok = readEnv({
    ...HTTPS, HELFI_TRUST_PROXY: 'loopback, 10.0.10.5', HELFI_HSTS: 'preload', HELFI_FORCE_HTTPS: 'auto',
    HELFI_LOG_LEVEL: 'warn', HELFI_PORT: '8080', HELFI_SESSION_HOURS: '8', HELFI_COMPOSE_VERSION: '1',
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.trustProxy, 'loopback, 10.0.10.5');
  assert.equal(ok.sessionHours, 8);
});

test('Unusable values: default applies and the name is reported', () => {
  const e = readEnv({
    HELFI_HSTS: 'vielleicht', HELFI_FORCE_HTTPS: 'manchmal', HELFI_LOG_LEVEL: 'laut',
    HELFI_PORT: 'achtzig', HELFI_MAX_UPLOAD_MB: '-3', HELFI_SETUP_TOKEN: 'your own setup code instead of a random one',
  });
  assert.equal(e.hsts, 'on');
  assert.equal(e.logLevel, 'info');
  assert.equal(e.port, 8080);
  assert.equal(e.maxUploadMb, 25);
  assert.deepEqual(e.problems.sort(), ['HELFI_FORCE_HTTPS', 'HELFI_HSTS', 'HELFI_LOG_LEVEL', 'HELFI_MAX_UPLOAD_MB', 'HELFI_PORT', 'HELFI_SETUP_TOKEN']);
});

test('Admin: warnings for insecure cookies over HTTPS and for unusable .env values; log names only the variable', async () => {
  const boot = (await S.admin('GET', '/api/bootstrap')).body;
  const codes = boot.warnings.map((w) => w.code);
  assert.ok(codes.includes('cookiesInsecure'), JSON.stringify(boot.warnings));
  const env = boot.warnings.find((w) => w.code === 'envInvalid');
  assert.equal(env.message, 'HELFI_SESSION_HOURS');
  const lines = L.recentLogLines().join('\n');
  assert.match(lines, /HELFI_SESSION_HOURS in \.env has a value Helfi\.Space cannot use/);
  assert.doesNotMatch(lines, /hours until sign-out/, 'the value itself is never logged');
  // Not for agents/users
  const anna = await S.user('anna', 'agent');
  assert.deepEqual((await anna('GET', '/api/bootstrap')).body.warnings, []);
});
