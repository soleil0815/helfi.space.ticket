// Fetch the mailbox (IMAP): new emails become tickets, replies become comments.
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import { log } from '../lib/log.js';
import { roleFromGroups } from '../users.js';
import { ticketKeyFromSubject, cleanSubject, stripQuotedReply, isAutomated, isEmail, deliveryReport } from './parse.js';
import { parseRules, matchRule } from './rules.js';
import { sanitizeMailHtml, resolveCids } from './html.js';

export const MAX_NEW_TICKETS_PER_HOUR = 20;
// Reasons for skipped mails (for the log)
const SKIP_REASONS = {
  automated: 'automatically generated (Auto-Submitted/Precedence/noreply) – for such senders create a rule "create ticket, never reply"',
  own: 'own address of Helfi.Space',
  rule: 'sender rule "ignore"',
  inactive: 'account disabled',
  rate: `more than ${MAX_NEW_TICKETS_PER_HOUR} new tickets per hour from this sender`,
  receipt: 'read receipt',
  'no-sender': 'no valid sender',
};
export const MAX_ATTACHMENTS = 30;
const MAX_BODY = 100000; // as in tickets.js (description/comment)
export const MAX_CC_PARTICIPANTS = 10; // at most this many recipients (To/CC) per mail become participants
const MAX_MESSAGE_BYTES = 80 * 1024 * 1024; // do not load larger mails (memory)
export const MIN_KEEP_DAYS = 7; // retention: smaller values (except 0) count as 7
export const MAX_PURGE_PER_RUN = 500;
const PURGE_EVERY_MS = 24 * 3600 * 1000;
const AD_MISS_TTL_MS = 3600 * 1000; // do not look up unknown addresses in AD again for one hour
const AD_ERROR_TTL_MS = 5 * 60 * 1000; // after an AD error pause 5 minutes for this address
const AD_CACHE_MAX = 5000;

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

