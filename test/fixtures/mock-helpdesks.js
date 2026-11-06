// Mock GLPI (apirest.php), Zendesk (API v2) and Freshdesk (API v2) for tests.
import http from 'node:http';

function serve(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, body, headers = {}) => {
      const raw = Buffer.isBuffer(body) || typeof body === 'string';
      res.writeHead(status, { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...headers });
      res.end(raw ? body : JSON.stringify(body));
    };
    handler(req, url, send, server);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

export async function startMockGlpi() {
  const tickets = [
    { id: 41, entities_id: 0, name: 'Beamer Raum 3', content: '&lt;p&gt;Der Beamer zeigt &lt;b&gt;kein Bild&lt;/b&gt;.&lt;/p&gt;', status: 4, type: 1, priority: 4, date: '2025-04-01 08:00:00', date_mod: '2025-04-02 09:00:00', itilcategories_id: 7, time_to_resolve: '2025-04-10 17:00:00', is_deleted: 0 },
    { id: 42, entities_id: 0, name: 'Neue Maus', content: 'Bitte eine Maus', status: 6, type: 2, priority: 3, date: '2025-04-03 08:00:00', date_mod: '2025-04-04 09:00:00', solvedate: '2025-04-04 08:30:00', closedate: '2025-04-04 09:00:00', itilcategories_id: 0, is_deleted: 0 },
    { id: 43, entities_id: 2, name: 'Andere Einheit', content: 'x', status: 1, type: 1, priority: 3, date: '2025-04-05 08:00:00', date_mod: '2025-04-05 08:00:00', is_deleted: 0 },
    { id: 44, entities_id: 0, name: 'Gelöscht', content: 'x', status: 1, type: 1, priority: 3, date: '2025-04-05 08:00:00', date_mod: '2025-04-05 08:00:00', is_deleted: 1 },
  ];
  const users = { 2: { id: 2, name: 'anna', firstname: 'Anna', realname: 'Agentin' }, 5: { id: 5, name: 'kurt', firstname: 'Kurt', realname: 'Kunde' } };
  const mails = { 2: [{ email: 'anna@firma.local', is_default: 1 }], 5: [{ email: 'kurt@kunde.example', is_default: 1 }] };
  const ticketUsers = { 41: [{ users_id: 5, type: 1 }, { users_id: 2, type: 2 }], 42: [{ users_id: 0, type: 1, alternative_email: 'gast@kunde.example' }] };
  const followups = { 41: [{ id: 901, content: '&lt;p&gt;Kabel getauscht&lt;/p&gt;', is_private: 1, users_id: 2, date: '2025-04-01 09:00:00' }, { id: 902, content: 'Bitte testen', is_private: 0, users_id: 2, date: '2025-04-01 10:00:00' }] };
  const tasks = { 41: [{ id: 801, content: 'Ersatzlampe bestellen', is_private: 1, users_id_tech: 2, date: '2025-04-01 09:30:00' }] };
  const solutions = { 42: [{ id: 701, content: 'Maus ausgegeben', users_id: 2, date_creation: '2025-04-04 08:30:00' }] };
  const docItems = { 'Ticket/41': [{ documents_id: 31 }], 'ITILFollowup/901': [{ documents_id: 32 }] };
  const docs = { 31: { id: 31, filename: 'foto.jpg', mime: 'image/jpeg', filesize: 4 }, 32: { id: 32, filename: 'intern.txt', mime: 'text/plain', filesize: 6 } };
  const content = { 31: 'JPEG', 32: 'intern' };
  return serve((req, url, send) => {
    const p = url.pathname.replace(/^\/apirest\.php/, '');
    if (p === '/initSession') return req.headers.authorization === 'user_token glpi-token' ? send(200, { session_token: 'sess-1' }) : send(401, ['ERROR_GLPI_LOGIN_USER_TOKEN', 'parameter user_token seems invalid']);
    if (req.headers['session-token'] !== 'sess-1') return send(401, ['ERROR_SESSION_TOKEN_INVALID', 'session_token seems invalid']);
    const range = /^(\d+)-(\d+)$/.exec(url.searchParams.get('range') || '');
    const page = (list) => {
      const [a, b] = range ? [Number(range[1]), Number(range[2])] : [0, 49];
      if (a >= list.length && list.length) return send(400, ['ERROR_RANGE_EXCEED_TOTAL', 'Provided range exceed total count of data']);
      return send(200, list.slice(a, b + 1));
    };
    let m;
    if (p === '/getFullSession') return send(200, { session: { glpiname: 'import', glpifirstname: 'Import', glpirealname: 'Konto', glpi_version: '10.0.18' } });
    if (p === '/Ticket') return page(tickets);
    if (p === '/Entity') return page([{ id: 0, name: 'Root entity', completename: 'Root entity' }, { id: 2, name: 'Labor', completename: 'Root entity > Labor' }]);
    if ((m = /^\/User\/(\d+)$/.exec(p))) return users[m[1]] ? send(200, users[m[1]]) : send(404, ['ERROR_ITEM_NOT_FOUND', '']);
    if ((m = /^\/User\/(\d+)\/UserEmail$/.exec(p))) return send(200, mails[m[1]] || []);
    if ((m = /^\/Ticket\/(\d+)\/Ticket_User$/.exec(p))) return send(200, ticketUsers[m[1]] || []);
    if ((m = /^\/Ticket\/(\d+)\/ITILFollowup$/.exec(p))) return send(200, followups[m[1]] || []);
    if ((m = /^\/Ticket\/(\d+)\/TicketTask$/.exec(p))) return send(200, tasks[m[1]] || []);
    if ((m = /^\/Ticket\/(\d+)\/ITILSolution$/.exec(p))) return send(200, solutions[m[1]] || []);
    if ((m = /^\/(Ticket|ITILFollowup)\/(\d+)\/Document_Item$/.exec(p))) return send(200, docItems[`${m[1]}/${m[2]}`] || []);
    if ((m = /^\/Document\/(\d+)$/.exec(p))) return url.searchParams.get('alt') === 'media' ? send(200, content[m[1]]) : send(200, docs[m[1]]);
    if ((m = /^\/ITILCategory\/(\d+)$/.exec(p))) return send(200, { id: 7, name: 'Beamer', completename: 'Hardware > Beamer' });
    return send(404, ['ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM', p]);
  });
}

