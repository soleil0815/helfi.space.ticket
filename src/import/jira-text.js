// Convert Jira texts to plain text.
// - Jira Cloud (API v3) returns descriptions/comments as ADF (Atlassian Document Format, JSON)
// - Jira Server/Data Center (API v2) returns wiki markup

/** ADF → text (paragraphs, lists, code, links, mentions, tables) */
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const out = [];
  walk(node, out, { listDepth: 0 });
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Deeper nesting than this is not real content (stack overflow otherwise): only its text is kept
export const MAX_ADF_DEPTH = 100;

/** Text of all "text" nodes below node, without recursion */
function flatText(node, out) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (typeof n.text === 'string') out.push(n.text);
    const c = Array.isArray(n.content) ? n.content : [];
    for (let i = c.length - 1; i >= 0; i--) stack.push(c[i]);
  }
  out.push('\n\n');
}

function walk(node, out, ctx, depth = 0) {
  if (!node || typeof node !== 'object') return;
  if (depth > MAX_ADF_DEPTH) { flatText(node, out); return; }
  const d = depth + 1;
  const kids = (n, c = ctx) => (n.content || []).forEach((k) => walk(k, out, c, d));
  switch (node.type) {
    case 'doc': kids(node); break;
    case 'paragraph': kids(node); out.push('\n\n'); break;
    case 'heading': kids(node); out.push('\n\n'); break;
    case 'text': {
      const link = (node.marks || []).find((m) => m.type === 'link');
      const text = node.text || '';
      out.push(link && link.attrs?.href && link.attrs.href !== text ? `${text} (${link.attrs.href})` : text);
      break;
    }
    case 'hardBreak': out.push('\n'); break;
    case 'mention': out.push(node.attrs?.text || `@${node.attrs?.id || ''}`); break;
    case 'emoji': out.push(node.attrs?.text || node.attrs?.shortName || ''); break;
    case 'inlineCard': case 'blockCard': case 'embedCard': out.push(node.attrs?.url || ''); if (node.type !== 'inlineCard') out.push('\n\n'); break;
    case 'date': out.push(node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : ''); break;
    case 'status': out.push(`[${node.attrs?.text || ''}]`); break;
    case 'codeBlock': out.push('```\n'); kids(node); out.push('\n```\n\n'); break;
    case 'blockquote': {
      const inner = [];
      (node.content || []).forEach((k) => walk(k, inner, ctx, d));
      out.push(inner.join('').trim().split('\n').map((l) => `> ${l}`).join('\n'), '\n\n');
      break;
    }
    case 'bulletList': case 'orderedList': {
      let i = node.attrs?.order || 1;
      for (const item of node.content || []) {
        const inner = [];
        (item.content || []).forEach((k) => walk(k, inner, { listDepth: ctx.listDepth + 1 }, d));
        const bullet = node.type === 'orderedList' ? `${i++}.` : '-';
        const text = inner.join('').trim().replace(/\n+/g, '\n' + '  '.repeat(ctx.listDepth + 1));
        out.push(`${'  '.repeat(ctx.listDepth)}${bullet} ${text}\n`);
      }
      out.push('\n');
      break;
    }
    case 'table': {
      for (const row of node.content || []) {
        const cells = (row.content || []).map((cell) => {
          const inner = [];
          (cell.content || []).forEach((k) => walk(k, inner, ctx, d));
          return inner.join('').trim().replace(/\s*\n+\s*/g, ' ');
        });
        out.push(`| ${cells.join(' | ')} |\n`);
      }
      out.push('\n');
      break;
    }
    case 'rule': out.push('---\n\n'); break;
    case 'mediaSingle': case 'mediaGroup': kids(node); break;
    case 'media': out.push(`[${node.attrs?.alt || node.attrs?.id || 'Anhang'}]\n`); break;
    case 'panel': case 'expand': case 'nestedExpand': case 'layoutSection': case 'layoutColumn': case 'decisionList': case 'taskList':
      if (node.attrs?.title) out.push(`${node.attrs.title}\n`);
      kids(node);
      break;
    case 'taskItem': out.push(node.attrs?.state === 'DONE' ? '[x] ' : '[ ] '); kids(node); out.push('\n'); break;
    case 'decisionItem': out.push('→ '); kids(node); out.push('\n'); break;
    default: kids(node);
  }
}

/** Jira wiki markup → text (make the essentials readable, lose nothing) */
export function wikiToText(s) {
  if (!s) return '';
  let t = String(s).replace(/\r\n/g, '\n');
  t = t.replace(/\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/g, (_, c) => `\`\`\`\n${c.trim()}\n\`\`\``);
  t = t.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, (_, c) => `\`\`\`\n${c.trim()}\n\`\`\``);
  t = t.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, c) => c.trim().split('\n').map((l) => `> ${l}`).join('\n'));
  t = t.replace(/\{panel(?::[^}]*)?\}([\s\S]*?)\{panel\}/g, (_, c) => c.trim());
  t = t.replace(/\{color(?::[^}]*)?\}([\s\S]*?)\{color\}/g, '$1');
  t = t.replace(/^h[1-6]\.\s*/gm, '');
  t = t.replace(/^bq\.\s*/gm, '> ');
  t = t.replace(/^(\*+|#+)\s+/gm, (m, b) => `${'  '.repeat(b.length - 1)}${b[0] === '#' ? '1.' : '-'} `);
  t = t.replace(/!([^!\n|]+)(\|[^!\n]*)?!/g, '[$1]');
  t = t.replace(/\[([^|\]\n]+)\|([^\]\n]+)\]/g, (_, label, url) => (label === url ? url : `${label} (${url})`));
  t = t.replace(/\[(https?:\/\/[^\]\s]+)\]/g, '$1');
  t = t.replace(/\[~([^\]]+)\]/g, '@$1');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1$2');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/gm, '$1$2');
  t = t.replace(/\{\{([^}]+)\}\}/g, '$1');
  t = t.replace(/^----\s*$/gm, '---');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Text from Cloud (ADF) or Server (wiki) */
export function jiraText(value) {
  if (value && typeof value === 'object') return adfToText(value);
  return wikiToText(value);
}
