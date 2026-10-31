// Postfach abrufen (IMAP): neue E-Mails werden zu Tickets, Antworten zu Kommentaren.
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import { log } from '../lib/log.js';
import { ticketKeyFromSubject, cleanSubject, stripQuotedReply, isAutomated, isEmail } from './parse.js';

export const MAX_NEW_TICKETS_PER_HOUR = 20;

export function imapOptions(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'tls',
    doSTARTTLS: cfg.security === 'starttls' ? true : (cfg.security === 'none' ? false : undefined),
    auth: { user: cfg.user, pass: cfg.password },
    tls: { rejectUnauthorized: cfg.verifyTls, minVersion: 'TLSv1.2' },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 120000,
  };
}

export function createMailProcessor({ db, settings, tickets, users }) {
  const seen = db.prepare('SELECT ticket_id FROM mail_messages WHERE message_id=?');
  const remember = db.prepare("INSERT OR IGNORE INTO mail_messages(message_id,ticket_id,direction) VALUES(?,?,'in')");

  /** Ticket zu einer Antwort finden: über unsere Message-ID (nicht erratbar) oder [KEY-123] im Betreff. */
  function findTicket(parsed) {
    const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references])]
      .filter(Boolean).map((r) => String(r).replace(/[<>]/g, '').trim());
    for (const r of refs) {
      const row = seen.get(r);
      if (row?.ticket_id) return { id: row.ticket_id, via: 'reference' };
    }
    const k = ticketKeyFromSubject(parsed.subject);
    if (k) {
      const row = db.prepare('SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key=? AND t.number=?').get(k.projectKey, k.number);
      if (row) return { id: row.id, via: 'subject' };
    }
    return null;
  }

  /** Darf dieser Absender per Betreff-Nummer in das Ticket schreiben? (Melder, Bearbeiter, bisherige Beteiligte) */
  function isParticipant(ticketId, sender, fromAddr) {
    if (sender.role === 'agent' || sender.role === 'admin') return true;
    const t = db.prepare('SELECT reporter_id, reporter_email FROM tickets WHERE id=?').get(ticketId);
    if (!t) return false;
    if (t.reporter_id === sender.id || String(t.reporter_email || '').toLowerCase() === fromAddr) return true;
    return !!db.prepare('SELECT 1 FROM comments WHERE ticket_id=? AND (author_id=? OR lower(author_email)=?) LIMIT 1').get(ticketId, sender.id, fromAddr);
  }

  /** Verarbeitet eine geparste E-Mail. Liefert eine kurze Beschreibung, was passiert ist. */
  function process(parsed) {
    const cfg = settings.group('imap');
    const from = parsed.from?.value?.[0];
    const fromAddr = String(from?.address || '').toLowerCase();
    const messageId = String(parsed.messageId || '').replace(/[<>]/g, '').trim()
      || 'nomsgid-' + crypto.createHash('sha256').update(`${fromAddr}|${parsed.subject}|${parsed.date}|${parsed.text?.slice(0, 500)}`).digest('hex');

    if (seen.get(messageId)) return { action: 'duplicate', messageId };
    if (!isEmail(fromAddr)) { remember.run(messageId, null); return { action: 'skipped', reason: 'no-sender', messageId }; }

    const own = [settings.get('smtp.from'), cfg.user].filter(Boolean).map((x) => x.toLowerCase());
    if (own.includes(fromAddr) || isAutomated(parsed.headers, fromAddr)) {
      remember.run(messageId, null);
      return { action: 'skipped', reason: 'automated', messageId };
    }

    const sender = users.byEmail(fromAddr) || users.contactForEmail(fromAddr, from?.name || '');
    if (!sender.active) { remember.run(messageId, null); return { action: 'skipped', reason: 'inactive', messageId }; }

    // Reine HTML-Mails (z. B. aus Outlook) in lesbaren Text umwandeln
    const text = String(parsed.text || '').trim()
      || (parsed.html ? htmlToText(parsed.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] }).trim() : '');
    const maxBytes = (cfg.maxAttachmentMb || 20) * 1024 * 1024;
    const files = (parsed.attachments || []).filter((a) => a.content && a.size <= maxBytes && !(a.related && a.size < 30 * 1024));

    const found = findTicket(parsed);
    // Wer nur die (fortlaufende) Ticketnummer kennt, aber nicht beteiligt ist, bekommt ein neues Ticket
    const existingId = found && (found.via === 'reference' || isParticipant(found.id, sender, fromAddr)) ? found.id : null;

    // Schutz vor Mail-Schleifen mit Autorespondern ohne Kennzeichnung
    if (!existingId) {
      const recent = db.prepare("SELECT COUNT(*) n FROM tickets WHERE lower(reporter_email)=? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(fromAddr).n;
      if (recent >= MAX_NEW_TICKETS_PER_HOUR) { remember.run(messageId, null); return { action: 'skipped', reason: 'rate', messageId }; }
    }

    return db.transaction(() => {
      if (existingId) {
        const comment = tickets.addComment(sender, existingId, { body: stripQuotedReply(text) || '(leer)' }, {
          source: 'email', authorEmail: fromAddr, authorName: from?.name || null, skipPermission: true,
        });
        for (const a of files) tickets.addAttachment(existingId, { filename: a.filename, mime: a.contentType, buffer: a.content }, sender.id, comment.id);
        remember.run(messageId, existingId);
        return { action: 'comment', ticketId: existingId, messageId };
      }
      const projectKey = cfg.project || settings.get('general.defaultProject');
      const project = projectKey ? tickets.projects.get(projectKey) : null;
      const ticket = tickets.create(sender, {
        title: cleanSubject(parsed.subject) || '(ohne Betreff / no subject)',
        description: text,
        projectId: project?.id,
        type: 'request',
      }, { source: 'email', reporterEmail: fromAddr, reporterName: from?.name || null, reporterId: sender.id, messageId });
      for (const a of files) tickets.addAttachment(ticket.id, { filename: a.filename, mime: a.contentType, buffer: a.content }, sender.id, null);
      remember.run(messageId, ticket.id);
      return { action: 'ticket', ticketId: ticket.id, key: ticket.key, messageId };
    })();
  }

  return { process, parse: (source) => simpleParser(source) };
}

