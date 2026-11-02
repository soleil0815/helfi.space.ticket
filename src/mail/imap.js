// Postfach abrufen (IMAP): neue E-Mails werden zu Tickets, Antworten zu Kommentaren.
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
// Gründe für übersprungene Mails (für das Protokoll)
const SKIP_REASONS = {
  automated: 'automatisch erzeugt (Auto-Submitted/Precedence/noreply) – für solche Absender eine Regel „Ticket anlegen, nie antworten“ anlegen',
  own: 'eigene Adresse von Helfi.Space',
  rule: 'Absender-Regel „ignorieren“',
  inactive: 'Konto deaktiviert',
  rate: `mehr als ${MAX_NEW_TICKETS_PER_HOUR} neue Tickets pro Stunde von diesem Absender`,
  receipt: 'Lesebestätigung',
  'no-sender': 'kein gültiger Absender',
};
export const MAX_ATTACHMENTS = 30;
export const MAX_CC_PARTICIPANTS = 10; // so viele Empfänger (An/CC) je Mail werden höchstens Teilnehmer
const MAX_MESSAGE_BYTES = 80 * 1024 * 1024; // größere Mails nicht laden (Speicher)
export const MIN_KEEP_DAYS = 7; // Aufbewahrung: kleinere Werte (außer 0) gelten als 7
export const MAX_PURGE_PER_RUN = 500;
const PURGE_EVERY_MS = 24 * 3600 * 1000;
const AD_MISS_TTL_MS = 3600 * 1000; // unbekannte Adressen eine Stunde lang nicht erneut im AD suchen
const AD_ERROR_TTL_MS = 5 * 60 * 1000; // nach einem AD-Fehler 5 Minuten Pause für diese Adresse
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
  const adMisses = new Map(); // Adresse → Zeitpunkt, bis zu dem nicht erneut gesucht wird
  const seen = db.prepare('SELECT ticket_id FROM mail_messages WHERE message_id=?');
  // Zuordnung über Referenzen NUR über eigene, ausgehende Message-IDs (zufällig, nicht erratbar).
  // Eingehende Message-IDs kennt jeder Empfänger der Ursprungsmail (z. B. in CC).
  const seenOut = db.prepare("SELECT ticket_id FROM mail_messages WHERE message_id=? AND direction='out'");
  const remember = db.prepare("INSERT OR IGNORE INTO mail_messages(message_id,ticket_id,direction) VALUES(?,?,'in')");

  /** Ticket zu einer Antwort finden: über unsere Message-ID (nicht erratbar) oder [KEY-123] im Betreff. */
  function findTicket(parsed) {
    const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references])]
      .filter(Boolean).map((r) => String(r).replace(/[<>]/g, '').trim());
    for (const r of refs) {
      const row = seenOut.get(r);
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
    // Bewusst KEINE Sonderrechte für Bearbeiter: Absenderadressen lassen sich fälschen
    const t = db.prepare('SELECT reporter_id, reporter_email FROM tickets WHERE id=?').get(ticketId);
    if (!t) return false;
    if (t.reporter_id === sender.id || String(t.reporter_email || '').toLowerCase() === fromAddr) return true;
    if (tickets.isParticipant(ticketId, sender.id)) return true;
    return !!db.prepare('SELECT 1 FROM comments WHERE ticket_id=? AND (author_id=? OR lower(author_email)=?) LIMIT 1').get(ticketId, sender.id, fromAddr);
  }

  /**
   * Unbekannten Absender im AD suchen und als AD-Benutzer anlegen (wie bei der ersten Anmeldung).
   * Liefert das Konto oder null (dann wird der Absender wie bisher zum E-Mail-Kontakt).
   * Gibt nie Bearbeiter-Rechte für die Mail selbst: process() behandelt Mails immer als Meldung.
   */
  async function lookupSender(parsed, now = Date.now()) {
    const from = parsed.from?.value?.[0];
    const addr = String(from?.address || '').toLowerCase();
    if (!isEmail(addr) || isAutomated(parsed.headers, addr) || deliveryReport(parsed, parsed.raw)) return null;
    if (matchRule(parseRules(settings.get('imap.senderRules')), addr)?.action === 'ignore') return null;
    return lookupAddress(addr, now);
  }

  /** Empfänger (An/CC) einer Mail im AD suchen, damit sie als AD-Benutzer Teilnehmer werden. */
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

  /** An- und CC-Adressen ohne eigene Adressen und Absender, höchstens MAX_CC_PARTICIPANTS. */
  function recipientAddresses(parsed) {
    const own = ownAddresses();
    const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
    const list = [];
    for (const field of [parsed.to, parsed.cc]) {
      for (const group of Array.isArray(field) ? field : [field]) {
        for (const v of group?.value || []) {
          const a = String(v.address || '').toLowerCase();
          if (isEmail(a) && a !== from && !own.includes(a) && !list.some((x) => x.address === a)) list.push({ address: a, name: v.name || '' });
        }
      }
    }
    return list.slice(0, MAX_CC_PARTICIPANTS).map((x) => x.address);
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
    if (existing && existing.source !== 'email') return null; // schon ein richtiges Konto
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
      log.warn('Absender im AD suchen fehlgeschlagen – wird E-Mail-Kontakt', { error: e.message });
      return miss(AD_ERROR_TTL_MS);
    }
    if (!info) return miss(AD_MISS_TTL_MS);
    if (info.ambiguous) { log.warn('Absender-Adresse ist im AD mehrfach vergeben – wird E-Mail-Kontakt'); return miss(AD_MISS_TTL_MS); }
    const role = roleFromGroups(info.groups, ldapCfg);
    if (!info.groups.user && role !== 'admin' && role !== 'agent') return miss(AD_MISS_TTL_MS); // nicht zugelassen
    const u = users.upsertExternal({
      source: 'ldap', username: info.username, displayName: info.displayName,
      email: info.email || addr, externalId: info.externalId, role,
    });
    log.info(`E-Mail-Absender im AD gefunden: ${u.username}`);
    return u;
  }

  /** Verarbeitet eine geparste E-Mail. Liefert eine kurze Beschreibung, was passiert ist.
   *  opts.sender: Konto aus lookupSender() (z. B. bei Zweitadresse aus proxyAddresses).
   *  opts.participants: Map Adresse → Konto aus lookupParticipants(). */
  function process(parsed, opts = {}) {
    const cfg = settings.group('imap');
    const from = parsed.from?.value?.[0];
    const fromAddr = String(from?.address || '').toLowerCase();
    const messageId = String(parsed.messageId || '').replace(/[<>]/g, '').trim()
      || 'nomsgid-' + crypto.createHash('sha256').update(`${fromAddr}|${parsed.subject}|${parsed.date}|${parsed.text?.slice(0, 500)}`).digest('hex');

    if (seen.get(messageId)) return { action: 'duplicate', messageId };

    // Unzustellbarkeitsberichte und Lesebestätigungen: nie Ticket/Kommentar, nie eine Antwort (kein Ping-Pong)
    const report = deliveryReport(parsed, parsed.raw);
    if (report?.kind === 'receipt') { remember.run(messageId, null); return { action: 'skipped', reason: 'receipt', messageId }; }
    if (report?.kind === 'bounce') {
      // Nur Berichte zu eigenen Mails (nicht erratbare Message-ID) landen als Notiz im Ticket
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
    // Eigene Adresse: immer verwerfen (sonst Schleife mit sich selbst)
    if (own.includes(fromAddr)) { remember.run(messageId, null); return { action: 'skipped', reason: 'own', from: fromAddr, messageId }; }
    // Automatisch erzeugte Mails (Monitoring, NAS, Hypervisor …) nur mit ausdrücklicher Regel
    // „Ticket anlegen, nie antworten“ – dann gehen ohnehin keine Mails an diese Adresse zurück
    if (isAutomated(parsed.headers, fromAddr) && rule?.action !== 'noreply') {
      remember.run(messageId, null);
      return { action: 'skipped', reason: 'automated', from: fromAddr, messageId };
    }

    const sender = opts.sender || users.byEmail(fromAddr) || users.contactForEmail(fromAddr, from?.name || '');
    if (!sender.active) { remember.run(messageId, null); return { action: 'skipped', reason: 'inactive', from: fromAddr, messageId }; }

    // Reine HTML-Mails (z. B. aus Outlook) in lesbaren Text umwandeln
    const text = String(parsed.text || '').trim()
      || (parsed.html ? htmlToText(parsed.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] }).trim() : '');
    const maxBytes = (cfg.maxAttachmentMb || 20) * 1024 * 1024;
    // Kleine eingebettete Bilder (Logos, Signaturen) nicht als Anhang – nur für die formatierte Ansicht (unten)
    const smallInline = (a) => a.related && a.size < 30 * 1024;
    const all = (parsed.attachments || []).filter((a) => a.content && !smallInline(a));
    const files = all.filter((a) => a.size <= maxBytes).slice(0, MAX_ATTACHMENTS);
    const dropped = all.filter((a) => !files.includes(a));
    // Nicht übernommene Anhänge im Text vermerken, damit niemand etwas übersieht
    const droppedNote = dropped.length
      ? `\n\n[${dropped.map((a) => `Anhang nicht übernommen / attachment not imported: ${a.filename || 'ohne Namen'} (${Math.round(a.size / 1048576)} MB)`).join(']\n[')}]`
      : '';
    if (dropped.length) log.warn(`E-Mail ${messageId}: ${dropped.length} Anhang/Anhänge nicht übernommen (zu groß oder zu viele)`);

    // Bearbeiter-Konten werden per E-Mail nicht als Bearbeiter behandelt (Absender fälschbar):
    // Kommentare erscheinen mit der Absenderadresse, nicht unter dem Konto
    const privileged = sender.role === 'agent' || sender.role === 'admin';

    const found = findTicket(parsed);
    // Wer nur die (fortlaufende) Ticketnummer kennt, aber nicht beteiligt ist, bekommt ein neues Ticket
    const existingId = found && (found.via === 'reference' || isParticipant(found.id, sender, fromAddr)) ? found.id : null;

    // Schutz vor Mail-Schleifen mit Autorespondern ohne Kennzeichnung
    if (!existingId) {
      const recent = db.prepare("SELECT COUNT(*) n FROM tickets WHERE lower(reporter_email)=? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(fromAddr).n;
      if (recent >= MAX_NEW_TICKETS_PER_HOUR) { remember.run(messageId, null); return { action: 'skipped', reason: 'rate', from: fromAddr, messageId }; }
    }

    // An/CC-Empfänger werden Anfrage-Teilnehmer.
    // Bearbeiter nicht – sie sehen das Ticket ohnehin. Keine Benachrichtigung: sie haben die Mail schon.
    const addCcParticipants = (ticketId) => {
      if (!settings.get('imap.ccParticipants')) return;
      const names = recipientNames(parsed);
      for (const addr of recipientAddresses(parsed)) {
        const u = opts.participants?.get(addr) || users.byEmail(addr) || users.contactForEmail(addr, names.get(addr) || '');
        if (!u.active || u.role === 'agent' || u.role === 'admin') continue;
        try { tickets.addParticipant(sender, ticketId, { userId: u.id }, { system: true, notify: false }); }
        catch (e) { log.warn(`Teilnehmer ${addr} nicht hinzugefügt`, { error: e.message }); break; }
      }
    };

    // Formatierte Fassung (HTML) – bereinigt; bei Antworten den zitierten Verlauf einklappen
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
        const comment = tickets.addComment(privileged ? null : sender, existingId, { body: (stripQuotedReply(text) || '(leer)') + droppedNote }, {
          source: 'email', authorEmail: fromAddr, authorName: from?.name || fromAddr, skipPermission: true,
        });
        storeFiles(existingId, privileged ? null : sender.id, comment.id);
        if (!privileged) addCcParticipants(existingId);
        remember.run(messageId, existingId);
        return { action: 'comment', ticketId: existingId, messageId };
      }
      const projectKey = (rule?.project && tickets.projects.get(rule.project) ? rule.project : '') || cfg.project || settings.get('general.defaultProject');
      const project = projectKey ? tickets.projects.get(projectKey) : null;
      const ticket = tickets.create(sender, {
        title: cleanSubject(parsed.subject) || '(ohne Betreff / no subject)',
        description: text + droppedNote,
        projectId: project?.id,
        type: 'request',
      }, { source: 'email', reporterEmail: fromAddr, reporterName: from?.name || null, reporterId: sender.id, messageId });
      storeFiles(ticket.id, sender.id, null);
      addCcParticipants(ticket.id);
      remember.run(messageId, ticket.id);
      return { action: 'ticket', ticketId: ticket.id, key: ticket.key, messageId };
    })();
  }

  /** Mail zerlegen; den Anfang der Rohmail behalten (Kopfzeilen/Zustellbericht, die mailparser verwirft). */
  async function parse(source) {
    // cid:-Verweise behalten (sonst bettet mailparser jedes Bild als data:-URL ins HTML ein)
    const p = await simpleParser(source, { keepCidLinks: true });
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source));
    Object.defineProperty(p, 'raw', { value: buf.subarray(0, 256 * 1024).toString('latin1'), enumerable: false });
    return p;
  }

  return { process, lookupSender, lookupParticipants, parse };
}

