// News: the release gives upcoming items ("") their version automatically (scripts/news-versions.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assignVersions } from '../scripts/news-versions.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const item = (de) => ({ audience: 'all', de, en: de });

test('Upcoming items get the release that first shipped them, new ones the version being built', () => {
  const entries = [
    { version: '', date: '', items: [item('A'), item('B'), item('C')] },
    { version: '1.2.0', date: '2026-01-02', items: [item('X')] },
  ];
  const history = [
    { version: '1.3.0', date: '2026-02-01', entries: [{ version: '', items: [item('A')] }, { version: '1.2.0', items: [item('X')] }] },
    { version: '1.4.0', date: '2026-03-01', entries: [{ version: '', items: [item('A'), item('B')] }] },
  ];
  const out = assignVersions(entries, '1.5.0', history, '2026-04-01');
  assert.deepEqual(out.map((e) => [e.version, e.date, e.items.map((i) => i.de)]), [
    ['1.5.0', '2026-04-01', ['C']],
    ['1.4.0', '2026-03-01', ['B']],
    ['1.3.0', '2026-02-01', ['A']],
    ['1.2.0', '2026-01-02', ['X']],
  ]);
  // Already under a version: not again; nothing upcoming: unchanged
  assert.deepEqual(assignVersions([{ version: '', items: [item('X')] }, ...entries.slice(1)], '1.5.0', history).map((e) => e.version), ['1.2.0']);
  // Versions sort numerically (1.10 after 1.9)
  const v = assignVersions([{ version: '', items: [item('N')] }, { version: '1.9.0', items: [item('O')] }], '1.10.0', []).map((e) => e.version);
  assert.deepEqual(v, ['1.10.0', '1.9.0']);
});

test('Script on a repository with release tags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helfi-news-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@firma.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@firma.example' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' });
  const write = (entries) => fs.writeFileSync(path.join(dir, 'src/news.json'), JSON.stringify({ entries }));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    git('init', '-q', '-b', 'main');
    write([{ version: '', items: [item('Erste Neuerung')] }]);
    git('add', '.'); git('commit', '-qm', 'one'); git('tag', 'v1.0.0');
    write([{ version: '', items: [item('Erste Neuerung'), item('Zweite Neuerung')] }]);
    git('commit', '-qam', 'two');
    execFileSync('node', [path.join(root, 'scripts/news-versions.mjs'), '1.1.0', 'src/news.json'], { cwd: dir, env });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'src/news.json'), 'utf8')).entries;
    assert.deepEqual(out.map((e) => [e.version, e.items.map((i) => i.de)]), [['1.1.0', ['Zweite Neuerung']], ['1.0.0', ['Erste Neuerung']]]);
    assert.match(out[1].date, /^\d{4}-\d{2}-\d{2}$/, 'date of the release tag');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('news.json in the repository is valid and has no item twice', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'src/news.json'), 'utf8'));
  const all = data.entries.flatMap((e) => e.items.map((i) => i.de));
  assert.equal(new Set(all).size, all.length, 'item listed twice');
  for (const e of data.entries) for (const i of e.items) assert.ok(['all', 'agent', 'admin'].includes(i.audience) && i.de && i.en, JSON.stringify(i));
});