export async function startMockZendesk({ incremental = true } = {}) {
  const auth = `Basic ${Buffer.from('admin@firma.local/token:zd-token').toString('base64')}`;
  const tickets = [
    { id: 501, subject: 'WLAN im Seminarraum', status: 'hold', type: 'incident', priority: 'urgent', tags: ['wlan', 'seminar'], due_at: null, created_at: '2025-05-01T08:00:00Z', updated_at: '2025-05-02T08:00:00Z', requester_id: 11, assignee_id: 12, group_id: 77 },
    { id: 502, subject: 'Lizenz verlängern', status: 'closed', type: 'task', priority: 'low', tags: [], created_at: '2025-05-03T08:00:00Z', updated_at: '2025-05-04T08:00:00Z', requester_id: 11, assignee_id: null, group_id: 77 },
    { id: 503, subject: 'Ohne Gruppe', status: 'new', type: null, priority: null, tags: [], created_at: '2025-05-05T08:00:00Z', updated_at: '2025-05-05T08:00:00Z', requester_id: 11, group_id: null },
    { id: 504, subject: 'weg', status: 'deleted', created_at: '2025-05-05T08:00:00Z', updated_at: '2025-05-05T08:00:00Z', requester_id: 11, group_id: 77 },
  ];
  const users = { 11: { id: 11, name: 'Kurt Kunde', email: 'kurt@kunde.example', role: 'end-user' }, 12: { id: 12, name: 'Anna Agentin', email: 'anna@firma.local', role: 'agent' } };
  const comments = {
    501: [
      { id: 1, author_id: 11, plain_body: 'Das WLAN bricht ab.', public: true, created_at: '2025-05-01T08:00:00Z', attachments: [{ id: 91, file_name: 'screenshot.png', content_url: '/attachments/91', content_type: 'image/png', size: 3, inline: false }] },
      { id: 2, author_id: 12, plain_body: 'AP neu gestartet', public: false, created_at: '2025-05-01T09:00:00Z', attachments: [{ id: 92, file_name: 'ap.log', content_url: '/attachments/92', content_type: 'text/plain', size: 3 }] },
      { id: 3, author_id: 12, plain_body: 'Geht es wieder?', public: true, created_at: '2025-05-01T10:00:00Z', attachments: [] },
    ],
    502: [{ id: 4, author_id: 12, plain_body: 'Nur intern angelegt', public: false, created_at: '2025-05-03T08:00:00Z', attachments: [] }],
  };
  let server;
  const mock = await serve((req, url, send) => {
    if (req.headers.authorization !== auth && !url.pathname.startsWith('/attachments/')) return send(401, { error: 'Couldn\'t authenticate you' });
    const p = url.pathname;
    let m;
    if (p === '/api/v2/users/me.json') return send(200, { user: users[12] });
    if (p === '/api/v2/incremental/tickets/cursor.json') {
      if (!incremental) return send(403, { error: 'Forbidden', description: 'You do not have access to this page.' });
      if (url.searchParams.get('cursor') === 'c2') return send(200, { tickets: [tickets[2], tickets[3], { ...tickets[0] }], after_cursor: null, end_of_stream: true });
      return send(200, { tickets: tickets.slice(0, 2), after_cursor: 'c2', end_of_stream: false });
    }
    if (p === '/api/v2/tickets.json') {
      const first = !url.searchParams.get('page[after]');
      const host = `http://${req.headers.host}`;
      return send(200, first ? { tickets: tickets.slice(0, 2), meta: { has_more: true }, links: { next: `${host}/api/v2/tickets.json?page[size]=100&page[after]=x` } } : { tickets: tickets.slice(2), meta: { has_more: false }, links: {} });
    }
    if (p === '/api/v2/groups.json') return send(200, { groups: [{ id: 77, name: 'IT Support' }], meta: { has_more: false } });
    if (p === '/api/v2/users/show_many.json') return send(200, { users: url.searchParams.get('ids').split(',').map((id) => users[id]).filter(Boolean) });
    if ((m = /^\/api\/v2\/tickets\/(\d+)\/comments\.json$/.exec(p))) return send(200, { comments: comments[m[1]] || [], meta: { has_more: false } });
    if ((m = /^\/attachments\/(\d+)$/.exec(p))) return req.headers.authorization === auth ? send(200, m[1] === '91' ? 'PNG' : 'LOG') : send(401, { error: 'no' });
    return send(404, { error: 'InvalidEndpoint' });
  });
  server = mock;
  // content_url as absolute URL like Zendesk
  for (const list of Object.values(comments)) for (const c of list) for (const a of c.attachments) a.content_url = `${server.url}${a.content_url}`;
  return mock;
}

