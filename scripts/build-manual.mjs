#!/usr/bin/env node
// Build the manual as PDF (German and English) from docs/manual/*.html.
// Needs Playwright with Chromium (not part of the program dependencies):
//   npx --yes playwright@1 install chromium   (once)
//   node scripts/build-manual.mjs
// Output: docs/Handbuch.pdf and docs/Manual.en.pdf
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manualDir = path.join(root, 'docs', 'manual');
// Version as in a release: highest tag (package.json does not count)
let version = '';
try { version = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).trim().replace(/^v/, ''); } catch { /* no git */ }
const versionArg = process.argv.find((a) => a.startsWith('--version='))?.slice(10) || version || 'dev';

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is missing: npm install --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const docs = [
  { src: 'handbuch.de.html', out: 'Handbuch.pdf', lang: 'de', footer: 'Helfi.Space – Handbuch', page: 'Seite' },
  { src: 'manual.en.html', out: 'Manual.en.pdf', lang: 'en', footer: 'Helfi.Space – Manual', page: 'Page' },
];

const browser = await chromium.launch();
for (const d of docs) {
  const date = new Date().toLocaleDateString(d.lang === 'de' ? 'de-DE' : 'en-GB', { year: 'numeric', month: 'long' });
  const html = fs.readFileSync(path.join(manualDir, d.src), 'utf8').replaceAll('{{VERSION}}', versionArg).replaceAll('{{DATE}}', date);
  // Write next to the source so relative paths (style.css, img/, logo) resolve
  const tmp = path.join(manualDir, `.build-${d.lang}.html`);
  fs.writeFileSync(tmp, html);
  const page = await browser.newPage();
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle' });
  await page.pdf({
    path: path.join(root, 'docs', d.out),
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font:8px Inter,'DejaVu Sans',sans-serif;color:#8590A2;padding:0 18mm;display:flex;justify-content:space-between"><span>${d.footer} · ${versionArg}</span><span>${d.page} <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    outline: true,
    tagged: true,
  });
  await page.close();
  fs.rmSync(tmp);
  console.log(`docs/${d.out}`);
}
await browser.close();
