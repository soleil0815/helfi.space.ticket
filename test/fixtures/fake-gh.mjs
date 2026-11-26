// Test double for the GitHub CLI (gh) as used by vuln-grace.sh and gh-release.sh.
// State: $FAKE_GH_DIR/state.json; log of all calls: $FAKE_GH_DIR/calls.log.
// FAKE_GH_FAIL="<substring>:<n>[,<substring>:<n>]" – the first n calls whose arguments contain the substring fail
// with a GitHub 502 (the failure counters are kept in the state).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.env.FAKE_GH_DIR;
const file = path.join(dir, 'state.json');
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { issues: [], releases: [], labels: [], failed: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 1));
const args = process.argv.slice(2);
const line = args.join(' ');
fs.appendFileSync(path.join(dir, 'calls.log'), `${line}\n`);

for (const rule of (process.env.FAKE_GH_FAIL || '').split(',').filter(Boolean)) {
  const i = rule.lastIndexOf(':');
  const pat = rule.slice(0, i); const n = Number(rule.slice(i + 1));
  if (line.includes(pat) && (st.failed[rule] || 0) < n) {
    st.failed[rule] = (st.failed[rule] || 0) + 1;
    // A "failed" create may still have created the draft (as GitHub did on 2026-11-25)
    if (process.env.FAKE_GH_CREATE_ON_FAIL && args[0] === 'release' && args[1] === 'create') createRelease();
    save();
    process.stderr.write('HTTP 502: Server Error\n');
    process.exit(1);
  }
}

function out(data) {
  const jqIdx = args.indexOf('--jq');
  let text = JSON.stringify(data);
  if (jqIdx >= 0) {
    const r = spawnSync('jq', ['-r', args[jqIdx + 1]], { input: text, encoding: 'utf8' });
    if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
    text = r.stdout;
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}
const fields = () => {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '-F') {
      const [k, ...v] = args[i + 1].split('='); const val = v.join('=');
      if (k.endsWith('[]')) (o[k.slice(0, -2)] ||= []).push(val); else o[k] = val;
    }
  }
  return o;
};
function createRelease() {
  const tag = args[2];
  if (st.releases.some((r) => r.tag_name === tag)) return null;
  const r = { id: st.releases.length + 100, tag_name: tag, draft: args.includes('--draft'), name: args[args.indexOf('--title') + 1], target: args[args.indexOf('--target') + 1], latest: null, assets: [] };
  st.releases.push(r);
  return r;
}
const relByTag = (tag) => st.releases.find((r) => r.tag_name === tag);

if (args[0] === 'api') {
  const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
  const url = args.find((a, i) => i > 0 && a.startsWith('repos/'));
  const p = url.replace(/^repos\/[^/]+\/[^/]+\//, '');
  const f = fields();
  if (p.startsWith('issues?') && method === 'GET') {
    const label = /labels=([^&]+)/.exec(p)[1];
    out(st.issues.filter((x) => x.labels.includes(label)).sort((a, b) => b.number - a.number).slice(0, 1));
  } else if (p === 'labels' && method === 'POST') {
    if (st.labels.includes(f.name)) { save(); process.stderr.write('HTTP 422: already_exists\n'); process.exit(1); }
    st.labels.push(f.name); out({ name: f.name });
  } else if (p === 'issues' && method === 'POST') {
    const n = { number: st.issues.length + 1, title: f.title, body: f.body, state: 'open', labels: f.labels || [] };
    st.issues.push(n); out(n);
  } else if (/^issues\/\d+$/.test(p) && method === 'PATCH') {
    const n = st.issues.find((x) => x.number === Number(p.split('/')[1]));
    if (f.body !== undefined) n.body = f.body;
    if (f.state) n.state = f.state;
    out(n);
  } else if (p.startsWith('releases?') && method === 'GET') {
    // FAKE_GH_LAG=n: a new release shows up in the list only from the (n+1)th list call after its creation
    const lag = Number(process.env.FAKE_GH_LAG || 0);
    for (const r of st.releases) r.listCalls = (r.listCalls || 0) + 1;
    out(st.releases.filter((r) => !lag || r.listCalls > lag).map((r) => ({ id: r.id, tag_name: r.tag_name, draft: r.draft })));
  } else if (/^releases\/\d+\/assets/.test(p)) {
    const r = st.releases.find((x) => x.id === Number(p.split('/')[1]));
    out(r.assets.map((a) => ({ ...a, state: 'uploaded' })));
  } else {
    process.stderr.write(`fake gh: unknown api ${method} ${p}\n`); process.exit(2);
  }
} else if (args[0] === 'release' && args[1] === 'create') {
  if (!createRelease()) { save(); process.stderr.write('a release with the same tag name already exists\n'); process.exit(1); }
} else if (args[0] === 'release' && args[1] === 'upload') {
  const r = relByTag(args[2]);
  for (const a of args.slice(3).filter((x) => !x.startsWith('--'))) {
    r.assets = r.assets.filter((x) => x.name !== path.basename(a));
    // FAKE_GH_SHORT: the first upload of this file arrives truncated (check must notice it)
    const short = process.env.FAKE_GH_SHORT === path.basename(a) && !st.failed[`short:${a}`];
    if (short) st.failed[`short:${a}`] = 1;
    r.assets.push({ name: path.basename(a), size: fs.statSync(a).size - (short ? 1 : 0) });
  }
} else if (args[0] === 'release' && args[1] === 'edit') {
  const r = relByTag(args[2]);
  for (const a of args) {
    if (a.startsWith('--draft=')) r.draft = a.endsWith('true');
    if (a.startsWith('--latest=')) r.latest = a.endsWith('true');
  }
} else {
  process.stderr.write(`fake gh: unknown command ${line}\n`); process.exit(2);
}
save();