export function createMailProcessor({ db, settings, tickets, users, adLookup = null, suppressions = null }) {
  const adMisses = new Map(); // address → time until which it is not looked up again
  const seen = db.prepare('SELECT ticket_id FROM mail_messages WHERE message_id=?');
  // Matching via references ONLY by our own outgoing Message-IDs (random, not guessable).
  // Incoming Message-IDs are known to every recipient of the original mail (e.g. in CC).
  const seenOut = db.prepare("SELECT ticket_id, agent_only FROM mail_messages WHERE message_id=? AND direction='out'");
  const remember = db.prepare("INSERT OR IGNORE INTO mail_messages(message_id,ticket_id,direction) VALUES(?,?,'in')");

  /** Find the ticket for a reply: via our Message-ID (not guessable) or [KEY-123] in the subject. */
  function findTicket(parsed) {
    const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references])]
      .filter(Boolean).map((r) => String(r).replace(/[<>]/g, '').trim());
    for (const r of refs) {
      const row = seenOut.get(r);
      // agent_only: mail went only to an agent (assignment, SLA warning, approval) – see smtp.js send()
      if (row?.ticket_id) return { id: row.ticket_id, via: 'reference', agentMail: row.agent_only === 1 };
    }
    const k = ticketKeyFromSubject(parsed.subject);
    if (k) {
      const row = db.prepare('SELECT t.id FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.key=? AND t.number=?').get(k.projectKey, k.number);
      if (row) return { id: row.id, via: 'subject' };
    }
    return null;
  }

  /** May this sender write to the ticket via the subject number? (reporter, assignee, previous participants) */
  function isParticipant(ticketId, sender, fromAddr) {
    // Deliberately NO special rights for agents: sender addresses can be forged
    const t = db.prepare('SELECT reporter_id, reporter_email FROM tickets WHERE id=?').get(ticketId);
    if (!t) return false;
    if (t.reporter_id === sender.id || String(t.reporter_email || '').toLowerCase() === fromAddr) return true;
    if (tickets.isParticipant(ticketId, sender.id)) return true;
    return !!db.prepare('SELECT 1 FROM comments WHERE ticket_id=? AND (author_id=? OR lower(author_email)=?) LIMIT 1').get(ticketId, sender.id, fromAddr);
  }

  /**
   * Look up an unknown sender in AD and create them as an AD user (as on first sign-in).
   * Returns the account or null (then the sender becomes an email contact as before).
   * Never grants agent rights for the mail itself: process() always treats mails as reports.
   */
  async function lookupSender(parsed, now = Date.now()) {
    const from = parsed.from?.value?.[0];
    const addr = String(from?.address || '').toLowerCase();
    if (!isEmail(addr) || isAutomated(parsed.headers, addr) || deliveryReport(parsed, parsed.raw)) return null;
    if (matchRule(parseRules(settings.get('imap.senderRules')), addr)?.action === 'ignore') return null;
    return lookupAddress(addr, now);
  }

  /** Look up the recipients (To/CC) of a mail in AD so they become participants as AD users. */
  async function lookupParticipants(parsed, now = Date.now()) {
    const found = new Map();
    if (!settings.get('imap.ccParticipants') || isAutomated(parsed.headers, String(parsed.from?.value?.[0]?.address || '').toLowerCase())) return found;
    for (const addr of recipientAddresses(parsed)) {
      const u = await lookupAddress(addr, now);
      if (u) found.set(addr, u);
    }
    return found;
  }

  function ownAddresses() {
    return [settings.get('smtp.from'), settings.get('imap.user')].filter(Boolean).map((x) => x.toLowerCase());
  }

  /** To and CC addresses excluding own addresses, sender and agents, at most MAX_CC_PARTICIPANTS. */
  function recipientAddresses(parsed) {
    const own = ownAddresses();
    // Agents do not count towards the limit (they never become participants anyway)
    const isAgent = (a) => { const u = users.byEmail(a); return !!u && (u.role === 'agent' || u.role === 'admin'); };
    const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
    const list = [];
    for (const field of [parsed.to, parsed.cc]) {
      for (const group of Array.isArray(field) ? field : [field]) {
        for (const v of group?.value || []) {
          const a = String(v.address || '').toLowerCase();
          if (list.length < MAX_CC_PARTICIPANTS && isEmail(a) && a !== from && !own.includes(a) && !list.some((x) => x.address === a) && !isAgent(a)) list.push({ address: a, name: v.name || '' });
        }
      }
    }
    return list.map((x) => x.address);
  }

  function recipientNames(parsed) {
    const names = new Map();
    for (const field of [parsed.to, parsed.cc]) {
      for (const group of Array.isArray(field) ? field : [field]) {
        for (const v of group?.value || []) if (v.address) names.set(String(v.address).toLowerCase(), v.name || '');
      }
    }
    return names;
  }

  async function lookupAddress(addr, now) {
    if (!adLookup || !settings.get('imap.adLookup') || !settings.get('ldap.enabled')) return null;
    const ldapCfg = settings.group('ldap');
    if (!ldapCfg.bindDn) return null;
    if (ownAddresses().includes(addr)) return null;
    const existing = users.byEmail(addr);
    if (existing && existing.source !== 'email') return null; // already a real account
    if ((adMisses.get(addr) || 0) > now) return null;

    const miss = (ttl) => {
      if (adMisses.size >= AD_CACHE_MAX) adMisses.delete(adMisses.keys().next().value);
      adMisses.set(addr, now + ttl);
      return null;
    };
    let info;
    try {
      info = await adLookup(ldapCfg, addr);
    } catch (e) {
      log.warn('Sender lookup in AD failed – becomes email contact', { error: e.message });
      return miss(AD_ERROR_TTL_MS);
    }
    if (!info) return miss(AD_MISS_TTL_MS);
    if (info.ambiguous) { log.warn('Sender address is used more than once in AD – becomes email contact'); return miss(AD_MISS_TTL_MS); }
    const role = roleFromGroups(info.groups, ldapCfg);
    if (!info.groups.user && role !== 'admin' && role !== 'agent') return miss(AD_MISS_TTL_MS); // not permitted
    const u = users.upsertExternal({
      source: 'ldap', username: info.username, displayName: info.displayName,
      email: info.email || addr, externalId: info.externalId, sid: info.sid, role,
    });
    log.info(`Email sender found in AD: ${u.username}`);
    return u;
  }

  /** Processes a parsed email. Returns a short description of what happened.
   *  opts.sender: account from lookupSender() (e.g. for a secondary address from proxyAddresses).
   *  opts.participants: map address → account from lookupParticipants(). */
  function process(parsed, opts = {}) {
    const cfg = settings.group('imap');
    const from = parsed.from?.value?.[0];
    const fromAddr = String(from?.address || '').toLowerCase();
    const messageId = String(parsed.messageId || '').replace(/[<>]/g, '').trim()
      || 'nomsgid-' + crypto.createHash('sha256').update(`${fromAddr}|${parsed.subject}|${parsed.date}|${parsed.text?.slice(0, 500)}`).digest('hex');

    const prev = seen.get(messageId);
    if (prev) return { action: 'duplicate', ticketId: prev.ticket_id || null, messageId };

    // Non-delivery reports and read receipts: never a ticket/comment, never a reply (no ping-pong)
    const report = deliveryReport(parsed, parsed.raw);
    if (report?.kind === 'receipt') { remember.run(messageId, null); return { action: 'skipped', reason: 'receipt', messageId }; }
    if (report?.kind === 'bounce') {
      // Only reports about our own mails (unguessable Message-ID) end up as a note in the ticket
      const ticketId = report.refs.map((r) => seenOut.get(r)?.ticket_id).find(Boolean) || null;
      return db.transaction(() => {
        for (const a of report.failed) suppressions?.add(a, cleanSubject(parsed.subject) || 'Unzustellbar');
        if (ticketId && report.failed.length) {
          tickets.addComment(null, ticketId, {
            body: `Zustellung fehlgeschlagen / delivery failed: ${report.failed.join(', ')}

`
              + 'Helfi.Space schickt diesen Adressen 7 Tage lang keine Mails (Administration → E-Mail → Gesperrte Empfänger). / '
              + 'Helfi.Space will not send mail to these addresses for 7 days.',
          }, { source: 'system', authorName: 'Helfi.Space', skipPermission: true, system: true });
        }
        remember.run(messageId, ticketId);
        return { action: 'bounce', ticketId, failed: report.failed, messageId };
      })();
    }

    if (!isEmail(fromAddr)) { remember.run(messageId, null); return { action: 'skipped', reason: 'no-sender', messageId }; }
    const rule = matchRule(parseRules(cfg.senderRules), fromAddr);
    if (rule?.action === 'ignore') { remember.run(messageId, null); return { action: 'skipped', reason: 'rule', from: fromAddr, messageId }; }

    const own = [settings.get('smtp.from'), cfg.user].filter(Boolean).map((x) => x.toLowerCase());
    // Own address: always discard (otherwise a loop with itself)
    if (own.includes(fromAddr)) { remember.run(messageId, null); return { action: 'skipped', reason: 'own', from: fromAddr, messageId }; }
    // Automatically generated mails (monitoring, NAS, hypervisor …) only with an explicit rule
    // "create ticket, never reply" – then no mails go back to this address anyway
    if (isAutomated(parsed.headers, fromAddr) && rule?.action !== 'noreply') {
      remember.run(messageId, null);
      return { action: 'skipped', reason: 'automated', from: fromAddr, messageId };
    }

    const sender = opts.sender || users.byEmail(fromAddr) || users.contactForEmail(fromAddr, from?.name || '');
    if (!sender.active) { remember.run(messageId, null); return { action: 'skipped', reason: 'inactive', from: fromAddr, messageId }; }

    // Convert HTML-only mails (e.g. from Outlook) into readable text
    const text = String(parsed.text || '').trim()
      || (parsed.html ? htmlToText(parsed.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] }).trim() : '');
    const maxBytes = (cfg.maxAttachmentMb || 20) * 1024 * 1024;
    // Small embedded images (logos, signatures) not as attachments – only for the formatted view (below)
    const smallInline = (a) => a.related && a.size < 30 * 1024;
    const all = (parsed.attachments || []).filter((a) => a.content && !smallInline(a));
    const files = all.filter((a) => a.size <= maxBytes).slice(0, MAX_ATTACHMENTS);
    const dropped = all.filter((a) => !files.includes(a));
    // Note dropped attachments in the text so nobody misses anything
    let droppedNote = dropped.length
      ? `\n\n[${dropped.map((a) => `Anhang nicht übernommen / attachment not imported: ${a.filename || 'ohne Namen'} (${Math.round(a.size / 1048576)} MB)`).join(']\n[')}]`
      : '';
    // Truncate the text first, then append the note – otherwise the length limit cuts it off for long mails
    droppedNote = droppedNote.slice(0, 20000);
    const withNote = (body) => body.slice(0, MAX_BODY - droppedNote.length) + droppedNote;
    if (dropped.length) log.warn(`Email ${messageId}: ${dropped.length} attachment(s) not imported (too large or too many)`);

    // Agent accounts are not treated as agents via email (sender can be forged):
    // comments appear with the sender address, not under the account
    const privileged = sender.role === 'agent' || sender.role === 'admin';

    const found = findTicket(parsed);
    // Anyone who only knows the (sequential) ticket number but is not involved gets a new ticket
    const existingId = found && (found.via === 'reference' || isParticipant(found.id, sender, fromAddr)) ? found.id : null;
    // Reply to an agent-only mail: only as an internal note (invisible to users), reopens nothing.
    // Grants no rights: the author stays the sender address, only the agent knows the Message-ID.
    const agentReply = !!existingId && !!found.agentMail;

    // Protection against mail loops with unmarked auto-responders
    if (!existingId) {
      const recent = db.prepare("SELECT COUNT(*) n FROM tickets WHERE lower(reporter_email)=? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(fromAddr).n;
      if (recent >= MAX_NEW_TICKETS_PER_HOUR) { remember.run(messageId, null); return { action: 'skipped', reason: 'rate', from: fromAddr, messageId }; }
    }

    // To/CC recipients become request participants.
    // Not agents – they see the ticket anyway. No notification: they already have the mail.
    const addCcParticipants = (ticketId) => {
      if (!settings.get('imap.ccParticipants')) return;
      const names = recipientNames(parsed);
      for (const addr of recipientAddresses(parsed)) {
        const u = opts.participants?.get(addr) || users.byEmail(addr) || users.contactForEmail(addr, names.get(addr) || '');
        if (!u.active || u.role === 'agent' || u.role === 'admin') continue;
        try { tickets.addParticipant(sender, ticketId, { userId: u.id }, { system: true, notify: false }); }
        catch (e) { log.warn(`Participant ${addr} not added`, { error: e.message }); break; }
      }
    };

    // Formatted version (HTML) – sanitized; collapse the quoted history for replies
    const mailHtml = parsed.html ? sanitizeMailHtml(parsed.html, { collapseQuote: !!existingId }) : null;
    const cidOf = (a) => String(a.cid || a.contentId || '').replace(/^<|>$/g, '').toLowerCase();
    const usedCids = new Set(mailHtml?.cids || []);
    const inlineOnly = mailHtml ? (parsed.attachments || []).filter((a) => a.content && smallInline(a) && usedCids.has(cidOf(a))).slice(0, 30) : [];
    const storeFiles = (ticketId, userId, commentId) => {
      const cidMap = new Map();
      for (const a of files) {
        const id = tickets.addAttachment(ticketId, { filename: a.filename, mime: a.contentType, buffer: a.content }, userId, commentId);
        if (usedCids.has(cidOf(a))) cidMap.set(cidOf(a), id);
      }
      for (const a of inlineOnly) {
        if (!/^image\//i.test(a.contentType || '')) continue;
        cidMap.set(cidOf(a), tickets.addAttachment(ticketId, { filename: a.filename || 'bild', mime: a.contentType, buffer: a.content }, userId, commentId, { inline: true }));
      }
      if (mailHtml) tickets.saveMailHtml(ticketId, commentId, resolveCids(mailHtml.html, cidMap), mailHtml.blocked);
    };

    return db.transaction(() => {
      if (existingId) {
        const asUser = privileged || agentReply ? null : sender;
        const comment = tickets.addComment(asUser, existingId, { body: withNote(stripQuotedReply(text) || '(leer)') }, {
          source: 'email', authorEmail: fromAddr, authorName: from?.name || fromAddr, skipPermission: true,
          // system: always internal, does not reopen, no account rights
          ...(agentReply ? { system: true } : {}),
        });
        storeFiles(existingId, asUser ? asUser.id : null, comment.id);
        // Add CC recipients only when matched via our (unguessable) Message-ID –
        // never when matched only via the number in the subject (sender can be forged)
        if (!privileged && !agentReply && found.via === 'reference') addCcParticipants(existingId);
        remember.run(messageId, existingId);
        return { action: 'comment', ticketId: existingId, messageId };
      }
      const projectKey = (rule?.project && tickets.projects.get(rule.project) ? rule.project : '') || cfg.project || settings.get('general.defaultProject');
      const project = projectKey ? tickets.projects.get(projectKey) : null;
      const ticket = tickets.create(sender, {
        title: cleanSubject(parsed.subject) || '(ohne Betreff / no subject)',
        description: withNote(text),
        projectId: project?.id,
        type: 'request',
      }, { source: 'email', reporterEmail: fromAddr, reporterName: from?.name || null, reporterId: sender.id, messageId });
      storeFiles(ticket.id, sender.id, null);
      addCcParticipants(ticket.id);
      remember.run(messageId, ticket.id);
      return { action: 'ticket', ticketId: ticket.id, key: ticket.key, messageId };
    })();
  }

  /** Parse a mail; keep the start of the raw mail (headers/delivery report that mailparser drops). */
  async function parse(source) {
    // keep cid: references (otherwise mailparser embeds every image as a data: URL in the HTML)
    const p = await simpleParser(source, { keepCidLinks: true });
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source));
    Object.defineProperty(p, 'raw', { value: buf.subarray(0, 256 * 1024).toString('latin1'), enumerable: false });
    return p;
  }

  return { process, lookupSender, lookupParticipants, parse };
}

