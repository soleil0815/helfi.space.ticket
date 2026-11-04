// Rendering of a text diff (knowledge base versions, previous version of a ticket description)
import { h } from './dom.js';
import { t } from './i18n.js';
import { diffLines } from './diff.js';

/** Diff old → new; unchanged sections are collapsed (3 lines of context). null = identical */
export function diffView(oldText, newText) {
  const lines = diffLines(oldText ?? '', newText ?? '');
  if (!lines.some((l) => l.op !== '=')) return null;
  const keep = new Set();
  lines.forEach((l, i) => { if (l.op !== '=') for (let k = i - 3; k <= i + 3; k++) keep.add(k); });
  const rows = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (l.op === '=' && !keep.has(i)) { skipped++; return; }
    if (skipped) { rows.push(h('div.diff-skip', t('kb.ver.unchanged', { n: skipped }))); skipped = 0; }
    if (l.op === '=') rows.push(h('div.diff-line', l.a || ' '));
    else if (l.op === '-') rows.push(h('div.diff-line.del', h('del', l.a || ' ')));
    else if (l.op === '+') rows.push(h('div.diff-line.ins', h('ins', l.b || ' ')));
    else rows.push(h('div.diff-line.chg', l.words.map((w) => (w.op === '=' ? w.text : h(w.op === '-' ? 'del' : 'ins', w.text)))));
  });
  if (skipped) rows.push(h('div.diff-skip', t('kb.ver.unchanged', { n: skipped })));
  return h('div.diff', rows);
}

export const diffLegend = () => h('div.diff-legend', h('del', t('kb.ver.removed')), ' ', h('ins', t('kb.ver.added')));
