// Mock Zammad (REST API v1) for tests: groups, tickets with expand, articles, tags, attachments.
import http from 'node:http';

export function startMockZammad({ token = 'zammad-token', perPage = 100 } = {}) {
  const calls = [];
  const users = {
    1: { id: 1, login: '-', firstname: '-', lastname: '' },
    2: { id: 2, login: 'anna', firstname: 'Anna', lastname: 'Agentin', email: 'anna@firma.local' },
    3: { id: 3, login: 'kurt@kunde.example', firstname: 'Kurt', lastname: 'Kunde', email: 'kurt@kunde.example' },
    4: { id: 4, login: 'bodo', firstname: 'Bodo', lastname: 'Fremd', email: 'bodo@extern.example' },
  };
  const groups = [{ id: 1, name: 'Users', active: true }, { id: 2, name: 'IT::Service Desk', active: true }, { id: 3, name: 'Alt', active: false }];
  const tickets = [
    { id: 11, number: '31011', title: 'Drucker druckt nicht', group_id: 2, state: 'pending reminder', priority: '3 high', type: 'Incident', owner_id: 2, customer_id: 3, created_at: '2025-03-01T08:00:00.000Z', updated_at: '2025-03-02T09:00:00.000Z', close_at: null },
    { id: 12, number: '20250301100002', title: 'Neuer Laptop', group_id: 2, state: 'closed', priority: '2 normal', owner_id: 4, customer_id: 3, created_at: '2025-03-01T10:00:00.000Z', updated_at: '2025-03-05T10:00:00.000Z', close_at: '2025-03-05T10:00:00.000Z' },
    { id: 13, number: '31013', title: 'Andere Gruppe', group_id: 1, state: 'new', priority: '1 low', owner_id: 1, customer_id: 3, created_at: '2025-03-02T10:00:00.000Z', updated_at: '2025-03-02T10:00:00.000Z' },
  ];
  const articles = {
    11: [
      { id: 101, ticket_id: 11, from: 'Kurt Kunde <kurt@kunde.example>', content_type: 'text/html', body: '<p>Der <b>Drucker</b> im 2. OG</p><p>druckt nicht.</p>', internal: false, sender: 'Customer', type: 'email', created_by_id: 3, created_at: '2025-03-01T08:00:00.000Z',
        attachments: [{ id: 501, filename: 'fehler.txt', size: 11, preferences: { 'Content-Type': 'text/plain' } }, { id: 502, filename: 'logo.png', size: 900, preferences: { 'Content-Type': 'image/png', 'Content-Disposition': 'inline', 'Content-ID': 'logo@x' } }] },
      { id: 102, ticket_id: 11, from: 'Anna Agentin', content_type: 'text/plain', body: 'Toner bestellt, intern.', internal: true, sender: 'Agent', type: 'note', created_by_id: 2, created_at: '2025-03-01T09:00:00.000Z',
        attachments: [{ id: 503, filename: 'bestellung.pdf', size: 8, preferences: { 'Content-Type': 'application/pdf' } }] },
      { id: 103, ticket_id: 11, from: 'Anna Agentin', content_type: 'text/plain', body: 'Bitte morgen noch einmal testen.', internal: false, sender: 'Agent', type: 'email', created_by_id: 2, created_at: '2025-03-01T10:00:00.000Z', attachments: [] },
    ],
    12: [{ id: 201, ticket_id: 12, from: 'kurt@kunde.example', content_type: 'text/plain', body: 'Bitte einen Laptop.', internal: false, created_by_id: 3, created_at: '2025-03-01T10:00:00.000Z', attachments: [] }],
    13: [{ id: 301, ticket_id: 13, from: 'kurt@kunde.example', content_type: 'text/plain', body: 'Andere', internal: false, created_by_id: 3, created_at: '2025-03-02T10:00:00.000Z', attachments: [] }],
  };
  const files = { 501: 'Fehler 4711', 503: '%PDF-1.4' };
  const tags = { 11: ['drucker', '2.og'] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    if (req.headers.authorization !== `Token token=${token}`) return send(401, { error: 'authentication failed' });
    const p = url.pathname;
    let m;
    if (p === '/api/v1/users/me') return send(200, users[2]);
    if (p === '/api/v1/version') return send(200, { version: '6.4.1' });
    if ((m = /^\/api\/v1\/users\/(\d+)$/.exec(p))) return users[m[1]] ? send(200, users[m[1]]) : send(404, { error: 'not found' });
    if (p === '/api/v1/groups') return send(200, groups);
    if (p === '/api/v1/ticket_states') return send(200, [{ id: 1, name: 'new', state_type_id: 1 }, { id: 3, name: 'pending reminder', state_type_id: 3 }, { id: 4, name: 'closed', state_type_id: 5 }]);
    if (p === '/api/v1/ticket_state_types') return send(200, [{ id: 1, name: 'new' }, { id: 3, name: 'pending reminder' }, { id: 5, name: 'closed' }]);
    if (p === '/api/v1/tickets') {
      const page = Number(url.searchParams.get('page')) || 1;
      const per = Math.min(perPage, Number(url.searchParams.get('per_page')) || 50);
      return send(200, tickets.slice((page - 1) * per, page * per));
    }
    if ((m = /^\/api\/v1\/ticket_articles\/by_ticket\/(\d+)$/.exec(p))) return send(200, articles[m[1]] || []);
    if (p === '/api/v1/tags') return send(200, { tags: tags[url.searchParams.get('o_id')] || [] });
    if ((m = /^\/api\/v1\/ticket_attachment\/(\d+)\/(\d+)\/(\d+)$/.exec(p))) return files[m[3]] ? send(200, files[m[3]], 'application/octet-stream') : send(404, { error: 'nope' });
    return send(404, { error: `no route ${p}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, tickets, articles, close: () => server.close(),
  })));
}
