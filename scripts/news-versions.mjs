#!/usr/bin/env node
// Release: give the upcoming news items (version "" in src/news.json) their version – automatically.
// Each upcoming item belongs to the release with which it was first shipped: the script looks
// through the release tags (oldest first) and finds the first one whose news.json already listed
// the item as upcoming. Items that no release has shipped yet belong to the version being built.
// Only the file in the build context is changed; nothing is committed, so no pull request is
// needed after a release. Items are recognised by their German text.
//
// Usage: node scripts/news-versions.mjs <version> [news.json]   (needs the git tags: fetch-depth 0)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
const cmp = (a, b) => {
  const x = SEMVER.exec(a).slice(1).map(Number);
  const y = SEMVER.exec(b).slice(1).map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/**
 * entries: current entries; version: the release being built;
 * history: [{ version, date, entries }] of earlier releases (any order).
 */
export function assignVersions(entries, version, history, today = new Date().toISOString().slice(0, 10)) {
  const shipped = new Map(); // German text → { version, date } of the first release that shipped it
  for (const h of [...history].sort((a, b) => cmp(a.version, b.version))) {
    for (const e of h.entries || []) {
      if (e.version) continue;
      for (const item of e.items || []) if (!shipped.has(item.de)) shipped.set(item.de, { version: h.version, date: h.date });
    }
  }
  const out = entries.filter((e) => e.version).map((e) => ({ ...e, items: [...(e.items || [])] }));
  const known = new Set(out.flatMap((e) => e.items.map((i) => i.de)));
  const target = (v, date) => {
    let e = out.find((x) => x.version === v);
    if (!e) { e = { version: v, date, items: [] }; out.push(e); }
    return e;
  };
  for (const item of entries.filter((e) => !e.version).flatMap((e) => e.items || [])) {
    if (known.has(item.de)) continue; // already listed under a version
    const s = shipped.get(item.de);
    target(s ? s.version : version, s ? s.date : today).items.push(item);
    known.add(item.de);
  }
  return out.filter((e) => e.items.length).sort((a, b) => cmp(b.version, a.version));
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

function history(file) {
  const tags = git('tag', '--list', 'v*').split('\n').filter((t) => SEMVER.test(t));
  const out = [];
  for (const tag of tags) {
    let data;
    try { data = JSON.parse(git('show', `${tag}:${file}`)); } catch { continue; } // tag older than the news
    const date = git('log', '-1', '--format=%cs', tag);
    out.push({ version: tag.replace(/^v/, ''), date, entries: data.entries || [] });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, file = 'src/news.json'] = process.argv.slice(2);
  if (!version || !SEMVER.test(version)) { console.error('Usage: news-versions.mjs <version> [news.json]'); process.exit(2); }
  const v = version.replace(/^v/, '');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tags = git('tag', '--list', 'v*');
  if (!tags) { console.error('No release tags found – checkout with fetch-depth: 0'); process.exit(1); }
  data.entries = assignVersions(data.entries || [], v, history(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  const current = data.entries.find((e) => e.version === v);
  console.log(`News ${v}: ${current ? current.items.length : 0} item(s)`);
}