export function createImapPoller({ settings, processor }) {
  // recentSkipped: die letzten übersprungenen Mails (nur im Speicher), damit Admins den Grund sehen
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
            // Erst die Größe prüfen – riesige Mails nicht in den Speicher laden
            const meta = await client.fetchOne(String(uid), { size: true }, { uid: true });
            if (meta?.size > MAX_MESSAGE_BYTES) {
              log.warn(`E-Mail UID ${uid} ist zu groß (${Math.round(meta.size / 1048576)} MB) – übersprungen und markiert`);
              await client.messageFlagsAdd(String(uid), ['\\Seen', '\\Flagged'], { uid: true });
              result.skipped++;
              continue;
            }
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg?.source) continue;
            const parsed = await processor.parse(msg.source);
            const sender = processor.lookupSender ? await processor.lookupSender(parsed) : null;
            const participants = processor.lookupParticipants ? await processor.lookupParticipants(parsed) : null;
            const r = processor.process(parsed, { ...(sender ? { sender } : {}), ...(participants ? { participants } : {}) });
            if (r.action === 'ticket') { result.tickets++; log.info(`E-Mail → neues Ticket ${r.key}`); }
            else if (r.action === 'bounce') { result.skipped++; log.info(`Unzustellbarkeitsbericht für ${r.failed.join(', ') || '?'}${r.ticketId ? ` (Ticket #${r.ticketId})` : ''} – nicht beantwortet`); }
            else if (r.action === 'comment') { result.comments++; log.info(`E-Mail → Kommentar zu Ticket #${r.ticketId}`); }
            else if (r.action === 'skipped') {
              result.skipped++;
              result.skippedReasons[r.reason] = (result.skippedReasons[r.reason] || 0) + 1;
              log.info(`E-Mail${r.from ? ` von ${r.from}` : ''} übersprungen: ${SKIP_REASONS[r.reason] || r.reason}`);
              status.recentSkipped = [{ at: new Date().toISOString(), from: r.from || '', subject: String(parsed.subject || '').slice(0, 120), reason: r.reason },
                ...status.recentSkipped].slice(0, 20);
            } else result.skipped++;
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
      if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
        lastPurge = Date.now();
        const p = await purgeProcessed(client, cfg);
        if (!p.skipped) {
          status.lastPurge = { at: new Date().toISOString(), deleted: p.deleted };
          if (p.deleted) log.info(`Postfach: ${p.deleted} verarbeitete Mail(s) älter als ${p.days} Tage gelöscht (${cfg.processedFolder})`);
        }
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

/** Wirksame Aufbewahrung in Tagen: 0 = nie löschen, sonst mindestens MIN_KEEP_DAYS. */
export function effectiveKeepDays(value) {
  const n = Math.floor(Number(value) || 0);
  if (n <= 0) return 0;
  return Math.max(MIN_KEEP_DAYS, n);
}

/** Löschen ist nur erlaubt, wenn ein eigener Ordner für verarbeitete Mails eingetragen ist –
 *  nie im Posteingang bzw. im abgerufenen Ordner. */
export function purgeFolder(cfg) {
  const folder = String(cfg.processedFolder || '').trim();
  if (!folder) return null;
  const source = String(cfg.folder || 'INBOX').trim();
  if (folder.toLowerCase() === source.toLowerCase() || folder.toLowerCase() === 'inbox') return null;
  return folder;
}

/**
 * Verarbeitete Mails im Ordner löschen, die älter als die eingestellte Zahl Tage sind
 * (Eingangsdatum am Server, IMAP SEARCH BEFORE). Höchstens MAX_PURGE_PER_RUN pro Lauf.
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