export function createImapPoller({ settings, processor }) {
  const status = { running: false, lastRun: null, lastError: null, lastResult: null, processedTotal: 0 };
  const failures = new Map();
  let timer = null;

  async function pollOnce() {
    const cfg = settings.group('imap');
    if (!cfg.enabled || !cfg.host || !cfg.user) return { skipped: true };
    if (status.running) return { busy: true };
    status.running = true;
    const result = { tickets: 0, comments: 0, skipped: 0, errors: 0 };
    const client = new ImapFlow(imapOptions(cfg));
    client.on('error', (e) => log.warn('IMAP-Fehler', { error: e.message }));
    try {
      await client.connect();
      if (cfg.processedFolder) {
        try { await client.mailboxCreate(cfg.processedFolder); } catch { /* existiert schon */ }
      }
      const lock = await client.getMailboxLock(cfg.folder || 'INBOX');
      try {
        const uids = (await client.search({ seen: false }, { uid: true })) || [];
        for (const uid of uids.slice(0, 200)) {
          try {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg?.source) continue;
            const parsed = await processor.parse(msg.source);
            const r = processor.process(parsed);
            if (r.action === 'ticket') { result.tickets++; log.info(`E-Mail → neues Ticket ${r.key}`); }
            else if (r.action === 'comment') { result.comments++; log.info(`E-Mail → Kommentar zu Ticket #${r.ticketId}`); }
            else result.skipped++;
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            if (cfg.processedFolder) await client.messageMove(String(uid), cfg.processedFolder, { uid: true });
            failures.delete(uid);
          } catch (e) {
            result.errors++;
            const n = (failures.get(uid) || 0) + 1;
            failures.set(uid, n);
            log.error(`E-Mail UID ${uid} konnte nicht verarbeitet werden (Versuch ${n})`, { error: e.message });
            if (n >= 3) {
              // Nach 3 Fehlversuchen als gelesen markieren und markieren, damit sie nicht endlos blockiert
              await client.messageFlagsAdd(String(uid), ['\\Seen', '\\Flagged'], { uid: true }).catch(() => {});
              failures.delete(uid);
            }
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
      status.lastError = null;
    } catch (e) {
      status.lastError = e.message;
      log.warn('Postfach-Abruf fehlgeschlagen', { error: e.message });
      try { client.close(); } catch { /* egal */ }
    } finally {
      status.running = false;
      status.lastRun = new Date().toISOString();
      status.lastResult = result;
      status.processedTotal += result.tickets + result.comments;
    }
    return result;
  }

  function schedule() {
    clearTimeout(timer);
    const sec = Math.max(15, Number(settings.get('imap.intervalSec')) || 60);
    timer = setTimeout(async () => { await pollOnce().catch(() => {}); schedule(); }, sec * 1000);
    timer.unref?.();
  }

  return { pollOnce, start: schedule, stop: () => clearTimeout(timer), status: () => ({ ...status }) };
}

/** Verbindungstest für die Einstellungsseite. */
export async function testImap(cfg) {
  const client = new ImapFlow(imapOptions(cfg));
  client.on('error', () => {});
  try {
    await client.connect();
    const list = await client.list();
    const status = await client.status(cfg.folder || 'INBOX', { messages: true, unseen: true });
    await client.logout();
    return { ok: true, folders: list.map((f) => f.path), messages: status.messages, unseen: status.unseen };
  } catch (e) {
    try { client.close(); } catch { /* egal */ }
    return { ok: false, error: e.responseText || e.message };
  }
}