export async function startMockFreshdesk() {
  const auth = `Basic ${Buffer.from('fd-key:X').toString('base64')}`;
  const tickets = [
    { id: 61, subject: 'Telefon defekt', description: '<div>Das Telefon <b>klingelt nicht</b>.</div>', description_text: 'Das Telefon klingelt nicht.', status: 3, priority: 3, type: 'Incident', tags: ['telefon'], due_by: '2025-06-05T17:00:00Z', created_at: '2025-06-01T08:00:00Z', updated_at: '2025-06-02T08:00:00Z', requester_id: 21, responder_id: 22, group_id: 9,
      attachments: [{ id: 71, name: 'foto.jpg', content_type: 'image/jpeg', size: 4, attachment_url: '/files/71' }] },
    { id: 62, subject: 'Toner', description_text: 'Toner leer', status: 5, priority: 1, type: null, tags: [], created_at: '2025-06-03T08:00:00Z', updated_at: '2025-06-04T08:00:00Z', requester_id: 22, responder_id: null, group_id: null, stats: { closed_at: '2025-06-04T07:00:00Z' }, attachments: [] },
  ];
  const conv = {
    61: [
      { id: 801, body_text: 'Akku getauscht', private: true, user_id: 22, created_at: '2025-06-01T09:00:00Z', attachments: [{ id: 72, name: 'beleg.pdf', content_type: 'application/pdf', size: 3, attachment_url: '/files/72' }] },
      { id: 802, body: '<p>Bitte noch einmal probieren</p>', body_text: '', private: false, user_id: 22, created_at: '2025-06-01T10:00:00Z', attachments: [] },
    ],
  };
  return serve((req, url, send) => {
    const p = url.pathname;
    if (p.startsWith('/files/')) return send(200, p.endsWith('71') ? 'JPEG' : 'PDF'); // presigned storage URL: no login
    if (req.headers.authorization !== auth) return send(401, { code: 'invalid_credentials', message: 'You have to be logged in to perform this action.' });
    let m;
    if (p === '/api/v2/agents/me') return send(200, { id: 22, contact: { name: 'Anna Agentin', email: 'anna@firma.local' } });
    if (p === '/api/v2/groups') return send(200, Number(url.searchParams.get('page')) > 1 ? [] : [{ id: 9, name: 'Telefonie' }]);
    if (p === '/api/v2/tickets') {
      if (!url.searchParams.get('updated_since')) return send(200, []); // the real API returns only the last 30 days
      return send(200, Number(url.searchParams.get('page')) > 1 ? [] : tickets.map(({ attachments, description, ...t }) => t));
    }
    if ((m = /^\/api\/v2\/tickets\/(\d+)$/.exec(p))) {
      const t = tickets.find((x) => String(x.id) === m[1]);
      return t ? send(200, { ...t, attachments: t.attachments.map((a) => ({ ...a, attachment_url: `http://${req.headers.host}${a.attachment_url}` })) }) : send(404, {});
    }
    if ((m = /^\/api\/v2\/tickets\/(\d+)\/conversations$/.exec(p))) {
      if (Number(url.searchParams.get('page')) > 1) return send(200, []);
      return send(200, (conv[m[1]] || []).map((c) => ({ ...c, attachments: c.attachments.map((a) => ({ ...a, attachment_url: `http://${req.headers.host}${a.attachment_url}` })) })));
    }
    if ((m = /^\/api\/v2\/contacts\/(\d+)$/.exec(p))) return m[1] === '21' ? send(200, { id: 21, name: 'Kurt Kunde', email: 'kurt@kunde.example' }) : send(404, { code: 'access_denied' });
    if ((m = /^\/api\/v2\/agents\/(\d+)$/.exec(p))) return m[1] === '22' ? send(200, { id: 22, contact: { name: 'Anna Agentin', email: 'anna@firma.local' } }) : send(404, {});
    return send(404, { code: 'not_found' });
  });
}
