// Sending email and notifications.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { t, normalizeLang } from '../i18n.js';
import { log } from '../lib/log.js';
import { parseRules, matchRule } from './rules.js';
import { mentionsAsText } from '../mentions.js';
import { mdToText, mdToHtml, mailHtml, MAIL_BODY } from '../markdown.js';
import { agentOn } from '../auth/access.js';

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
  const remember = db.prepare("INSERT OR IGNORE INTO mail_messages(message_id,ticket_id,direction,agent_only,recipient) VALUES(?,?,'out',?,?)");
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

  /** No mails to senders with a "never reply" rule or to blocked (undeliverable) addresses. */
  function blocked(to) {
    const rule = matchRule(parseRules(settings.get('imap.senderRules')), to);
    if (rule) return 'Regel';
    if (suppressions?.isBlocked(to)) return 'gesperrt (unzustellbar)';
    return null;
  }

  const agentAccount = db.prepare("SELECT 1 FROM users WHERE lower(email)=? AND role IN ('agent','admin') LIMIT 1");

  /** customer: mail to reporter/participants. Otherwise (assignment, SLA, approval …) and if the recipient is an
   *  agent account, the mail is recorded as "agents only" (mail_messages.agent_only):
   *  replies to it become internal notes. The Message-ID does not reveal this. */
  async function send({ to, subject, text, html = undefined, ticketId = null, inReplyTo = null, customer = false }) {
    const tr = getTransport();
    if (!tr) return false;
    const why = blocked(to);
    if (why) { log.info(`No mail to ${to}: ${why}`); return false; }
    const domain = tr.cfg.from.split('@')[1] || 'helfi.space';
    const agentOnly = !customer && !!ticketId && !!agentAccount.get(String(to || '').toLowerCase());
    // Not guessable: replies are matched to tickets via this ID
    const messageId = `<helfi.${ticketId || 0}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}@${domain}>`;
    await tr.transport.sendMail({
      from: { name: tr.cfg.fromName || 'Helfi.Space', address: tr.cfg.from },
      to,
      subject,
      text,
      // formatted comments additionally as HTML (the text part stays complete and readable)
      ...(html ? { html } : {}),
      messageId,
      inReplyTo: inReplyTo || undefined,
      references: inReplyTo || undefined,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All', 'X-Helfi-Ticket': ticketId ? String(ticketId) : '' },
    });
    if (ticketId) remember.run(messageId.replace(/[<>]/g, ''), ticketId, agentOnly ? 1 : 0, String(to || '').trim().toLowerCase());
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

/** Embedded images in mails as a note instead of markup (the images are in the ticket). */
export function inlineImagesAsText(text, lang) {
  return mentionsAsText(text || '').replace(/!\[([^\]]*)\]\(\/api\/attachments\/\d+\)/g, (m, name) => `[${lang === 'en' ? 'Image' : 'Bild'}: ${name || '…'}]`);
}

/** Comment text for a mail: formatted ones without markup, images as a note */
export function commentAsText(comment, lang) {
  return comment.format === 'md' ? mdToText(comment.body, lang, config.baseUrl) : inlineImagesAsText(comment.body, lang);
}

/** HTML part for a formatted comment: the mail template with the comment in its place (else undefined) */
export function commentMailHtml(comment, lang, template, vars) {
  if (comment.format !== 'md') return undefined;
  return mailHtml(t(lang, template, { ...vars, body: MAIL_BODY }), mdToHtml(comment.body, { lang, baseUrl: config.baseUrl }));
}

