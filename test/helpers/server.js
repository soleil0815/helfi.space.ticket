// Shared test setup: own data folder, server, initial setup, clients with cookie
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function startServer(name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `helfi-${name}-`));
  process.env.HELFI_DATA_DIR = dataDir;
  process.env.HELFI_SETUP_TOKEN = 'code';
  process.env.HELFI_LOG_LEVEL = 'error';
  const { openDatabase } = await import('../../src/db.js');
  const { initMasterKey } = await import('../../src/lib/crypto.js');
  const { createApp } = await import('../../src/app.js');
  const { paths } = await import('../../src/config.js');
  initMasterKey();
  const db = await openDatabase(paths.db);
  const built = createApp(db);
  const ctx = built.ctx;
  ctx.settings.set('mfa.internalNetworks', '127.0.0.1, ::1');
  const server = await new Promise((r) => { const s = built.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Helfi-Request': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
    };
    /** GET returning the raw bytes (downloads) */
    call.raw = async (url) => {
      const r = await fetch(base + url, { headers: { cookie } });
      return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
    };
    call.cookie = () => cookie;
    call.login = async (username, password = 'Sehrgeheim123') => {
      const r = await call('POST', '/api/auth/login', { username, password });
      if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
      return call;
    };
    return call;
  };
  const admin = client();
  const s = await admin('POST', '/api/setup', { token: 'code', username: 'admin', password: 'Sehrgeheim123', projectKey: 'IT', projectName: 'IT' });
  if (s.status !== 200) throw new Error(`setup ${s.status}`);
  const ids = {};
  /** Create a user and return a logged-in client. role 'agent' = legacy all-projects agent (set in the database: the API no longer gives it out) */
  const user = async (username, role) => {
    const r = await admin('POST', '/api/users', { username, displayName: username, email: `${username}@firma.local`, role: role === 'agent' ? 'user' : role, password: 'Sehrgeheim123' });
    ids[username] = r.body.user.id;
    if (role === 'agent') legacyAgent(db, r.body.user.id);
    return client().login(username);
  };
  const stop = async () => { await new Promise((r) => setTimeout(r, 100)); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { db, ctx, base, client, admin, user, ids, stop };
}

/** Turn an account into a legacy agent (role 'agent': every project) – the API no longer gives this role out */
export function legacyAgent(db, id) {
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
}
