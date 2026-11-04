// Mock Jira for tests: Cloud (REST v3, ADF, search/jql with nextPageToken)
// and Server/Data Center (REST v2, wiki markup, search with startAt).
import http from 'node:http';

export function startMockJira({ type = 'cloud', issueCount = 3, throttleOnce = true } = {}) {
  const cloud = type === 'cloud';
  const api = cloud ? '/rest/api/3' : '/rest/api/2';
  const calls = [];
  let throttled = !throttleOnce;
  let server;

  const people = {
    anna: { accountId: 'a-1', name: 'anna', displayName: 'Anna Agentin', emailAddress: 'anna@firma.local' },
    kurt: { accountId: 'k-1', name: 'kurt', displayName: 'Kurt Kunde', emailAddress: 'kurt@kunde.example' },
    ghost: { accountId: 'g-1', displayName: 'Geist ohne Mail' }, // Cloud often hides email addresses
  };

  const text = (s) => (cloud
    ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] }
    : s);

  const issues = [];
  for (let n = 1; n <= issueCount; n++) {
    issues.push({
      id: String(10000 + n),
      key: `SUP-${n * 10}`, // gaps in the numbering as in real projects
      fields: {
        summary: `Vorgang ${n}`,
        description: n === 1
          ? (cloud
            ? { type: 'doc', version: 1, content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Drucker ' }, { type: 'text', text: 'Handbuch', marks: [{ type: 'link', attrs: { href: 'https://wiki.firma.local/d' } }] }] },
              { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Punkt A' }] }] }] },
            ] }
            : 'h2. Drucker\n* Punkt A\n[Handbuch|https://wiki.firma.local/d]\n{code}x=1{code}')
          : text(`Beschreibung ${n}`),
        issuetype: { name: n === 1 ? 'Bug' : (n === 2 ? 'Service Request' : 'Task') },
        status: n === 1
          ? { name: 'Waiting for customer', statusCategory: { key: 'indeterminate' } }
          : (n === 2 ? { name: 'Erledigt', statusCategory: { key: 'done' } } : { name: 'To Do', statusCategory: { key: 'new' } }),
        priority: { name: n === 1 ? 'Highest' : 'Medium' },
        labels: ['drucker', 'Import-Test'],
        created: `2024-0${Math.min(n, 9)}-01T10:00:00.000+0200`,
        updated: `2024-0${Math.min(n, 9)}-02T10:00:00.000+0200`,
        resolutiondate: n === 2 ? '2024-02-03T10:00:00.000+0200' : null,
        duedate: n === 1 ? '2024-12-24' : null,
        reporter: n === 3 ? people.ghost : people.kurt,
        creator: people.kurt,
        assignee: n === 1 ? people.anna : (n === 2 ? people.ghost : null),
        attachment: n === 1 ? [
          { id: '900', filename: 'fehler.log', mimeType: 'text/plain', size: 11, created: '2024-01-01T11:00:00.000+0200', author: people.kurt, content: 'ATTACH_URL/900' },
          { id: '901', filename: 'riesig.iso', mimeType: 'application/octet-stream', size: 999 * 1024 * 1024, created: '2024-01-01T11:00:00.000+0200', author: people.kurt, content: 'ATTACH_URL/901' },
        ] : [],
      },
    });
  }
  const comments = {
    10001: [
      { id: '5001', author: people.kurt, body: text('Bitte schnell!'), created: '2024-01-01T12:00:00.000+0200', ...(cloud ? { jsdPublic: true } : {}) },
      { id: '5002', author: people.anna, body: text('Intern: Toner bestellt'), created: '2024-01-01T13:00:00.000+0200', ...(cloud ? { jsdPublic: false } : { visibility: { type: 'role', value: 'Developers' } }) },
    ],
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      // Attachments: Cloud redirects to a foreign host (without credentials!)
      if (url.pathname.startsWith('/media/')) {
        if (req.headers.authorization) return send(res, 400, { error: 'Anmeldedaten an fremden Host geschickt!' });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('Fehler 4711');
      }
      const auth = req.headers.authorization || '';
      const okAuth = cloud ? auth === `Basic ${Buffer.from('admin@firma.local:cloud-token').toString('base64')}` : auth === 'Bearer pat-123';
      if (!okAuth) return send(res, 401, { errorMessages: ['Unauthorized'] });

      if (url.pathname.startsWith('/attach/')) {
        if (cloud) { res.writeHead(303, { Location: `http://127.0.0.1:${server.mediaPort}/media/${url.pathname.split('/').pop()}` }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('Fehler 4711');
      }
      if (url.pathname === `${api}/serverInfo`) return send(res, 200, { serverTitle: 'Test-Jira', version: cloud ? '1001.0.0' : '9.12.0', deploymentType: cloud ? 'Cloud' : 'Server' });
      if (url.pathname === `${api}/myself`) return send(res, 200, { displayName: 'Import Admin' });
      if (cloud && url.pathname === `${api}/project/search`) return send(res, 200, { isLast: true, values: [{ id: '1', key: 'SUP', name: 'Support' }, { id: '2', key: 'DEV_OPS', name: 'Dev Ops' }] });
      if (!cloud && url.pathname === `${api}/project`) return send(res, 200, [{ id: '1', key: 'SUP', name: 'Support' }]);
      if (url.pathname === `${api}/project/SUP/statuses`) {
        return send(res, 200, [{ name: 'Bug', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Waiting for customer', statusCategory: { key: 'indeterminate' } }, { name: 'Erledigt', statusCategory: { key: 'done' } }] }, { name: 'Task', statuses: [] }, { name: 'Service Request', statuses: [] }]);
      }
      if (cloud && url.pathname === `${api}/search`) return send(res, 410, { errorMessages: ['Removed'] });
      if (cloud && url.pathname === `${api}/search/approximate-count`) return send(res, 200, { count: issues.length });
      if (cloud && url.pathname === `${api}/search/jql` && req.method === 'POST') {
        if (!throttled) { throttled = true; return send(res, 429, { errorMessages: ['slow down'] }, { 'Retry-After': '0' }); }
        const b = JSON.parse(body || '{}');
        const start = b.nextPageToken ? Number(b.nextPageToken) : 0;
        const page = issues.slice(start, start + 2); // small pages → paging gets tested
        const fixed = page.map((i) => ({ ...i, fields: { ...i.fields, attachment: i.fields.attachment.map((a) => ({ ...a, content: `http://127.0.0.1:${server.address().port}/attach/${a.id}` })) } }));
        return send(res, 200, { issues: fixed, ...(start + 2 < issues.length ? { nextPageToken: String(start + 2) } : {}) });
      }
      if (!cloud && url.pathname === `${api}/search`) {
        const startAt = Number(url.searchParams.get('startAt') || 0);
        const max = Number(url.searchParams.get('maxResults') || 50);
        const page = max === 0 ? [] : issues.slice(startAt, startAt + 2);
        const fixed = page.map((i) => ({ ...i, fields: { ...i.fields, attachment: i.fields.attachment.map((a) => ({ ...a, content: `http://127.0.0.1:${server.address().port}/attach/${a.id}` })) } }));
        return send(res, 200, { startAt, maxResults: 2, total: issues.length, issues: fixed });
      }
      const cm = /\/issue\/(\d+)\/comment$/.exec(url.pathname);
      if (cm) {
        const list = comments[cm[1]] || [];
        return send(res, 200, { startAt: 0, maxResults: 100, total: list.length, comments: list });
      }
      send(res, 404, { errorMessages: [`unbekannt: ${url.pathname}`] });
    });
  };

  return new Promise((resolve) => {
    // second server simulates the foreign host for Cloud attachments
    const media = http.createServer(handler).listen(0, '127.0.0.1', () => {
      server = http.createServer(handler).listen(0, '127.0.0.1', () => {
        server.mediaPort = media.address().port;
        resolve({
          url: `http://127.0.0.1:${server.address().port}`,
          calls,
          issues,
          addIssue(i) { issues.push(i); },
          close: () => { server.close(); media.close(); },
        });
      });
    });
  });
}