/** Attaches the notifications to the ticket events. */
export function wireNotifications({ tickets, mailer, settings, users, survey = null }) {
  const link = (tk) => `${config.baseUrl}/browse/${tk.key}`;
  const appName = () => settings.get('general.title') || 'Helfi.Space';

  function recipientLang(userId) {
    const u = userId ? users.byId(userId) : null;
    return normalizeLang(u?.language, settings.get('general.defaultLanguage'));
  }

  const safe = (fn) => (payload) => {
    if (!mailer.enabled()) return;
    // Ticket discarded in the meantime (transaction rolled back) or deleted → no mail
    if (!tickets.rawById(payload.ticket.id)) return;
    Promise.resolve(fn(payload)).catch((e) => log.warn('Notification failed', { error: e.message }));
  };

  // Confirmations to senders can be triggered with a forged sender → overall limit per hour
  let confirmWindow = { start: Date.now(), count: 0 };
  tickets.events.on('created', safe(async ({ ticket }) => {
    if (!settings.get('notify.reporterOnCreate') || ticket.source !== 'email') return;
    if (Date.now() - confirmWindow.start > 3600_000) confirmWindow = { start: Date.now(), count: 0 };
    if (++confirmWindow.count > MAX_CONFIRMATIONS_PER_HOUR) { log.warn('Receipt confirmations: hourly limit reached – no further confirmation'); return; }
    const to = ticket.reporter?.email;
    if (!to) return;
    const lang = recipientLang(ticket.reporter.id);
    const vars = { key: ticket.key, title: ticket.title, name: ticket.reporter.displayName || t(lang, 'mail.greetingFallback'), link: link(ticket), app: appName() };
    await mailer.send({ to, subject: t(lang, 'mail.created.subject', vars), text: t(lang, 'mail.created.body', vars), ticketId: ticket.id, inReplyTo: ticket.sourceMessageId, customer: true });
  }));

  // Agent entered the ticket for someone else (or made them the reporter): tell that person,
  // with a hint to the portal so they can use it themselves next time (accounts only)
  async function toNewReporter(ticket, kind) {
    const rep = ticket.reporter?.id ? users.byId(ticket.reporter.id) : null;
    if (!rep || !rep.active || !rep.email) return;
    const lang = recipientLang(rep.id);
    const vars = { key: ticket.key, title: ticket.title, name: rep.display_name || t(lang, 'mail.greetingFallback'), link: link(ticket), app: appName() };
    vars.reply = settings.get('imap.enabled') ? t(lang, 'mail.createdFor.reply', vars) : '';
    vars.portal = rep.source !== 'email' && settings.get('general.allowSelfService') ? t(lang, 'mail.createdFor.portal', { ...vars, portalLink: `${config.baseUrl}/` }) : '';
    await mailer.send({ to: rep.email, subject: t(lang, `mail.${kind}.subject`, vars), text: t(lang, `mail.${kind}.body`, vars), ticketId: ticket.id, customer: true });
  }
  tickets.events.on('created', safe(async ({ ticket, notifyReporter }) => { if (notifyReporter) await toNewReporter(ticket, 'createdFor'); }));
  tickets.events.on('reporterChanged', safe(async ({ ticket }) => toNewReporter(ticket, 'reporterChanged')));

  /** One separate mail per recipient (reporter and request participants) in their language – no
   *  addresses of other parties in the headers. The person who triggered it gets nothing. */
  async function toCustomers(ticket, actorId, build) {
    for (const r of tickets.customerRecipients(ticket.id)) {
      if (actorId && r.id === actorId) continue;
      const lang = recipientLang(r.id);
      const built = build(lang, r.displayName || t(lang, 'mail.greetingFallback'), r);
      if (!built) continue; // builder decided: no mail to this recipient
      const { subject, text, html } = built;
      await mailer.send({ to: r.email, subject, text, html, ticketId: ticket.id, customer: true });
    }
  }

  tickets.events.on('commented', safe(async ({ ticket, comment, user, internal, resolutionReply = false }) => {
    // Never forward comments from emails: mail senders can be forged
    if (internal || comment.source === 'email' || !user) return;
    // The reason of a rejection/duplicate replaces the "Resolved" mail: it follows reporterOnDone
    // as well, otherwise the reporter would learn nothing with reply mails switched off
    if (!settings.get('notify.reporterOnComment') && !(resolutionReply && settings.get('notify.reporterOnDone'))) return;
    const assignee = ticket.assignee?.displayName && ticket.assignee.id !== user.id ? ticket.assignee.displayName : null;
    await toCustomers(ticket, user.id, (lang, name) => {
      const vars = {
        key: ticket.key, title: ticket.title, name, author: user.display_name, body: commentAsText(comment, lang), link: link(ticket), app: appName(),
        // The sender is always the ticket system – the agent's name only appears in the text
        contact: assignee ? `${t(lang, 'mail.contact', { name: assignee })}\n` : '',
        closing: t(lang, 'mail.closing', { author: user.display_name || user.username, app: appName() }),
      };
      return { subject: t(lang, 'mail.comment.subject', vars), text: t(lang, 'mail.comment.body', vars), html: commentMailHtml(comment, lang, 'mail.comment.body', vars) };
    });
  }));

  // @-mentions: one mail per mentioned person. Customers who get the reply mail anyway get nothing extra.
  tickets.events.on('mentioned', safe(async ({ ticket, comment, user, internal, userIds }) => {
    if (!settings.get('notify.mention') || !user) return;
    const customers = !internal && settings.get('notify.reporterOnComment') ? new Set(tickets.customerRecipients(ticket.id).map((r) => r.id)) : new Set();
    for (const id of userIds) {
      if (id === user.id || customers.has(id)) continue;
      const u = users.byId(id);
      if (!u || !u.active || !u.email) continue;
      const agentRecipient = agentOn(u, ticket.projectId);
      // Internal notes only ever go to agents of the project (the comment layer already ensures this)
      if (internal && !agentRecipient) continue;
      const lang = recipientLang(u.id);
      const vars = {
        key: ticket.key, title: ticket.title, name: u.display_name || t(lang, 'mail.greetingFallback'),
        author: user.display_name || user.username, body: commentAsText(comment, lang), link: link(ticket), app: appName(),
        kind: t(lang, internal ? 'mail.mention.inNote' : 'mail.mention.inReply'),
      };
      await mailer.send({ to: u.email, subject: t(lang, 'mail.mention.subject', vars), text: t(lang, 'mail.mention.body', vars), html: commentMailHtml(comment, lang, 'mail.mention.body', vars), ticketId: ticket.id, customer: !agentRecipient });
    }
  }));

  tickets.events.on('resolved', safe(async ({ ticket, user, quiet = false }) => {
    if (!settings.get('notify.reporterOnDone')) return;
    // Rating links only for the reporter (not for request participants)
    const raw = tickets.rawById(ticket.id);
    const isReporter = (r) => (raw.reporter_id ? r.id === raw.reporter_id : r.email === String(raw.reporter_email || '').toLowerCase());
    // quiet (a reply already went out at the same time): no second mail – except the rating links for the reporter
    if (quiet && !(survey?.enabled() && tickets.customerRecipients(ticket.id).some(isReporter))) return;
    await toCustomers(ticket, user?.id, (lang, name, r) => {
      if (quiet && !isReporter(r)) return null;
      const token = survey && isReporter(r) ? survey.issueToken(ticket.id) : null;
      if (quiet && !token) return null;
      let surveyText = '';
      if (token) {
        const url = (n) => `${config.baseUrl}/rate/${token}?r=${n}`;
        surveyText = `\n\n${t(lang, 'mail.survey', { days: settings.get('survey.days') })}\n${[5, 4, 3, 2, 1].map((n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${t(lang, `survey.label.${n}`)}: ${url(n)}`).join('\n')}`;
      }
      const agentName = user && ['agent', 'admin'].includes(user.role) ? (user.display_name || user.username) : null;
      const vars = {
        key: ticket.key, title: ticket.title, name, link: link(ticket), app: appName(), survey: surveyText,
        // as with replies: only if someone other than the resolver is assigned
        contact: ticket.assignee?.displayName && ticket.assignee.id !== user?.id ? `${t(lang, 'mail.contact', { name: ticket.assignee.displayName })}\n` : '',
        closing: agentName ? t(lang, 'mail.closing', { author: agentName, app: appName() }) : appName(),
      };
      return { subject: t(lang, 'mail.done.subject', vars), text: t(lang, 'mail.done.body', vars) };
    });
  }));

  tickets.events.on('participantAdded', safe(async ({ ticket, participant, user }) => {
    if (!settings.get('notify.participantAdded') || !participant.email || participant.id === user?.id) return;
    const lang = recipientLang(participant.id);
    const vars = { key: ticket.key, title: ticket.title, name: participant.display_name || t(lang, 'mail.greetingFallback'), author: user?.display_name || appName(), link: link(ticket), app: appName() };
    await mailer.send({ to: participant.email, subject: t(lang, 'mail.participant.subject', vars), text: t(lang, 'mail.participant.body', vars), ticketId: ticket.id, customer: true });
  }));

  tickets.events.on('assigned', safe(async ({ ticket, user }) => {
    if (!settings.get('notify.assignee') || !ticket.assignee?.email || ticket.assignee.id === user?.id) return;
    const lang = recipientLang(ticket.assignee.id);
    const vars = { key: ticket.key, title: ticket.title, name: ticket.assignee.displayName, link: link(ticket), app: appName() };
    await mailer.send({ to: ticket.assignee.email, subject: t(lang, 'mail.assigned.subject', vars), text: t(lang, 'mail.assigned.body', vars), ticketId: ticket.id });
  }));
}
