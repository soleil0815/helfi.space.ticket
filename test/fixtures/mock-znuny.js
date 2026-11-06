// Mock Znuny/OTRS web service (GenericTicketConnectorREST) for tests.
// classic: no POST /Ticket/Search (older example web service, GET /Ticket only)
import http from 'node:http';

export function startMockZnuny({ classic = false } = {}) {
  const calls = [];
  const sessions = new Set();
  const b64 = (s) => Buffer.from(s).toString('base64');
  const tickets = {
    7: { TicketID: '7', TicketNumber: '2025030110000071', Title: 'VPN geht nicht', Queue: 'Raw', QueueID: '2', State: 'open', StateType: 'open', Priority: '4 high', Type: 'Incident', Owner: 'anna', OwnerID: '5', CustomerUserID: 'kurt@kunde.example', Created: '2025-03-01 08:00:00', Changed: '2025-03-01 09:30:00',
      Article: [
        { ArticleID: '70', From: '"Kurt Kunde" <kurt@kunde.example>', Subject: 'VPN', Body: 'VPN verbindet nicht.', ContentType: 'text/plain; charset=utf-8', IsVisibleForCustomer: 1, SenderType: 'customer', CreateTime: '2025-03-01 08:00:00',
          Attachment: [{ Filename: 'file-2', ContentType: 'text/html', Content: b64('<p>VPN</p>'), FilesizeRaw: '10', Disposition: 'inline' }, { Filename: 'log.txt', ContentType: 'text/plain', Content: b64('timeout'), FilesizeRaw: '7', FileID: '1', Disposition: 'attachment' }] },
        { ArticleID: '71', From: 'Anna Agentin <anna@firma.local>', Subject: 'Notiz', Body: 'Zertifikat abgelaufen.', ContentType: 'text/plain', IsVisibleForCustomer: 0, SenderType: 'agent', CreateTime: '2025-03-01 09:00:00',
          Attachment: [{ Filename: 'cert.pem', ContentType: 'application/x-pem-file', Content: b64('-----BEGIN-----'), FilesizeRaw: '15', FileID: '2' }] },
        { ArticleID: '72', From: 'Anna Agentin <anna@firma.local>', Subject: 'Re: VPN', Body: '<p>Bitte neu verbinden.</p>', ContentType: 'text/html; charset=utf-8', ArticleType: 'email-external', SenderType: 'agent', CreateTime: '2025-03-01 09:30:00' },
      ] },
    8: { TicketID: '8', TicketNumber: '123', Title: 'Passwort', Queue: 'Raw', QueueID: '2', State: 'closed successful', StateType: 'closed', Priority: '3 normal', Type: 'Unclassified', Owner: 'root@localhost', OwnerID: '1', CustomerUserID: 'kurt', Created: '2025-02-01 08:00:00', Changed: '2025-02-02 08:00:00',
      Article: [{ ArticleID: '80', From: 'Kurt Kunde <kurt@kunde.example>', Body: 'Passwort vergessen', ContentType: 'text/plain', ArticleType: 'email-external', CreateTime: '2025-02-01 08:00:00' }] },
    9: { TicketID: '9', TicketNumber: '124', Title: 'Junk', Queue: 'Junk', QueueID: '3', State: 'new', StateType: 'new', Priority: '3 normal', Type: 'Unclassified', OwnerID: '1', Created: '2025-02-03 08:00:00', Changed: '2025-02-03 08:00:00', Article: [] },
  };
  const strip = (tk, all, att) => {
    const out = { ...tk };
    if (!all) delete out.Article;
    else if (!att) out.Article = tk.Article.map(({ Attachment, ...a }) => a);
    return out;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const p = url.pathname.replace(/^\/otrs\/nph-genericinterface\.pl\/Webservice\/Helfi/, '');
      if (p === '/Session' && req.method === 'POST') {
        if (body.UserLogin === 'import' && body.Password === 'geheim') { sessions.add('S1'); return send({ SessionID: 'S1' }); }
        return send({ Error: { ErrorCode: 'SessionCreate.AuthFail', ErrorMessage: 'SessionCreate: Authorization failing!' } });
      }
      const sid = body.SessionID || url.searchParams.get('SessionID');
      if (!sessions.has(sid)) return send({ Error: { ErrorCode: 'TicketSearch.AuthFail', ErrorMessage: 'Authorization failing!' } });
      if (p === '/Ticket/Search' && req.method === 'POST' && !classic) return send({ TicketID: Object.keys(tickets).reverse() });
      if (p === '/Ticket/Search') { res.writeHead(404); return res.end('no route'); }
      if (p === '/Ticket' && req.method === 'GET') return send({ TicketID: Object.keys(tickets).reverse() });
      const m = /^\/Ticket\/([\d,]+)$/.exec(p);
      if (m) {
        const all = url.searchParams.get('AllArticles') === '1';
        const att = url.searchParams.get('Attachments') === '1';
        return send({ Ticket: m[1].split(',').filter((id) => tickets[id]).map((id) => strip(tickets[id], all, att)) });
      }
      res.writeHead(404); res.end('no route');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/otrs/nph-genericinterface.pl/Webservice/Helfi`, calls, tickets, close: () => server.close(),
  })));
}
