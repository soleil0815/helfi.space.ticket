// Installable mobile app: service worker for the mobile UI (/m/sw.js, scope /m/).
// The worker script is generated from public/m/sw.js with
//   - the list of app-shell files to precache (found by following the static imports of the mobile UI)
//   - a cache version: app version + hash over the content of these files.
// Any change to a shell file therefore changes the worker's bytes: the browser installs the new
// worker, which fetches the new shell and deletes the old cache. Ticket data is never cached
// (the worker leaves /api/ and /auth/ alone, see public/m/sw.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Entry points of the mobile UI and the offline page, plus non-JS files of the shell
const ENTRIES = ['/m/js/main.js', '/m/js/offline.js'];
const STATIC = ['/m/index.html', '/m/offline.html', '/m/m.css', '/css/app.css', '/js/theme-init.js', '/icons/sprite.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

/** All JS modules reachable from the entries (static and literal dynamic imports), as URL paths */
export function moduleGraph(publicDir, entries = ENTRIES) {
  const seen = new Set();
  const visit = (url) => {
    if (seen.has(url)) return;
    const file = path.join(publicDir, url);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return;
    seen.add(url);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || !(spec.startsWith('/') || spec.startsWith('.'))) continue;
      visit(new URL(spec, `http://x${url}`).pathname);
    }
  };
  for (const e of entries) visit(e);
  return [...seen].sort();
}

export function createMobileSw(publicDir, getVersion) {
  const template = () => fs.readFileSync(path.join(publicDir, 'm', 'sw.js'), 'utf8');
  let memo = { key: '', body: '' };
  /** Worker script with shell list and version filled in; rebuilt only when a shell file changed */
  function script() {
    const files = [...STATIC, ...moduleGraph(publicDir)].filter((u) => fs.existsSync(path.join(publicDir, u)));
    const stats = [path.join(publicDir, 'm', 'sw.js'), ...files.map((u) => path.join(publicDir, u))].map((f) => { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; });
    const key = `${getVersion()}|${stats.join('|')}`;
    if (memo.key === key) return memo.body;
    const hash = crypto.createHash('sha256');
    for (const u of files) hash.update(u).update(fs.readFileSync(path.join(publicDir, u)));
    hash.update(template());
    const version = `${getVersion()}-${hash.digest('hex').slice(0, 12)}`;
    const body = template()
      .replace("'__HELFI_VERSION__'", JSON.stringify(version))
      .replace("['__HELFI_SHELL__']", JSON.stringify(files));
    memo = { key, body };
    return body;
  }
  return { script };
}
