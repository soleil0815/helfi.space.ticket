// Mock knowledge bases for the knowledge import: Confluence (Cloud API v2 and Data Center API),
// Zammad, Zendesk Help Center, Freshdesk solutions, GLPI knowledge base and the Znuny FAQ web service.
import http from 'node:http';

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
export const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

function serve(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (status, body, headers = {}) => {
        const bin = Buffer.isBuffer(body) || typeof body === 'string';
        res.writeHead(status, { 'Content-Type': bin ? 'application/octet-stream' : 'application/json', ...headers });
        res.end(bin ? body : JSON.stringify(body));
      };
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      handler(req, url, send, body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, calls, close: () => server.close() });
  }));
}

/** Confluence: cloud = API v2 below /wiki (email + token), otherwise Data Center API (Bearer token) */
export async function startMockConfluence({ cloud = true, spaces = [{ key: 'IT', name: 'IT-Wissen', count: 3 }] } = {}) {
  const state = {
    // page 102 changes when the test sets state.v2
    v2: false,
  };
  const storage = (id) => ({
    101: `<h2>Überblick</h2><p>Siehe <ac:link><ri:page ri:content-title="VPN einrichten" /><ac:plain-text-link-body><![CDATA[die VPN-Anleitung]]></ac:plain-text-link-body></ac:link> und <ac:link><ri:page ri:content-title="Gibt es nicht" /></ac:link>.</p>
      <ac:structured-macro ac:name="warning"><ac:parameter ac:name="title">Achtung</ac:parameter><ac:rich-text-body><p>Nie das Kennwort weitergeben.</p></ac:rich-text-body></ac:structured-macro>
      <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">IT-1</ac:parameter></ac:structured-macro>`,
    102: `<p>${state.v2 ? 'Neue Fassung: ' : ''}Client starten.</p><p><ac:image ac:alt="Fenster"><ri:attachment ri:filename="fenster.png" /></ac:image></p>
      <ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[vpn --connect <firma>]]></ac:plain-text-body></ac:structured-macro>
      <p><ac:link><ri:attachment ri:filename="Profil.pdf" /></ac:link></p><p><img src="https://evil.example/x.png"></p>`,
    103: '<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Zertifikat</ac:task-body></ac:task></ac:task-list>',
  }[id]);
  const pages = [
    { id: '101', title: 'Start', parentId: null },
    { id: '102', title: 'VPN einrichten', parentId: '101' },
    { id: '103', title: 'Zertifikat', parentId: '102' },
  ];
  const atts = { 102: [{ id: 'att1', title: 'fenster.png', mediaType: 'image/png', fileSize: PNG.length }, { id: 'att2', title: 'Profil.pdf', mediaType: 'application/pdf', fileSize: PDF.length }, { id: 'att3', title: 'Notiz.txt', mediaType: 'text/plain', fileSize: 5 }] };
  const content = { att1: PNG, att2: PDF, att3: 'Notiz' };
  const updated = (id) => (id === '102' && state.v2 ? '2026-03-01T10:00:00.000Z' : '2026-01-02T10:00:00.000Z');
  const ctx = cloud ? '/wiki' : '/confluence';
  const srv = await serve((req, url, send) => {
    const auth = req.headers.authorization || '';
    const ok = cloud ? auth === `Basic ${Buffer.from('admin@firma.local:cf-token').toString('base64')}` : auth === 'Bearer dc-token';
    if (!url.pathname.startsWith(ctx)) return send(404, { message: 'no' });
    const p = url.pathname.slice(ctx.length);
    if (p.startsWith('/download/')) {
      const id = /\/attachments\/\d+\/([^/?]+)/.exec(p)?.[1];
      const a = Object.values(atts).flat().find((x) => x.title === decodeURIComponent(id || ''));
      return ok && a ? send(200, content[a.id]) : send(404, 'x');
    }
    if (!ok) return send(401, { message: 'Unauthorized' });
    if (p === '/rest/api/user/current') return send(200, { displayName: 'helfi-import', username: 'helfi-import' });
    if (p === '/rest/api/user') return send(200, { displayName: 'Anna Agentin', email: 'anna@firma.local' });
    if (p === '/rest/applinks/1.0/manifest') return send(200, { version: '8.5.9' });
    if (p === '/rest/api/search') return send(200, { totalSize: spaces.find((x) => (url.searchParams.get('cql') || '').includes(`"${x.key}"`))?.count ?? 0, results: [] });
    if (cloud) {
      if (p === '/api/v2/spaces' && url.searchParams.get('keys')) return send(200, { results: [{ id: '9001', key: 'IT', name: 'IT-Wissen' }] });
      if (p === '/api/v2/spaces') return send(200, { results: spaces.map((x, i) => ({ id: String(9001 + i), key: x.key, name: x.name })), _links: {} });
      if (p === '/api/v2/spaces/9001/pages') {
        // two pages per call to test the "next" links
        const start = Number(url.searchParams.get('cursor') || 0);
        const list = pages.slice(start, start + 2).map((x) => ({
          id: x.id, title: x.title, parentId: x.parentId, parentType: x.parentId ? 'page' : null, authorId: 'acc-1', createdAt: '2026-01-01T09:00:00.000Z',
          version: { createdAt: updated(x.id), number: 1 }, body: { storage: { value: storage(Number(x.id)), representation: 'storage' } }, _links: { webui: `/spaces/IT/pages/${x.id}` },
        }));
        return send(200, { results: list, _links: start + 2 < pages.length ? { next: `/wiki/api/v2/spaces/9001/pages?cursor=${start + 2}&body-format=storage` } : {} });
      }
      const m = /^\/api\/v2\/pages\/(\d+)\/attachments$/.exec(p);
      if (m) return send(200, { results: (atts[m[1]] || []).map((a) => ({ id: a.id, title: a.title, mediaType: a.mediaType, fileSize: a.fileSize, downloadLink: `/download/attachments/${m[1]}/${encodeURIComponent(a.title)}?api=v2` })), _links: {} });
    } else {
      if (p === '/rest/api/space') return send(200, { results: spaces.map((x) => ({ key: x.key, name: x.name })), _links: {} });
      if (p === '/rest/api/content') {
        const start = Number(url.searchParams.get('start') || 0);
        const list = pages.slice(start, start + 2).map((x) => ({
          id: x.id, title: x.title, ancestors: x.parentId ? [{ id: '101' }, ...(x.id === '103' ? [{ id: '102' }] : [])] : [],
          version: { when: updated(x.id), by: { displayName: 'Anna Agentin' } }, history: { createdDate: '2026-01-01T09:00:00.000Z', createdBy: { displayName: 'Anna Agentin' } },
          body: { storage: { value: storage(Number(x.id)) } },
        }));
        return send(200, { results: list, _links: start + 2 < pages.length ? { next: `/rest/api/content?spaceKey=IT&start=${start + 2}&limit=2` } : {} });
      }
      const m = /^\/rest\/api\/content\/(\d+)\/child\/attachment$/.exec(p);
      if (m) return send(200, { results: (atts[m[1]] || []).map((a) => ({ id: a.id, title: a.title, extensions: { mediaType: a.mediaType, fileSize: a.fileSize }, _links: { download: `/download/attachments/${m[1]}/${encodeURIComponent(a.title)}` } })), _links: {} });
    }
    return send(404, { message: `unknown ${p}` });
  });
  return { ...srv, state, base: `${srv.url}${ctx}` };
}

