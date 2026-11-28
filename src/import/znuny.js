// Import from Znuny / OTRS (Generic Interface, web service "GenericTicketConnectorREST"):
// adapter for the common import (./core.js).
// Queues become projects, the first article visible to the customer is the description, all other
// articles are comments (internal ones stay internal), attachments come with the ticket.
import { convert as htmlToText } from 'html-to-text';
import { createSourceHttp, SourceError } from './http.js';
import { parseFrom } from './zammad.js';
import { escapeHtml } from './kb-html.js';

const BATCH = 50; // tickets per TicketGet call while reading the overview

/** "2026-01-02 10:11:12" (server time, no zone) → Date in local time */
export function znunyDate(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(String(v || '').trim());
  return m ? new Date(`${m[1]}T${m[2]}`).toISOString() : (v || null);
}

/** StateType → category for the mapping suggestion */
export function znunyCategory(stateType, name = '') {
  const n = `${stateType} ${name}`.toLowerCase();
  if (/pending|warte/.test(n)) return 'waiting';
  if (/closed|merged|removed|geschlossen|zusammengefasst|entfernt/.test(n)) return 'done';
  if (/\bnew\b|\bneu\b/.test(n)) return 'new';
  return 'indeterminate';
}

/** Internal article? Znuny 6+/OTRS 7: IsVisibleForCustomer, OTRS 5 and older: ArticleType "…-internal" / "…-int" */
export function znunyInternal(a) {
  if (a.IsVisibleForCustomer !== undefined && a.IsVisibleForCustomer !== null && a.IsVisibleForCustomer !== '') return String(a.IsVisibleForCustomer) === '0';
  // "email-internal", "note-internal", but also the short forms "email-notification-int", "note-int"
  const type = String(a.ArticleType || '');
  return /internal/i.test(type) || /-int$/i.test(type.trim());
}

