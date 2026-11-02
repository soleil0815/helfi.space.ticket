// E-Mail-Versand und Benachrichtigungen.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { t, normalizeLang } from '../i18n.js';
import { log } from '../lib/log.js';
import { parseRules, matchRule } from './rules.js';

export function transportOptions(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    ignoreTLS: cfg.security === 'none',
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    tls: { rejectUnauthorized: cfg.verifyTls, minVersion: 'TLSv1.2' },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
}

export const MAX_CONFIRMATIONS_PER_HOUR = 60;

export function createMailer(db, settings, { suppressions = null } = {}) {
  const remember = db.prepare("INSERT OR IGNORE INTO mail_messages(message_id,ticket_id,direction) VALUES(?,?,'out')");
  let transport = null;
  let transportKey = '';

  function getTransport() {
    const cfg = settings.group('smtp');
    if (!cfg.enabled || !cfg.host || !cfg.from) return null;
    const key = JSON.stringify(cfg);
    if (!transport || key !== transportKey) {
      transport = nodemailer.createTransport(transportOptions(cfg));
      transportKey = key;
    }
    return { transport, cfg };
  }

  /** Keine Mails an Absender mit Regel „nie antworten“ und an gesperrte (unzustellbare) Adressen. */
  function blocked(to) {
    const rule = matchRule(parseRules(settings.get('imap.senderRules')), to);
    if (rule) return 'Regel';
    if (suppressions?.isBlocked(to)) return 'gesperrt (unzustellbar)';
    return null;
  }

  async function send({ to, subject, text, ticketId = null, inReplyTo = null }) {
    const tr = getTransport();
    if (!tr) return false;
    const why = blocked(to);
    if (why) { log.info(`Keine Mail an ${to}: ${why}`); return false; }
    const domain = tr.cfg.from.split('@')[1] || 'helfi.space';
    // Nicht erratbar: über diese ID werden Antworten Tickets zugeordnet
    const messageId = `<helfi.${ticketId || 0}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}@${domain}>`;
    await tr.transport.sendMail({
      from: { name: tr.cfg.fromName || 'Helfi.Space', address: tr.cfg.from },
      to,
      subject,
      text,
      messageId,
      inReplyTo: inReplyTo || undefined,
      references: inReplyTo || undefined,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All', 'X-Helfi-Ticket': ticketId ? String(ticketId) : '' },
    });
    if (ticketId) remember.run(messageId.replace(/[<>]/g, ''), ticketId);
    return true;
  }

  async function test(cfg, to, lang) {
    const tr = nodemailer.createTransport(transportOptions(cfg));
    await tr.verify();
    await tr.sendMail({
      from: { name: cfg.fromName || 'Helfi.Space', address: cfg.from },
      to,
      subject: t(lang, 'mail.test.subject'),
      text: t(lang, 'mail.test.body'),
    });
  }

  return { send, test, blocked, enabled: () => !!getTransport() };
}

/** Eingebettete Bilder in Mails als Hinweis statt Markup (die Bilder liegen im Ticket). */
export function inlineImagesAsText(text, lang) {
  return String(text || '').replace(/!\[([^\]]*)\]\(\/api\/attachments\/\d+\)/g, (m, name) => `[${lang === 'en' ? 'Image' : 'Bild'}: ${name || '…'}]`);
}

