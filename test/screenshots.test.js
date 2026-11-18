// Tests: every picture in README and manual comes from the screenshot script (scripts/screenshots.mjs),
// so that a run of the script brings all of them up to date – and no picture is missing or left over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, README_SHOTS } from '../scripts/screenshots/list.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const manuals = { de: 'docs/manual/handbuch.de.html', en: 'docs/manual/manual.en.html' };

test('the list has no duplicates', () => {
  assert.equal(new Set(SHOTS).size, SHOTS.length);
  assert.equal(new Set(README_SHOTS).size, README_SHOTS.length);
});

for (const [lang, file] of Object.entries(manuals)) {
  test(`manual (${lang}): every picture is made by the script and exists`, () => {
    const used = new Set([...read(file).matchAll(new RegExp(`img/${lang}/([a-z0-9-]+)\\.jpg`, 'g'))].map((m) => m[1]));
    assert.ok(used.size > 50, 'pictures found in the manual');
    const notMade = [...used].filter((n) => !SHOTS.includes(n));
    assert.deepEqual(notMade, [], 'pictures in the manual that the script does not make');
    const missing = [...used].filter((n) => !fs.existsSync(path.join(root, 'docs/manual/img', lang, `${n}.jpg`)));
    assert.deepEqual(missing, [], 'pictures missing on disk');
    const unused = SHOTS.filter((n) => !used.has(n));
    assert.deepEqual(unused, [], 'pictures the script makes but the manual does not use');
  });

  test(`manual (${lang}): no left-over picture files`, () => {
    const files = fs.readdirSync(path.join(root, 'docs/manual/img', lang)).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4));
    assert.deepEqual(files.filter((n) => !SHOTS.includes(n)), []);
  });
}

for (const [lang, file] of [['de', 'README.md'], ['en', 'README.en.md']]) {
  test(`README (${lang}): every picture is made by the script and exists`, () => {
    const used = new Set([...read(file).matchAll(/docs\/images\/([a-z0-9-]+)\.png/g)].map((m) => m[1]));
    assert.ok(used.size >= 3);
    for (const n of used) {
      assert.ok(n.endsWith(`-${lang}`), `${n}: picture of the other language`);
      assert.ok(README_SHOTS.includes(`readme-${n.slice(0, -lang.length - 1)}`), `${n}: not made by the script`);
      assert.ok(fs.existsSync(path.join(root, 'docs/images', `${n}.png`)), `${n}: missing`);
    }
  });
}