function articleText(a) {
  const body = String(a?.Body ?? '');
  if (/html/i.test(a?.ContentType || a?.MimeType || '')) return htmlToText(body, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim();
  return body.trim();
}

const asArray = (x) => (Array.isArray(x) ? x : (x ? [x] : []));

/** c.baseUrl: address of the web service, e.g. https://tickets.firma.local/otrs/nph-genericinterface.pl/Webservice/Helfi */
export function znunyAdapter(c) {
  const { base, basePath, json } = createSourceHttp({ baseUrl: c.baseUrl, verifyTls: c.verifyTls, caPem: c.caPem });
  let session = null;

  /** Generic Interface errors come as HTTP 200 with { Error: { ErrorCode, ErrorMessage } } */
  function check(r) {
    const err = r?.Error;
    if (!err) return r;
    const code = String(err.ErrorCode || '');
    const status = /AuthFail|InvalidSession|SessionID|AccessDenied/i.test(code) ? (/AccessDenied/i.test(code) ? 403 : 401) : 502;
    throw new SourceError(`Quellsystem meldet ${code || 'einen Fehler'}: ${err.ErrorMessage || ''}`.trim(), status);
  }

  async function login() {
    if (session) return session;
    const r = check(await json('/Session', { method: 'POST', body: { UserLogin: c.username || '', Password: c.password || '' } }));
    if (!r?.SessionID) throw new SourceError('Anmeldung beim Quellsystem fehlgeschlagen (Benutzer/Kennwort prüfen).', 401);
    session = r.SessionID;
    return session;
  }

  /** All ticket IDs (newer web services: POST /Ticket/Search, the classic example: GET /Ticket) */
  let ids = null;
  async function allIds() {
    if (ids) return ids;
    const sid = await login();
    const q = { SessionID: sid, Limit: 1000000, SortBy: 'Age', OrderBy: 'Down' };
    let r;
    try {
      r = check(await json('/Ticket/Search', { method: 'POST', body: q }));
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      r = check(await json(`/Ticket?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`));
    }
    // oldest first (created = ascending ID)
    ids = asArray(r?.TicketID).map(String).filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(a) - Number(b));
    return ids;
  }

  async function getTickets(list, { articles = false, attachments = false } = {}) {
    const sid = await login();
    const p = new URLSearchParams({ SessionID: sid, DynamicFields: '0', Extended: '0', AllArticles: articles ? '1' : '0', Attachments: attachments ? '1' : '0', GetAttachmentContents: attachments ? '1' : '0' });
    const r = check(await json(`/Ticket/${list.join(',')}?${p}`));
    return asArray(r?.Ticket);
  }

  /** Overview of all tickets (without articles), loaded once per adapter */
  let meta = null;
  async function overview() {
    if (meta) return meta;
    const all = await allIds();
    meta = [];
    for (let i = 0; i < all.length; i += BATCH) meta.push(...await getTickets(all.slice(i, i + BATCH)));
    return meta;
  }

  const queueKey = (tk) => String(tk.QueueID ?? tk.Queue ?? '');

  // ---------- FAQ (own web service GenericFAQConnectorREST, public FAQ entries only) ----------
  const FIELD_LABELS = {
    de: { Field1: 'Symptom', Field2: 'Problem', Field3: 'Lösung', Field4: 'Weitere Informationen', Field5: 'Weitere Informationen', Field6: 'Kommentar' },
    en: { Field1: 'Symptom', Field2: 'Problem', Field3: 'Solution', Field4: 'More information', Field5: 'More information', Field6: 'Comment' },
  };
  let faq = null;
  function faqHttp() {
    if (!c.faqUrl) throw new SourceError('Für die FAQ fehlt die Adresse des FAQ-Webservice (GenericFAQConnectorREST).', 400);
    faq ||= createSourceHttp({ baseUrl: c.faqUrl, verifyTls: c.verifyTls, caPem: c.caPem });
    return faq;
  }
  const faqGet = async (path, body) => {
    const h = faqHttp();
    // the example web service maps the routes to GET; some installations use POST
    try { return check(await h.json(`${path}?${new URLSearchParams(body)}`)); } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 400) throw e;
      return check(await h.json(path, { method: 'POST', body }));
    }
  };
  let faqItems = null;
  async function allFaq() {
    if (faqItems) return faqItems;
    const r = await faqGet('/PublicFAQSearch', { Limit: '100000' });
    const ids = asArray(r?.ID ?? r?.ItemID ?? r?.FAQID).map(String).filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(a) - Number(b));
    faqItems = [];
    for (let i = 0; i < ids.length; i += 50) {
      const g = await faqGet('/PublicFAQGet', { ItemID: ids.slice(i, i + 50).join(','), GetAttachmentContents: '1' });
      faqItems.push(...asArray(g?.FAQItem));
    }
    return faqItems;
  }
  const topOf = (name) => String(name || '').split('::')[0].trim() || '—';
  const fieldHtml = (v) => { const t = String(v || '').trim(); return /<\/?[a-z][^>]*>/i.test(t) ? t : escapeHtml(t).replace(/\n/g, '<br>'); };

  const kb = c.faqUrl ? {
    // the public FAQ interface needs no sign-in: only check that the web service answers
    async info() { await faqGet('/LanguageList', {}); return { title: 'Znuny / OTRS FAQ', version: '', user: '' }; },
    async spaces() {
      const items = await allFaq();
      const count = new Map();
      for (const it of items) count.set(topOf(it.CategoryName), (count.get(topOf(it.CategoryName)) || 0) + 1);
      const langs = [...new Set(items.map((it) => String(it.Language || '')).filter(Boolean))];
      return [...count].sort((x, y) => x[0].localeCompare(y[0])).map(([name, n]) => ({ key: name, name, count: n, languages: langs.map((code) => ({ code, name: code })) }));
    },
    async *articles(key, { language = null, lang = 'de' } = {}) {
      const labels = FIELD_LABELS[lang === 'en' ? 'en' : 'de'];
      for (const it of await allFaq()) {
        if (topOf(it.CategoryName) !== key) continue;
        if (language && it.Language && String(it.Language) !== String(language)) continue;
        const files = asArray(it.Attachment).map((a, n) => ({ ...a, n }));
        const html = ['Field1', 'Field2', 'Field3', 'Field4', 'Field5', 'Field6']
          .filter((f) => String(it[f] || '').trim())
          .map((f) => `<h2>${escapeHtml(labels[f])}</h2>${fieldHtml(it[f])}`).join('');
        const fileOf = (src) => { const m = /FileID[=:](\d+)/i.exec(src); return m ? files.find((a) => String(a.FileID) === m[1]) : null; };
        const load = (a) => async (max) => { const b = Buffer.from(String(a.Content || ''), 'base64'); if (b.length > max) throw new SourceError('zu groß', 413); return b; };
        yield {
          extId: `faq:${it.ItemID}`,
          title: it.Title || `FAQ ${it.ItemID}`,
          html,
          parentExtId: null,
          category: String(it.CategoryName || '').split('::').slice(1).join(' / ').slice(0, 60),
          visibility: 'public', // the public interface only delivers public entries
          draft: false,
          created: znunyDate(it.Created),
          updated: znunyDate(it.Changed || it.Created),
          author: it.CreatedBy ? { name: String(it.CreatedBy), email: '' } : null,
          linkKeys: [`znuny-faq:${it.ItemID}`],
          image: (src) => { const a = fileOf(src); return a ? { ref: `faq-file:${a.FileID ?? a.n}`, filename: a.Filename, load: load(a) } : null; },
          link: (href) => { const m = /ItemID[=;:](\d+)/i.exec(href); return /FAQ/i.test(href) && m ? { key: `znuny-faq:${m[1]}` } : null; },
          attachments: async () => files.map((a) => ({ extId: String(a.FileID ?? a.n), ref: `faq-file:${a.FileID ?? a.n}`, filename: a.Filename || 'datei', mime: a.ContentType || '', size: Number(a.Filesize) || Buffer.byteLength(String(a.Content || ''), 'base64'), load: load(a) })),
        };
      }
    },
  } : null;

  return {
    kb,
    kind: 'znuny',
    sourceId: `znuny:${base.host}${basePath}`,
    host: base.host,
    ticketSource: 'import',
    keyPrefix: 'Q',
    async info() {
      await login();
      return { title: 'Znuny / OTRS', version: '', user: c.username || '' };
    },
    async projects() {
      const byQueue = new Map();
      for (const tk of await overview()) {
        const k = queueKey(tk);
        const q = byQueue.get(k) || { key: k, name: tk.Queue || k, count: 0 };
        q.count++;
        byQueue.set(k, q);
      }
      return [...byQueue.values()].sort((a, b) => a.name.localeCompare(b.name))
        .map((q) => ({ ...q, suggestKey: String(q.name).split('::').pop() }));
    },
    async inspect(keys) {
      const want = new Set(keys.map(String));
      const statuses = new Map();
      const types = new Set();
      const counts = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const tk of await overview()) {
        const k = queueKey(tk);
        if (!want.has(k)) continue;
        counts[k]++;
        statuses.set(String(tk.State || ''), znunyCategory(tk.StateType, tk.State));
        types.add(String(tk.Type || ''));
      }
      return { statuses: [...statuses].map(([name, category]) => ({ name, category })), types: [...types], counts };
    },
    async count(key) { return (await overview()).filter((tk) => queueKey(tk) === String(key)).length; },
    async *tickets(key, options = {}) {
      for (const m of await overview()) {
        if (queueKey(m) !== String(key)) continue;
        let tk;
        try { [tk] = await getTickets([m.TicketID], { articles: true, attachments: options.attachments !== false }); } catch (e) {
          if (e.status === 401 || e.status === 403) throw e;
          yield { extId: String(m.TicketID), extKey: `#${m.TicketNumber || m.TicketID}`, fetchError: e }; // counted as failed, import goes on
          continue;
        }
        if (!tk) continue;
        const articles = asArray(tk.Article).sort((a, b) => Number(a.ArticleID) - Number(b.ArticleID));
        const first = articles.find((a) => !znunyInternal(a));
        const fromFirst = first ? parseFrom(first.From) : null;
        const customerId = String(tk.CustomerUserID || '');
        const reporter = fromFirst && (!customerId || !/@/.test(customerId) || fromFirst.email.toLowerCase() === customerId.toLowerCase())
          ? fromFirst : (customerId ? { email: /@/.test(customerId) ? customerId : '', name: customerId } : fromFirst);
        const noOwner = !tk.OwnerID || String(tk.OwnerID) === '1' || /^root@localhost$/i.test(tk.Owner || '');
        const done = /closed|merged|removed/i.test(tk.StateType || '');
        const author = (a) => parseFrom(a.From) || { name: a.FromRealname || '', email: '' };
        yield {
          extId: String(tk.TicketID),
          extKey: `#${tk.TicketNumber}`,
          number: /^\d+$/.test(String(tk.TicketNumber)) ? Number(tk.TicketNumber) : null,
          title: tk.Title,
          description: first ? articleText(first) : '',
          typeName: String(tk.Type || ''),
          statusName: String(tk.State || ''),
          statusCategory: znunyCategory(tk.StateType, tk.State),
          priorityName: String(tk.Priority || ''),
          labels: [],
          due: null,
          created: znunyDate(tk.Created),
          updated: znunyDate(tk.Changed || tk.Created),
          resolved: done ? znunyDate(tk.Closed || tk.Changed) : null,
          reporter,
          assignee: noOwner ? null : { username: tk.Owner, name: '', email: /@/.test(tk.Owner || '') ? tk.Owner : '', ref: `o${tk.OwnerID}` },
          comments: async () => articles.filter((a) => a !== first).map((a) => {
            const files = asArray(a.Attachment);
            const body = articleText(a) || (a.Subject ? String(a.Subject) : '');
            return body || files.length ? { extId: String(a.ArticleID), author: author(a), body: body || '📎', internal: znunyInternal(a), created: znunyDate(a.CreateTime) } : null;
          }).filter(Boolean),
          attachments: async () => {
            const out = [];
            for (const a of articles) {
              for (const f of asArray(a.Attachment)) {
                // HTML body of a mail is stored as "file-2" – it is the text, not a file
                if (/^file-\d+$/i.test(f.Filename || '') && /inline/i.test(f.Disposition || 'inline')) continue;
                const content = String(f.Content || '');
                out.push({
                  extId: `${a.ArticleID}:${f.FileID || f.Filename}`, filename: f.Filename, mime: String(f.ContentType || 'application/octet-stream').split(';')[0],
                  size: Number(f.FilesizeRaw) || Math.floor(content.length * 0.75), created: znunyDate(a.CreateTime), author: author(a),
                  internal: znunyInternal(a), commentExtId: a === first ? null : String(a.ArticleID),
                  load: async () => Buffer.from(content, 'base64'),
                });
              }
            }
            return out;
          },
        };
      }
    },
  };
}
