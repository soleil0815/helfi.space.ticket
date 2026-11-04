// Text diff (longest common subsequence): lines first, then changed lines word by word.

/** LCS table for two lists → sequence of { op: '=', '-', '+', a, b } */
function lcs(a, b, eq = (x, y) => x === y) {
  const n = a.length; const m = b.length;
  // split off common prefix and suffix first (saves memory on long texts)
  let start = 0;
  while (start < n && start < m && eq(a[start], b[start])) start++;
  let endA = n; let endB = m;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) { endA--; endB--; }
  const A = a.slice(start, endA); const B = b.slice(start, endB);
  const out = a.slice(0, start).map((x, i) => ({ op: '=', a: x, b: b[i] }));
  const N = A.length; const M = B.length;
  if (N * M > 4_000_000) {
    // very large change: coarse – remove all old, add all new
    for (const x of A) out.push({ op: '-', a: x });
    for (const y of B) out.push({ op: '+', b: y });
  } else {
    const L = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) L[i][j] = eq(A[i], B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0; let j = 0;
    while (i < N && j < M) {
      if (eq(A[i], B[j])) { out.push({ op: '=', a: A[i], b: B[j] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', a: A[i++] }); else out.push({ op: '+', b: B[j++] });
    }
    while (i < N) out.push({ op: '-', a: A[i++] });
    while (j < M) out.push({ op: '+', b: B[j++] });
  }
  for (let k = endA; k < n; k++) out.push({ op: '=', a: a[k], b: b[k - endA + endB] });
  return out;
}

/** Words including whitespace (whitespace is kept so the text fits back together) */
const tokens = (s) => String(s).match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];

/** Word diff of two lines → [{ op, text }] with merged chunks */
export function diffWords(a, b) {
  const parts = [];
  for (const d of lcs(tokens(a), tokens(b))) {
    const text = d.op === '+' ? d.b : d.a;
    const last = parts[parts.length - 1];
    if (last && last.op === d.op) last.text += text; else parts.push({ op: d.op, text });
  }
  return parts;
}

/**
 * Line diff → [{ op: '=' | '-' | '+' | '~', a, b, words? }]
 * A removed and an added block of equal length are paired into “changed” (~) with a word diff.
 */
export function diffLines(oldText, newText) {
  const raw = lcs(String(oldText).split('\n'), String(newText).split('\n'));
  const out = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i].op === '=') { out.push(raw[i]); i++; continue; }
    const del = []; const add = [];
    while (i < raw.length && raw[i].op !== '=') { (raw[i].op === '-' ? del : add).push(raw[i]); i++; }
    const pairs = Math.min(del.length, add.length);
    for (let k = 0; k < pairs; k++) out.push({ op: '~', a: del[k].a, b: add[k].b, words: diffWords(del[k].a, add[k].b) });
    for (let k = pairs; k < del.length; k++) out.push(del[k]);
    for (let k = pairs; k < add.length; k++) out.push(add[k]);
  }
  return out;
}