/** Into the folder for processed mails: only what produced a ticket/comment (also as duplicate) and read receipts. */
export function movesToProcessed(r) {
  if (r?.action === 'ticket' || r?.action === 'comment') return true;
  if (r?.action === 'duplicate') return !!r.ticketId;
  return r?.action === 'skipped' && r.reason === 'receipt';
}

// Own keyword for processed mails: independent of whether someone reads the mail in the mailbox
export const DONE_KEYWORD = '$HelfiDone';

/** Can the server store custom keywords permanently? (PERMANENTFLAGS contains \\*) */
export function supportsKeywords(mailbox) {
  const pf = mailbox?.permanentFlags;
  return !!pf && (typeof pf.has === 'function' ? pf.has('\\*') : Array.from(pf).includes('\\*'));
}

/**
 * Search for mails not yet processed.
 * With keyword: everything without $HelfiDone that is unread OR arrived since the keyword was introduced
 * (older, already read mails date from before and were processed back then).
 * Without keyword (server does not support it): all unread ones, as before.
 */
export function pendingQuery(keywords, since) {
  if (!keywords) return { seen: false };
  return { unKeyword: DONE_KEYWORD, or: [{ seen: false }, { since }] };
}

export function createImapPoller({ settings, processor, ImapClient = ImapFlow }) {
  // recentSkipped: the most recent skipped mails (in memory only) so admins can see the reason
  const status = { running: false, lastRun: null, lastError: null, lastResult: null, processedTotal: 0, lastPurge: null, recentSkipped: [] };
  const failures = new Map();
  let timer = null;
  let lastPurge = 0;

  async function pollOnce() {
    const cfg = settings.group('imap');
    if (!cfg.enabled || !cfg.host || !cfg.user) return { skipped: true };
    if (status.running) return { busy: true };
    status.running = true;
    const result = { tickets: 0, comments: 0, skipped: 0, errors: 0, skippedReasons: {} };
    const client = new ImapClient(imapOptions(cfg));
    client.on('error', (e) => log.warn('IMAP error', { error: e.message }));
    try {
      await client.connect();
      if (cfg.processedFolder) {
        try { await client.mailboxCreate(cfg.processedFolder); } catch { /* already exists */ }
      }
      const lock = await client.getMailboxLock(cfg.folder || 'INBOX');
      try {
        const keywords = supportsKeywords(client.mailbox);
        let since = null;
        if (keywords) {
          // On first run record from when the keyword is set
          let k = settings.get('imap.keywordSince');
          if (!k || Number.isNaN(Date.parse(k))) { k = new Date().toISOString(); settings.set('imap.keywordSince', k); }
          since = new Date(k);
        }
        const done = keywords ? ['\\Seen', DONE_KEYWORD] : ['\\Seen'];
        const uids = (await client.search(pendingQuery(keywords, since), { uid: true })) || [];
        for (const uid of uids.slice(0, 200)) {
          try {
            // Check the size first – do not load huge mails into memory
            const meta = await client.fetchOne(String(uid), { size: true }, { uid: true });
            if (meta?.size > MAX_MESSAGE_BYTES) {
              log.warn(`Email UID ${uid} is too large (${Math.round(meta.size / 1048576)} MB) – skipped and flagged`);
              await client.messageFlagsAdd(String(uid), [...done, '\\Flagged'], { uid: true });
              result.skipped++;
              continue;
            }
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg?.source) continue;
            const parsed = await processor.parse(msg.source);
            const sender = processor.lookupSender ? await processor.lookupSender(parsed) : null;
            const participants = processor.lookupParticipants ? await processor.lookupParticipants(parsed) : null;
            const r = processor.process(parsed, { ...(sender ? { sender } : {}), ...(participants ? { participants } : {}) });
            if (r.action === 'ticket') { result.tickets++; log.info(`Email → new ticket ${r.key}`); }
            else if (r.action === 'bounce') { result.skipped++; log.info(`Non-delivery report for ${r.failed.join(', ') || '?'}${r.ticketId ? ` (ticket #${r.ticketId})` : ''} – not answered`); }
            else if (r.action === 'comment') { result.comments++; log.info(`Email → comment on ticket #${r.ticketId}`); }
            else if (r.action === 'skipped') {
              result.skipped++;
              result.skippedReasons[r.reason] = (result.skippedReasons[r.reason] || 0) + 1;
              log.info(`Email${r.from ? ` from ${r.from}` : ''} skipped: ${SKIP_REASONS[r.reason] || r.reason}`);
              status.recentSkipped = [{ at: new Date().toISOString(), from: r.from || '', subject: String(parsed.subject || '').slice(0, 120), reason: r.reason },
                ...status.recentSkipped].slice(0, 20);
            } else result.skipped++;
            await client.messageFlagsAdd(String(uid), done, { uid: true });
            // Skipped mails and non-delivery reports stay (read) in the inbox – in the folder for
            // processed mails they would be deleted after the retention period without a ticket existing
            if (cfg.processedFolder && movesToProcessed(r)) await client.messageMove(String(uid), cfg.processedFolder, { uid: true });
            failures.delete(uid);
          } catch (e) {
            result.errors++;
            const n = (failures.get(uid) || 0) + 1;
            failures.set(uid, n);
            log.error(`Email UID ${uid} could not be processed (attempt ${n})`, { error: e.message });
            if (n >= 3) {
              // After 3 failed attempts mark as read and flag it so it does not block forever
              await client.messageFlagsAdd(String(uid), [...done, '\\Flagged'], { uid: true }).catch(() => {});
              failures.delete(uid);
            }
          }
        }
      } finally {
        lock.release();
      }
      if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
        lastPurge = Date.now();
        const p = await purgeProcessed(client, cfg);
        if (!p.skipped) {
          status.lastPurge = { at: new Date().toISOString(), deleted: p.deleted };
          if (p.deleted) log.info(`Mailbox: ${p.deleted} processed mail(s) older than ${p.days} days deleted (${cfg.processedFolder})`);
        }
      }
      await client.logout();
      status.lastError = null;
    } catch (e) {
      status.lastError = e.message;
      log.warn('Mailbox fetch failed', { error: e.message });
      try { client.close(); } catch { /* ignore */ }
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

/** Effective retention in days: 0 = never delete, otherwise at least MIN_KEEP_DAYS. */
export function effectiveKeepDays(value) {
  const n = Math.floor(Number(value) || 0);
  if (n <= 0) return 0;
  return Math.max(MIN_KEEP_DAYS, n);
}

/** Deleting is only allowed if a separate folder for processed mails is configured –
 *  never in the inbox or the fetched folder. */
export function purgeFolder(cfg) {
  const folder = String(cfg.processedFolder || '').trim();
  if (!folder) return null;
  const source = String(cfg.folder || 'INBOX').trim();
  if (folder.toLowerCase() === source.toLowerCase() || folder.toLowerCase() === 'inbox') return null;
  return folder;
}

/**
 * Delete processed mails in the folder that are older than the configured number of days
 * (arrival date on the server, IMAP SEARCH BEFORE). At most MAX_PURGE_PER_RUN per run.
 */
export async function purgeProcessed(client, cfg, now = new Date()) {
  const days = effectiveKeepDays(cfg.processedKeepDays);
  const folder = purgeFolder(cfg);
  if (!days || !folder) return { skipped: true, deleted: 0 };
  const before = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = ((await client.search({ before }, { uid: true })) || []).slice(0, MAX_PURGE_PER_RUN);
    if (!uids.length) return { deleted: 0, days };
    await client.messageDelete(uids.join(','), { uid: true });
    return { deleted: uids.length, days };
  } finally {
    lock.release();
  }
}

/** Connection test for the settings page. */
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
    try { client.close(); } catch { /* ignore */ }
    return { ok: false, error: e.responseText || e.message };
  }
}