/** Hängt die Benachrichtigungen an die Ticket-Ereignisse. */
export function wireNotifications({ tickets, mailer, settings, users, survey = null }) {
  const link = (tk) => `${config.baseUrl}/browse/${tk.key}`;
  const appName = () => settings.get('general.title') || 'Helfi.Space';

  function recipientLang(userId) {
    const u = userId ? users.byId(userId) : null;
    return normalizeLang(u?.language, settings.get('general.defaultLanguage'));
  }

  const safe = (fn) => (payload) => {
    if (!mailer.enabled()) return;
    // Ticket inzwischen verworfen (Transaktion zurückgerollt) oder gelöscht → keine Mail
    if (!tickets.rawById(payload.ticket.id)) return;
    Promise.resolve(fn(payload)).catch((e) => log.warn('Benachrichtigung fehlgeschlagen', { error: e.message }));
  };

  // Bestätigungen an Absender lassen sich mit gefälschtem Absender auslösen → Gesamtgrenze je Stunde
  let confirmWindow = { start: Date.now(), count: 0 };
  tickets.events.on('created', safe(async ({ ticket }) => {
    if (!settings.get('notify.reporterOnCreate') || ticket.source !== 'email') return;
    if (Date.now() - confirmWindow.start > 3600_000) confirmWindow = { start: Date.now(), count: 0 };
    if (++confirmWindow.count > MAX_CONFIRMATIONS_PER_HOUR) { log.warn('Eingangsbestätigungen: Stundengrenze erreicht – keine weitere Bestätigung'); return; }
    const to = ticket.reporter?.email;
    if (!to) return;
    const lang = recipientLang(ticket.reporter.id);
    const vars = { key: ticket.key, title: ticket.title, name: ticket.reporter.displayName || t(lang, 'mail.greetingFallback'), link: link(ticket), app: appName() };
    await mailer.send({ to, subject: t(lang, 'mail.created.subject', vars), text: t(lang, 'mail.created.body', vars), ticketId: ticket.id, inReplyTo: ticket.sourceMessageId });
  }));

  /** Je Empfänger (Melder und Anfrage-Teilnehmer) eine eigene Mail in seiner Sprache – keine
   *  Adressen anderer Beteiligter im Kopf. Der Auslöser selbst bekommt nichts. */
  async function toCustomers(ticket, actorId, build) {
    for (const r of tickets.customerRecipients(ticket.id)) {
      if (actorId && r.id === actorId) continue;
      const lang = recipientLang(r.id);
      const { subject, text } = build(lang, r.displayName || t(lang, 'mail.greetingFallback'), r);
      await mailer.send({ to: r.email, subject, text, ticketId: ticket.id });
    }
  }

  tickets.events.on('commented', safe(async ({ ticket, comment, user, internal }) => {
    // Kommentare aus E-Mails nie weiterleiten: Absender von Mails lassen sich fälschen
    if (internal || comment.source === 'email' || !settings.get('notify.reporterOnComment') || !user) return;
    await toCustomers(ticket, user.id, (lang, name) => {
      const vars = { key: ticket.key, title: ticket.title, name, author: user.display_name, body: inlineImagesAsText(comment.body, lang), link: link(ticket), app: appName() };
      return { subject: t(lang, 'mail.comment.subject', vars), text: t(lang, 'mail.comment.body', vars) };
    });
  }));

  tickets.events.on('resolved', safe(async ({ ticket, user }) => {
    if (!settings.get('notify.reporterOnDone')) return;
    // Bewertungslinks nur für den Melder selbst (nicht für Anfrage-Teilnehmer)
    const raw = tickets.rawById(ticket.id);
    const isReporter = (r) => (raw.reporter_id ? r.id === raw.reporter_id : r.email === String(raw.reporter_email || '').toLowerCase());
    await toCustomers(ticket, user?.id, (lang, name, r) => {
      const vars = { key: ticket.key, title: ticket.title, name, link: link(ticket), app: appName() };
      let text = t(lang, 'mail.done.body', vars);
      const token = survey && isReporter(r) ? survey.issueToken(ticket.id) : null;
      if (token) {
        const url = (n) => `${config.baseUrl}/rate/${token}?r=${n}`;
        text = `${text}\n\n${t(lang, 'mail.survey', { days: settings.get('survey.days') })}\n${[5, 4, 3, 2, 1].map((n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${t(lang, `survey.label.${n}`)}: ${url(n)}`).join('\n')}`;
      }
      return { subject: t(lang, 'mail.done.subject', vars), text };
    });
  }));

  tickets.events.on('participantAdded', safe(async ({ ticket, participant, user }) => {
    if (!settings.get('notify.participantAdded') || !participant.email || participant.id === user?.id) return;
    const lang = recipientLang(participant.id);
    const vars = { key: ticket.key, title: ticket.title, name: participant.display_name || t(lang, 'mail.greetingFallback'), author: user?.display_name || appName(), link: link(ticket), app: appName() };
    await mailer.send({ to: participant.email, subject: t(lang, 'mail.participant.subject', vars), text: t(lang, 'mail.participant.body', vars), ticketId: ticket.id });
  }));

  tickets.events.on('assigned', safe(async ({ ticket, user }) => {
    if (!settings.get('notify.assignee') || !ticket.assignee?.email || ticket.assignee.id === user?.id) return;
    const lang = recipientLang(ticket.assignee.id);
    const vars = { key: ticket.key, title: ticket.title, name: ticket.assignee.displayName, link: link(ticket), app: appName() };
    await mailer.send({ to: ticket.assignee.email, subject: t(lang, 'mail.assigned.subject', vars), text: t(lang, 'mail.assigned.body', vars), ticketId: ticket.id });
  }));
}
