// Knowledge import: writes the articles an adapter delivers (see confluence.js, zammad.js …) into the
// knowledge base. One writer per import run.
// - An article is mapped to its source (kb_import_map): importing again updates it (new version only
//   if the text changed) and leaves unchanged ones alone – local edits stay unless the source changed.
// - Pictures in the text are loaded and stored like pasted ones, attached files as article files;
//   both are remembered (kb_import_assets) and not loaded twice.
// - The page tree is rebuilt for new articles; links between imported articles are resolved at the end.
// - No mails, no notifications. Tickets are not touched.
import { htmlToMarkdown, linkPlaceholder, PLACEHOLDER_RE, placeholderKey } from './kb-html.js';
import { MAX_FILES } from '../itil/kb.js';

export const KB_MAX_BODY = 100000; // like the editor

const SOURCE_NAMES = { confluence: 'Confluence', zammad: 'Zammad', znuny: 'Znuny/OTRS', glpi: 'GLPI', zendesk: 'Zendesk', freshdesk: 'Freshdesk' };
const MSG = {
  de: {
    note: (src, who) => `Importiert aus ${src}${who ? ` (${who})` : ''}`,
    cut: '*[Der Artikel war zu lang und wurde beim Import gekürzt.]*',
    missingFiles: (list) => `*[Nicht übernommene Anhänge: ${list}]*`,
  },
  en: {
    note: (src, who) => `Imported from ${src}${who ? ` (${who})` : ''}`,
    cut: '*[The article was too long and was shortened on import.]*',
    missingFiles: (list) => `*[Attachments not imported: ${list}]*`,
  },
};
// A link in the text format whose target is a placeholder: [text](/kb/~imp~…) or [text](/kb/~file~…)
const LINK_RE = (kind) => new RegExp(`\\[((?:\\\\.|[^\\]\\\\\\n]){0,2000})\\]\\(/kb/~${kind}~([A-Za-z0-9_-]{1,2000})\\)`, 'g');
const iso = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

/**
 * @param {object} p
 * @param {object} p.db
 * @param {object} p.kb      createKb(…)
 * @param {object} p.user    the admin who started the import (author of the versions)
 * @param {object} p.adapter (kind, sourceId)
 * @param {object} p.options { drafts, attachments, maxAttachmentMb, lang }
 * @param {object} p.counts  job counters (changed here)
 * @param {(msg: string) => void} p.error
 */
