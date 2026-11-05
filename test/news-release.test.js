// News: items of the upcoming version (version "") must not have been released already.
// Otherwise the next release shows them again as new. When a release is out, its items get
// their version number in src/news.json (see "_note" there) – this test catches a forgotten one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let lastTag = '';
try { lastTag = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0] || ''; } catch { /* no git */ }
const required = process.env.HELFI_REQUIRE_TAGS === '1';

test('News: nothing of the last release is still listed as upcoming', { skip: !lastTag && !required && 'no release tags (shallow clone)' }, () => {
  assert.ok(lastTag, 'release tags missing (checkout with fetch-depth: 0)');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'src/news.json'), 'utf8'));
  let released;
  try { released = JSON.parse(git('show', `${lastTag}:src/news.json`)); } catch { return; } // tag older than the news
  const version = lastTag.replace(/^v/, '');
  const shippedAsUpcoming = (released.entries.find((e) => e.version === '')?.items || []).map((i) => i.de);
  const upcoming = (current.entries.find((e) => e.version === '')?.items || []).map((i) => i.de);
  const stale = upcoming.filter((de) => shippedAsUpcoming.includes(de));
  assert.deepEqual(stale, [], `released with ${lastTag} – move to an entry "version": "${version}" in src/news.json`);
  // …and must not get lost: each one belongs to a released version
  const versioned = current.entries.filter((e) => e.version).flatMap((e) => e.items.map((i) => i.de));
  for (const de of shippedAsUpcoming) assert.ok(versioned.includes(de), `item released with ${lastTag} missing under "version": "${version}": ${de.slice(0, 60)}`);
});