/** Zammad: POST /knowledge_bases/init, one answer with include_contents, attachments */
export async function startMockZammadKb() {
  const assets = {
    KnowledgeBase: { 1: { id: 1 } },
    KnowledgeBaseLocale: { 1: { id: 1, knowledge_base_id: 1, system_locale_id: 10, primary: true }, 2: { id: 2, knowledge_base_id: 1, system_locale_id: 11, primary: false } },
    KnowledgeBaseTranslation: { 1: { id: 1, title: 'Hilfe', kb_locale_id: 1, knowledge_base_id: 1 } },
    KnowledgeBaseCategory: { 5: { id: 5, knowledge_base_id: 1, parent_id: null }, 6: { id: 6, knowledge_base_id: 1, parent_id: 5 }, 7: { id: 7, knowledge_base_id: 1, parent_id: null } },
    KnowledgeBaseCategoryTranslation: {
      50: { id: 50, title: 'IT', kb_locale_id: 1, category_id: 5 }, 60: { id: 60, title: 'Drucker', kb_locale_id: 1, category_id: 6 }, 70: { id: 70, title: 'Personal', kb_locale_id: 1, category_id: 7 },
      61: { id: 61, title: 'Printers', kb_locale_id: 2, category_id: 6 },
    },
    KnowledgeBaseAnswer: {
      11: { id: 11, category_id: 6, published_at: '2026-01-01T00:00:00Z', internal_at: null, archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z' },
      12: { id: 12, category_id: 5, published_at: null, internal_at: '2026-01-01T00:00:00Z', archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z' },
      13: { id: 13, category_id: 5, published_at: null, internal_at: null, archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z' },
      14: { id: 14, category_id: 5, published_at: '2026-01-01T00:00:00Z', internal_at: null, archived_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z' },
      15: { id: 15, category_id: 7, published_at: '2026-01-01T00:00:00Z', internal_at: null, archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T00:00:00Z' },
    },
    KnowledgeBaseAnswerTranslation: {
      111: { id: 111, title: 'Drucker einrichten', kb_locale_id: 1, answer_id: 11, content_id: 1111, created_by_id: 3, updated_at: '2026-01-05T00:00:00Z' },
      112: { id: 112, title: 'Set up a printer', kb_locale_id: 2, answer_id: 11, content_id: 1112, created_by_id: 3, updated_at: '2026-01-05T00:00:00Z' },
      121: { id: 121, title: 'Interne Notiz', kb_locale_id: 1, answer_id: 12, content_id: 1211, created_by_id: 3 },
      131: { id: 131, title: 'Entwurf', kb_locale_id: 1, answer_id: 13, content_id: 1311, created_by_id: 3 },
      141: { id: 141, title: 'Archiviert', kb_locale_id: 1, answer_id: 14, content_id: 1411, created_by_id: 3 },
      151: { id: 151, title: 'Urlaub beantragen', kb_locale_id: 1, answer_id: 15, content_id: 1511, created_by_id: 3 },
    },
  };
  const bodies = {
    1111: '<p>Treiber laden.</p><p><img src="/api/v1/attachments/77" alt="Dialog"></p><p>Mehr unter <a href="/help/de-de/1/answer/12">interne Notiz</a>.</p>',
    1112: '<p>Load the driver.</p>', 1211: '<p>Nur intern.</p>', 1311: '<p>Noch nicht fertig.</p>', 1411: '<p>Alt.</p>', 1511: '<p>Im Portal.</p>',
  };
  return serve((req, url, send) => {
    if (req.headers.authorization !== 'Token token=zammad-token') return send(401, { error: 'authentication failed' });
    const p = url.pathname;
    let m;
    if (p === '/api/v1/users/me') return send(200, { firstname: 'Import', lastname: 'Konto' });
    if (p === '/api/v1/users/3') return send(200, { id: 3, firstname: 'Anna', lastname: 'Agentin', email: 'anna@firma.local' });
    if (p === '/api/v1/locales') return send(200, [{ id: 10, locale: 'de-de', name: 'Deutsch' }, { id: 11, locale: 'en-us', name: 'English' }]);
    if (p === '/api/v1/knowledge_bases/init' && req.method === 'POST') return send(200, assets);
    if ((m = /^\/api\/v1\/knowledge_bases\/1\/answers\/(\d+)$/.exec(p))) {
      const tr = Object.values(assets.KnowledgeBaseAnswerTranslation).find((x) => String(x.id) === url.searchParams.get('include_contents'));
      const ans = { ...assets.KnowledgeBaseAnswer[m[1]], attachments: m[1] === '11' ? [{ id: 77, url: '/api/v1/attachments/77', filename: 'dialog.png', size: String(PNG.length), preferences: { 'Content-Type': 'image/png' } }, { id: 78, url: '/api/v1/attachments/78', filename: 'Treiber.pdf', size: String(PDF.length), preferences: { 'Content-Type': 'application/pdf' } }] : [] };
      return send(200, { id: Number(m[1]), assets: { KnowledgeBaseAnswer: { [m[1]]: ans }, KnowledgeBaseAnswerTranslationContent: tr ? { [tr.content_id]: { id: tr.content_id, body: bodies[tr.content_id] } } : {} } });
    }
    if (p === '/api/v1/attachments/77') return send(200, PNG);
    if (p === '/api/v1/attachments/78') return send(200, PDF);
    return send(404, { error: `unknown ${p}` });
  });
}

/** Zendesk Help Center */
export async function startMockZendeskHc() {
  return serve((req, url, send) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('admin@firma.local/token:zd-token').toString('base64')}`) return send(401, { error: 'Couldn\'t authenticate you' });
    const p = url.pathname;
    if (p === '/api/v2/users/me.json') return send(200, { user: { id: 1, name: 'Import Konto' } });
    if (p === '/api/v2/users/show_many.json') return send(200, { users: [{ id: 3, name: 'Anna Agentin', email: 'anna@firma.local' }] });
    if (p === '/api/v2/help_center/locales.json') return send(200, { locales: ['de', 'en-us'], default_locale: 'de' });
    if (p === '/api/v2/help_center/de/categories.json') return send(200, { categories: [{ id: 1, name: 'Allgemein' }], next_page: null });
    if (p === '/api/v2/help_center/de/sections.json') return send(200, { sections: [{ id: 10, name: 'Konten', category_id: 1 }, { id: 11, name: 'Kennwort', category_id: 1, parent_section_id: 10 }], next_page: null });
    if (p === '/api/v2/help_center/user_segments.json') return send(200, { user_segments: [{ id: 500, user_type: 'staff' }, { id: 501, user_type: 'signed_in_users' }], next_page: null });
    if (p === '/api/v2/help_center/de/articles.json') {
      const all = [
        { id: 21, title: 'Kennwort ändern', body: '<p>So geht es.</p><div class="callout callout-tip"><p>Tipp: Manager nutzen</p></div><img src="/hc/article_attachments/31/schritt.png"> <a href="https://firma.zendesk.com/hc/de/articles/22-Nur-Agents">Agents</a>', section_id: 11, draft: false, user_segment_id: null, author_id: 3, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 22, title: 'Nur Agents', body: '<p>Intern.</p>', section_id: 10, draft: false, user_segment_id: 500, author_id: 3, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 23, title: 'Angemeldete', body: '<p>Alle Angemeldeten.</p>', section_id: 10, draft: false, user_segment_id: 501, author_id: 3, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 24, title: 'Entwurf', body: '<p>x</p>', section_id: 10, draft: true, user_segment_id: null, author_id: 3, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      ];
      // page 1 → next_page with page 2
      if (url.searchParams.get('page') === '2') return send(200, { articles: all.slice(2), next_page: null });
      return send(200, { articles: all.slice(0, 2), next_page: `${`http://${req.headers.host}`}/api/v2/help_center/de/articles.json?page=2&per_page=100` });
    }
    const m = /^\/api\/v2\/help_center\/articles\/(\d+)\/attachments\.json$/.exec(p);
    if (m) return send(200, { article_attachments: m[1] === '21' ? [{ id: 31, file_name: 'schritt.png', content_url: `http://${req.headers.host}/hc/article_attachments/31/schritt.png`, content_type: 'image/png', size: PNG.length, inline: true }, { id: 32, file_name: 'Richtlinie.pdf', content_url: `http://${req.headers.host}/hc/article_attachments/32/Richtlinie.pdf`, content_type: 'application/pdf', size: PDF.length, inline: false }] : [], next_page: null });
    if (p === '/hc/article_attachments/31/schritt.png') return send(200, PNG);
    if (p === '/hc/article_attachments/32/Richtlinie.pdf') return send(200, PDF);
    return send(404, { error: `unknown ${p}` });
  });
}

/** Freshdesk solutions */
export async function startMockFreshdeskSolutions() {
  return serve((req, url, send) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('fd-key:X').toString('base64')}`) return send(401, { code: 'invalid_credentials' });
    const p = url.pathname;
    if (p === '/api/v2/agents/me') return send(200, { contact: { name: 'Import Konto' } });
    if (p === '/api/v2/agents/7') return send(200, { contact: { name: 'Anna Agentin', email: 'anna@firma.local' } });
    if (p === '/api/v2/contacts/7') return send(404, { code: 'not_found' });
    if (p === '/api/v2/solutions/categories') return send(200, [{ id: 1, name: 'IT-Hilfe' }, { id: 2, name: 'Leer' }]);
    if (p === '/api/v2/solutions/categories/1/folders') return send(200, [{ id: 100, name: 'Hardware', visibility: 1 }, { id: 101, name: 'Intern', visibility: 3 }]);
    if (p === '/api/v2/solutions/categories/2/folders') return send(200, []);
    if (p === '/api/v2/solutions/folders/100/subfolders') return send(200, [{ id: 102, name: 'Monitore', visibility: 2 }]);
    if (/^\/api\/v2\/solutions\/folders\/10[12]\/subfolders$/.test(p)) return send(200, []);
    if (p === '/api/v2/solutions/folders/100/articles') return send(200, url.searchParams.get('page') === '1' ? [{ id: 1001, title: 'Maus tauschen', description: '<p>Alte Maus abgeben.</p>', status: 2, agent_id: 7, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', attachments: [{ id: 9, name: 'Formular.pdf', content_type: 'application/pdf', size: PDF.length, attachment_url: `http://${req.headers.host}/files/9` }] }] : []);
    if (p === '/api/v2/solutions/folders/101/articles') return send(200, url.searchParams.get('page') === '1' ? [{ id: 1002, title: 'Lizenzen', description: '<p>Intern.</p>', status: 2, agent_id: 7, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', attachments: [] }, { id: 1003, title: 'Entwurf', description: '<p>x</p>', status: 1, agent_id: 7, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', attachments: [] }] : []);
    if (p === '/api/v2/solutions/folders/102/articles') return send(200, url.searchParams.get('page') === '1' ? [{ id: 1004, title: 'Monitor anschließen', description: '<p>HDMI.</p>', status: 2, agent_id: 7, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', attachments: [] }] : []);
    if (p === '/files/9') return send(200, PDF);
    return send(404, { code: `unknown ${p}` });
  });
}

/** GLPI knowledge base */
export async function startMockGlpiKb() {
  const items = [
    { id: 1, name: 'WLAN verbinden', answer: '&lt;p&gt;SSID &lt;b&gt;Firma&lt;/b&gt;&lt;/p&gt;&lt;p&gt;&lt;img src="/front/document.send.php?docid=40&amp;itemtype=KnowbaseItem&amp;items_id=1"&gt;&lt;/p&gt;', is_faq: 1, date_creation: '2026-01-01 08:00:00', date_mod: '2026-01-02 08:00:00', users_id: 2 },
    { id: 2, name: 'Server neu starten', answer: '&lt;p&gt;Nur Admins.&lt;/p&gt;', is_faq: 0, date_creation: '2026-01-01 08:00:00', date_mod: '2026-01-02 08:00:00', users_id: 2 },
    { id: 3, name: 'Ohne Kategorie', answer: 'Text', is_faq: 0, date_creation: '2026-01-01 08:00:00', date_mod: '2026-01-02 08:00:00', users_id: 0 },
  ];
  const links = { 1: [{ knowbaseitemcategories_id: 21 }], 2: [{ knowbaseitemcategories_id: 20 }], 3: [] };
  return serve((req, url, send) => {
    const p = url.pathname.replace(/^\/apirest\.php/, '');
    if (p === '/initSession') return req.headers.authorization === 'user_token glpi-token' ? send(200, { session_token: 'sess-1' }) : send(401, ['ERROR_GLPI_LOGIN_USER_TOKEN', '']);
    if (req.headers['session-token'] !== 'sess-1') return send(401, ['ERROR_SESSION_TOKEN_INVALID', '']);
    const range = /^(\d+)-(\d+)$/.exec(url.searchParams.get('range') || '');
    const page = (list) => { const [a, b] = range ? [Number(range[1]), Number(range[2])] : [0, 49]; if (a >= list.length && list.length) return send(400, ['ERROR_RANGE_EXCEED_TOTAL', '']); return send(200, list.slice(a, b + 1)); };
    let m;
    if (p === '/getFullSession') return send(200, { session: { glpiname: 'import', glpi_version: '10.0.18' } });
    if (p === '/KnowbaseItemCategory') return page([{ id: 20, name: 'Netzwerk', completename: 'Netzwerk', knowbaseitemcategories_id: 0 }, { id: 21, name: 'WLAN', completename: 'Netzwerk > WLAN', knowbaseitemcategories_id: 20 }]);
    if (p === '/KnowbaseItem') return page(items);
    if ((m = /^\/KnowbaseItem\/(\d+)\/KnowbaseItem_KnowbaseItemCategory$/.exec(p))) return send(200, links[m[1]] || []);
    if ((m = /^\/KnowbaseItem\/(\d+)\/Document_Item$/.exec(p))) return send(200, m[1] === '1' ? [{ documents_id: 40 }, { documents_id: 41 }] : []);
    if (p === '/Document/40') return url.searchParams.get('alt') === 'media' ? send(200, PNG) : send(200, { id: 40, filename: 'wlan.png', mime: 'image/png', filesize: PNG.length });
    if (p === '/Document/41') return url.searchParams.get('alt') === 'media' ? send(200, PDF) : send(200, { id: 41, filename: 'Zugang.pdf', mime: 'application/pdf', filesize: PDF.length });
    if (p === '/User/2') return send(200, { id: 2, name: 'anna', firstname: 'Anna', realname: 'Agentin' });
    if (p === '/User/2/UserEmail') return send(200, [{ email: 'anna@firma.local', is_default: 1 }]);
    return send(404, ['ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM', p]);
  });
}

/** Znuny FAQ web service (public operations, GET routes like the example GenericFAQConnectorREST) */
export async function startMockZnunyFaq() {
  const items = {
    1: { ItemID: '1', Title: 'Drucker streikt', CategoryName: 'IT::Drucker', Language: 'de', Field1: 'Kein Ausdruck', Field2: '', Field3: '<p>Neu starten <img src="index.pl?Action=CustomerFAQZoom;Subaction=DownloadAttachment;ItemID=1;FileID=5"></p>', Created: '2026-01-01 08:00:00', Changed: '2026-01-02 08:00:00', CreatedBy: 'anna',
      Attachment: [{ FileID: '5', Filename: 'knopf.png', ContentType: 'image/png', Filesize: String(PNG.length), Content: PNG.toString('base64'), Inline: '1' }, { FileID: '6', Filename: 'Handbuch.pdf', ContentType: 'application/pdf', Filesize: String(PDF.length), Content: PDF.toString('base64'), Inline: '0' }] },
    2: { ItemID: '2', Title: 'Urlaub', CategoryName: 'Personal', Language: 'de', Field1: 'Wie?', Field3: 'Im Portal\nbeantragen', Created: '2026-01-01 08:00:00', Changed: '2026-01-02 08:00:00' },
  };
  return serve((req, url, send) => {
    const p = url.pathname.replace(/^\/otrs\/nph-genericinterface\.pl\/Webservice\/GenericFAQConnectorREST/, '');
    if (p === '/LanguageList') return send(200, { Language: [{ ID: 1, Name: 'de' }] });
    if (p === '/PublicFAQSearch') return send(200, { ID: ['2', '1'] });
    if (p === '/PublicFAQGet') return send(200, { FAQItem: String(url.searchParams.get('ItemID') || '').split(',').map((id) => items[id]).filter(Boolean) });
    return send(200, { Error: { ErrorCode: 'Webservice.InvalidRoute', ErrorMessage: p } });
  });
}