export function createKbWriter({ db, kb, user, adapter, options, counts, error }) {
  const source = adapter.sourceId;
  const L = MSG[options.lang === 'en' ? 'en' : 'de'];
  const srcName = SOURCE_NAMES[adapter.kind] || adapter.kind;
  const maxBytes = Math.min(1024, Math.max(1, Number(options.maxAttachmentMb) || 50)) * 1024 * 1024;
  const mapGet = db.prepare('SELECT article_id, source_updated, imported_at FROM kb_import_map WHERE source=? AND external_id=?');
  const mapSet = db.prepare(`INSERT INTO kb_import_map(source, external_id, article_id, source_updated) VALUES(?,?,?,?)
    ON CONFLICT(source, external_id) DO UPDATE SET article_id=excluded.article_id, source_updated=excluded.source_updated, imported_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  const assetGet = db.prepare('SELECT token FROM kb_import_assets WHERE source=? AND kind=? AND article_id=? AND external_ref=?');
  const assetSet = db.prepare('INSERT OR REPLACE INTO kb_import_assets(source, kind, article_id, external_ref, token) VALUES(?,?,?,?,?)');

  const byKey = new Map(); // link key / external id → article id (this run)
  const created = []; // { id, parentExtId } – the page tree is set for new articles only
  const touched = new Set(); // article ids whose text may contain placeholders
  const fallbacks = new Map(); // placeholder key → original address (if the target is not imported)

  /** Picture from the text → stored picture of the article (or reused from an earlier import) */
  async function storeImage(it, articleId, src, alt) {
    const ref = await it.image?.(src);
    if (!ref) return null;
    const known = assetGet.get(source, 'image', articleId, ref.ref);
    if (known && db.prepare('SELECT 1 FROM kb_images WHERE token=? AND article_id=?').get(known.token, articleId)) return { url: `/api/kb/images/${known.token}`, ref: ref.ref };
    const buf = await ref.load(Math.min(maxBytes, 20 * 1024 * 1024));
    const img = kb.storeImage({ buffer: buf, filename: ref.filename || alt || 'bild' }, { articleId, userId: user.id });
    if (!img) return null; // not a picture type the knowledge base shows
    assetSet.run(source, 'image', articleId, ref.ref, img.token);
    counts.images++;
    return { url: img.url, ref: ref.ref };
  }

  async function convert(it, articleId, usedRefs) {
    const fileLinks = [];
    const r = await htmlToMarkdown(it.html || '', {
      image: async (src, alt) => {
        const img = await storeImage(it, articleId, src, alt);
        if (img) usedRefs.add(img.ref);
        return img?.url || null;
      },
      link: (href) => {
        const t = it.link?.(String(href).slice(0, 2000)); // adapters match addresses with patterns: short text only
        if (t?.key) {
          const ph = linkPlaceholder(t.key);
          if (!fallbacks.has(t.key)) fallbacks.set(t.key, t.url || null);
          return ph;
        }
        if (t?.fileRef) { const ph = `/kb/~file~${Buffer.from(t.fileRef).toString('base64url')}`; fileLinks.push(t.fileRef); return ph; }
        return null;
      },
    });
    let md = r.markdown;
    if (r.truncated || md.length > KB_MAX_BODY - 200) {
      md = md.slice(0, KB_MAX_BODY - 200);
      const cut = md.lastIndexOf('\n\n');
      md = `${cut > KB_MAX_BODY / 2 ? md.slice(0, cut) : md}\n\n${L.cut}`;
      error(`${it.title}: zu lang, gekürzt`);
    }
    if (r.droppedImages) counts.skippedImages += r.droppedImages;
    return { md, fileLinks };
  }

  /** Attached files of the source (not the pictures already shown in the text) */
  async function attachFiles(it, articleId, usedRefs) {
    if (!options.attachments || !it.attachments) return [];
    const missing = [];
    let list;
    try { list = await it.attachments(); } catch (e) { error(`${it.title}: Anhänge nicht lesbar: ${e.message}`); return []; }
    let pos = db.prepare('SELECT COUNT(*) n FROM kb_files WHERE article_id=?').get(articleId).n;
    for (const a of list) {
      const ref = a.ref || `id:${a.extId}`;
      if (usedRefs.has(ref)) continue; // shown as a picture in the text
      const known = assetGet.get(source, 'file', articleId, ref);
      if (known && db.prepare('SELECT 1 FROM kb_files WHERE token=? AND article_id=?').get(known.token, articleId)) continue;
      if (a.size > maxBytes) { counts.skippedFiles++; missing.push(a.filename); error(`${it.title}: Anhang „${a.filename}“ zu groß (${Math.round(a.size / 1048576)} MB)`); continue; }
      if (pos >= MAX_FILES) { counts.skippedFiles++; missing.push(a.filename); continue; }
      try {
        const buffer = await a.load(maxBytes);
        if (buffer.length > maxBytes) throw new Error('zu groß');
        const token = kb.storeFile({ buffer, filename: a.filename, mime: a.mime }, { articleId, userId: user.id, position: pos++, createdAt: iso(a.created) });
        assetSet.run(source, 'file', articleId, ref, token);
        counts.files++;
      } catch (e) {
        counts.skippedFiles++;
        missing.push(a.filename);
        error(`${it.title}: Anhang „${a.filename}“: ${e.message}`);
      }
    }
    return missing;
  }

  /** Links to files (Confluence links to attachments) → the stored file of the article; not there → only the text */
  function fileLinkFix(md, articleId) {
    return md.replace(LINK_RE('file'), (m, text, enc) => {
      const ref = Buffer.from(enc, 'base64url').toString('utf8');
      const tk = assetGet.get(source, 'file', articleId, ref)?.token;
      return tk ? `[${text}](/api/kb/files/${tk})` : text;
    });
  }

  function setBody(articleId, body) {
    db.prepare('UPDATE kb_articles SET body=? WHERE id=?').run(body, articleId);
    // the version written by this import gets the same text (links resolved) – no extra version
    db.prepare('UPDATE kb_versions SET body=? WHERE article_id=? AND version=(SELECT MAX(version) FROM kb_versions WHERE article_id=?)').run(body, articleId, articleId);
  }

  return {
    /** One article of the source → created / updated / unchanged / skipped */
    async article(it, target) {
      const extId = String(it.extId);
      const remember = (id) => { byKey.set(`id:${extId}`, id); for (const k of it.linkKeys || []) byKey.set(k, id); };
      if (it.archived || (it.draft && !options.drafts)) { counts.skipped++; return; }
      const mapped = mapGet.get(source, extId);
      let id = mapped && db.prepare('SELECT 1 FROM kb_articles WHERE id=?').get(mapped.article_id) ? mapped.article_id : null;
      const srcUpdated = iso(it.updated);
      // Revision: the change date, or what the adapter gives instead (e.g. a checksum of the content of an export)
      const revision = it.revision ? String(it.revision) : srcUpdated;
      // Unchanged in the source since the last import (same revision, or none given) → leave it alone, local edits stay
      if (id && (!revision || revision === mapped.source_updated)) { counts.unchanged++; remember(id); return; }

      const title = String(it.title || extId).replace(/\s+/g, ' ').trim().slice(0, 200) || extId;
      const visibility = it.draft ? 'internal' : (it.visibility === 'public' ? 'public' : 'internal');
      const category = String(it.category || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const note = L.note(srcName, it.author?.name || '').slice(0, 200);
      const isNew = !id;
      if (isNew) {
        id = kb.create(user, { title, body: '', visibility, category, projectId: target.projectId, note }).id;
        created.push({ id, parentExtId: it.parentExtId ? String(it.parentExtId) : null, projectId: target.projectId });
      }
      const usedRefs = new Set();
      const { md } = await convert(it, id, usedRefs);
      const missing = await attachFiles(it, id, usedRefs);
      let body = fileLinkFix(md, id);
      if (missing.length) body = `${body}\n\n${L.missingFiles(missing.join(', '))}`.trim();
      if (isNew) {
        setBody(id, body);
        db.prepare('UPDATE kb_articles SET created_at=COALESCE(?, created_at), updated_at=COALESCE(?, updated_at) WHERE id=?').run(iso(it.created), srcUpdated || iso(it.created), id);
        counts.created++;
      } else {
        const before = db.prepare('SELECT body FROM kb_articles WHERE id=?').get(id).body;
        const cur = kb.update(user, id, { title, body, visibility, category, note });
        if (srcUpdated) db.prepare('UPDATE kb_articles SET updated_at=? WHERE id=? AND updated_at<?').run(srcUpdated, id, srcUpdated);
        counts[cur.body !== before || cur.title !== title ? 'updated' : 'unchanged']++;
      }
      // pictures belong to the article (stored with article_id already); placeholders are resolved in finish()
      if (PLACEHOLDER_RE.test(body)) touched.add(id);
      PLACEHOLDER_RE.lastIndex = 0;
      mapSet.run(source, extId, id, revision);
      remember(id);
    },

    /** After all articles: page tree of new articles, links between articles */
    finish() {
      const projectOf = (id) => db.prepare('SELECT project_id FROM kb_articles WHERE id=?').get(id)?.project_id;
      for (const c of created) {
        if (!c.parentExtId) continue;
        const parent = byKey.get(`id:${c.parentExtId}`) ?? (mapGet.get(source, c.parentExtId)?.article_id ?? null);
        // subpages share the project of their parent: only within the same target project
        if (parent && parent !== c.id && projectOf(parent) === c.projectId) db.prepare('UPDATE kb_articles SET parent_id=? WHERE id=?').run(parent, c.id);
      }
      for (const id of touched) {
        const body = db.prepare('SELECT body FROM kb_articles WHERE id=?').get(id)?.body;
        if (body === undefined) continue;
        const next = body.replace(LINK_RE('imp'), (m, text, enc) => {
          const key = placeholderKey(enc);
          const target = byKey.get(key);
          if (target) return `[${text}](/kb/${target})`;
          const url = fallbacks.get(key);
          return url ? `[${text}](${url})` : text; // target not imported: original address, else only the text
        }).replace(PLACEHOLDER_RE, (m, enc) => { const t = byKey.get(placeholderKey(enc)); return t ? `/kb/${t}` : `/kb/${id}`; });
        if (next !== body) setBody(id, next);
      }
    },
  };
}
