// REST API for the UI.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { isHexColor, saveLogo, removeLogo } from '../brand.js';
import { viewerDocument } from '../mail/html.js';
import { createItilRoutes } from './itil.js';
import { zammadAdapter } from '../import/zammad.js';
import { znunyAdapter } from '../import/znuny.js';
import { glpiAdapter } from '../import/glpi.js';
import { zendeskAdapter } from '../import/zendesk.js';
import { freshdeskAdapter } from '../import/freshdesk.js';
import { csvAdapter, readCsv, suggestColumns, CSV_FIELDS, MAX_CSV_BYTES } from '../import/csv.js';
import { config, paths, COMPOSE_VERSION } from '../config.js';
import { HttpError, notFound, forbidden, str, oneOf, int } from '../lib/http.js';
import { verifyPassword, hashPassword, safeEqual } from '../lib/crypto.js';
import { requireAuth, requireRole, isAgent, idleMinutes } from '../auth/session.js';
import { publicUser, userRef, roleFromGroups, normalizeEmail } from '../users.js';
import * as ldap from '../auth/ldap.js';
import * as oidcAuth from '../auth/oidc.js';
import { parseNetworks, parseOwnAddresses, MFA_LEVELS } from '../auth/network.js';
import { testImap } from '../mail/imap.js';
import { normalizeLang, LANGUAGES, t, hasKey, langFromHeader } from '../i18n.js';
import { fillPlaceholders } from '../../public/js/placeholders.js';
import { DEFAULTS } from '../settings.js';
import { backupDatabase, listBackups, pruneBackups, deleteBackup, clampBackupKeep } from '../db.js';
import { log } from '../lib/log.js';
import { RESET_MODES, parseDomains } from '../auth/selfservice.js';
import { REASONING, normalizeBaseUrl, listModels } from '../ai.js';
import { LINK_KINDS } from '../itil/links.js';
import { createSavedFilters } from '../filters.js';
import { CLASSIFY_MODES } from '../ai-classify.js';

const DUMMY_HASH = hashPassword('helfi-dummy-kennwort');

const MAX_BULK = 500;
const MAX_DRAFTS = 20; // unsent uploads per person and ticket

export function createApi(ctx) {
  const { db, settings, sessions, users, tickets, mailer, poller, limiter, setup, jiraImporter, policy, mfa, canned, reports, suppressions } = ctx;
  const r = express.Router();
  // Staging area in the data folder: same file system as the attachments (no EXDEV in the container)
  const uploadTmp = path.join(paths.attachments, '.tmp');
  // Remove leftovers of aborted uploads at startup
  fs.rmSync(uploadTmp, { recursive: true, force: true });
  fs.mkdirSync(uploadTmp, { recursive: true });
  const upload = multer({ dest: uploadTmp, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- Public ----------
  r.get('/bootstrap', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    res.json({
      app: { title: settings.get('general.title'), version: config.version },
      brand: { logo: settings.get('brand.logo'), showTitle: settings.get('brand.showTitle'), header: settings.get('brand.header') },
      // Custom texts of the sign-in page (length limited; rendered without HTML)
      login: {
        title: String(settings.get('login.title')).slice(0, 80),
        text: { de: String(settings.get('login.textDe')).slice(0, 4000), en: String(settings.get('login.textEn')).slice(0, 4000) },
        userLabel: { de: String(settings.get('login.userLabelDe')).slice(0, 80), en: String(settings.get('login.userLabelEn')).slice(0, 80) },
      },
      setupRequired: userCount === 0,
      majorIncidents: req.user && isAgent(req.user) ? ctx.major.open() : [],
      sla: { enabled: ctx.sla.enabled() },
      pendingApprovals: req.user ? ctx.approvals.pendingFor(req.user.id).length : 0,
      adPeople: !!(req.user && isAgent(req.user) && adPeopleOn()), // people search in AD available
      ai: !!(req.user && isAgent(req.user) && ctx.ai.ready()), // AI assistance (summary, reply suggestion)
      // which AI functions are switched on (agents only)
      aiFeatures: req.user && isAgent(req.user) ? ctx.ai.features() : null,
      session: ctx.sessions.info(req), // automatic sign-out: idle period, time left (signed in only)
      // News of the current version that this account has not seen yet
      news: req.user ? ctx.news.unseen(req.user) : null,
      maxUploadMb: config.maxUploadMb, // upload limit per file (the mobile UI checks it before uploading)
      hasCatalog: !!db.prepare('SELECT 1 FROM catalog_items WHERE active=1 LIMIT 1').get(),
      user: req.user ? publicUser(req.user) : null,
      auth: {
        ldap: settings.get('ldap.enabled'),
        oidc: settings.get('oidc.enabled') ? { label: settings.get('oidc.buttonLabel'), autoRedirect: settings.get('oidc.autoRedirect') } : null,
        // Self-registration and "forgot password" (only with working mail sending)
        ...(req.user ? {} : ctx.selfService.status()),
      },
      allowSelfService: settings.get('general.allowSelfService'),
      defaultLanguage: settings.get('general.defaultLanguage'),
      // mode: requirement for this account (always/external/internal/off); without sign-in "external" applies to everyone
      mfa: {
        mode: req.user ? policy.userMode(req.user) : (policy.levels().external === 'none' ? 'off' : 'external'),
        internal: policy.isInternal(req), enabled: !!req.user?.totp_enabled,
      },
      warnings: req.user?.role === 'admin' ? adminWarnings() : [],
    });
  });

  function adminWarnings() {
    const w = [];
    if (config.composeVersion && config.composeVersion < COMPOSE_VERSION) w.push({ code: 'composeOutdated', have: config.composeVersion, want: COMPOSE_VERSION });
    if (!config.composeVersion) w.push({ code: 'composeUnknown', want: COMPOSE_VERSION });
    if (ctx.ldapCertWarning) w.push(ctx.ldapCertWarning);
    const pendingAccounts = db.prepare('SELECT COUNT(*) n FROM users WHERE approval_pending=1').get().n;
    if (pendingAccounts) w.push({ code: 'accountsPending', count: pendingAccounts });
    const ps = poller.status();
    if (settings.get('imap.enabled') && ps.lastError) w.push({ code: 'imapError', message: ps.lastError });
    if (!config.baseUrl.startsWith('https://')) w.push({ code: 'noHttps' });
    if (policy.proxyWarning()) w.push({ code: 'proxyUntrusted' });
    const nets = parseNetworks(settings.get('mfa.internalNetworks'));
    if (nets.invalid.length) w.push({ code: 'networksInvalid', message: nets.invalid.join(', ') });
    const own = parseOwnAddresses(settings.get('mfa.ownAddresses'));
    if (own.invalid.length) w.push({ code: 'ownAddressesInvalid', message: own.invalid.join(', ') });
    return w;
  }

  r.post('/setup', wrap(async (req, res) => {
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) throw new HttpError(409, 'err.setupDone');
    if (!setup.token || !safeEqual(str(req.body.token).trim(), setup.token)) throw new HttpError(403, 'err.setupToken');
    const username = str(req.body.username, 64).trim();
    if (!/^[\p{L}\p{N}._-]{2,64}$/u.test(username)) throw new HttpError(400, 'err.badRequest', 'username');
    const lang = normalizeLang(req.body.language, 'de');
    const user = db.transaction(() => {
      const u = users.createLocal({
        username, displayName: str(req.body.displayName, 120).trim() || username, email: str(req.body.email, 254).trim(),
        role: 'admin', password: str(req.body.password, 256), language: lang,
      });
      settings.set('general.defaultLanguage', lang);
      const pKey = str(req.body.projectKey, 10).trim().toUpperCase();
      if (pKey) {
        const p = tickets.projects.create({ key: pKey, name: str(req.body.projectName, 120).trim() || 'Helpdesk', leadId: u.id });
        settings.set('general.defaultProject', p.key);
      }
      return u;
    })();
    setup.token = null;
    log.info(`Initial setup completed, local admin "${user.username}" created`);
    // The setup code from the log counts as a second factor
    sessions.create(res, user.id, req.ip, 'local', { mfa: true });
    res.json({ user: publicUser(user) });
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const username = str(req.body.username, 256).trim();
    const password = str(req.body.password, 1024);
    limiter.check(req.ip, username);
    if (!username || !password) throw new HttpError(401, 'err.invalidLogin');

    // 1. Local account (e.g. emergency admin)
    const local = users.byName(username);
    // Same response time whether the local account exists or not (no name detection via timing)
    if (!(local && local.source === 'local' && local.password_hash)) verifyPassword(password, DUMMY_HASH);
    if (local && local.source === 'local' && local.password_hash) {
      if (!verifyPassword(password, local.password_hash)) { limiter.fail(req.ip, username); throw new HttpError(401, 'err.invalidLogin'); }
      // Self-registered, not approved yet: the password is right, so say why (no guessing aid)
      if (!local.active && local.approval_pending) throw new HttpError(403, 'err.approvalPending');
      // Disabled: same response as for a wrong password (otherwise it would reveal that it is correct)
      if (!local.active) { limiter.fail(req.ip, username); throw new HttpError(401, 'err.invalidLogin'); }
      const r1 = mfa.afterPrimary(req, res, local, 'local');
      if (r1.done) limiter.success(req.ip, username);
      return res.json(r1.done ? { user: publicUser(local) } : { mfa: r1.step });
    }

    // 2. Active Directory
    if (settings.get('ldap.enabled')) {
      const cfg = settings.group('ldap');
      let info;
      try {
        info = await ldap.authenticate(cfg, username, password);
      } catch (e) {
        log.error('AD sign-in: connection problem', { error: e.message });
        // Local accounts still work – point that out
        throw new HttpError(503, 'err.ldapUnavailable');
      }
      if (!info) { limiter.fail(req.ip, username); throw new HttpError(401, 'err.invalidLogin'); }
      const role = roleFromGroups(info.groups, cfg);
      if (!info.groups.user && role !== 'admin' && role !== 'agent') {
        // Deliberately a separate message (helps support); admins see in the log who was rejected
        log.warn(`AD sign-in rejected: ${info.username} is not in the "allowed users" group`);
        throw new HttpError(403, 'err.notInGroup');
      }
      const u = users.upsertExternal({ source: 'ldap', username: info.username, displayName: info.displayName, email: info.email, externalId: info.externalId, sid: info.sid, role });
      if (!u.active) { limiter.fail(req.ip, username); throw new HttpError(401, 'err.invalidLogin'); }
      const r2 = mfa.afterPrimary(req, res, u, 'ldap');
      if (r2.done) limiter.success(req.ip, username);
      return res.json(r2.done ? { user: publicUser(u) } : { mfa: r2.step });
    }

    limiter.fail(req.ip, username);
    throw new HttpError(401, 'err.invalidLogin');
  }));

  // Second step of sign-in (without full session, with cookie helfi_mfa)
  r.post('/auth/mfa/enroll', wrap(async (req, res) => res.json(await mfa.enrollInfo(req))));
  r.post('/auth/mfa', wrap(async (req, res) => {
    const out = mfa.verify(req, res, str(req.body.code, 40));
    res.json({ user: publicUser(out.user), recoveryCodes: out.recoveryCodes, usedRecovery: out.usedRecovery });
  }));

  // Self-registration and "forgot password": one-time links by mail (src/auth/selfservice.js)
  r.post('/auth/register', wrap(async (req, res) => res.json(ctx.selfService.register(req))));
  r.post('/auth/register/confirm', wrap(async (req, res) => res.json(ctx.selfService.confirmRegistration(req.body.token))));
  r.post('/auth/password/forgot', wrap(async (req, res) => res.json(ctx.selfService.requestReset(req))));
  r.post('/auth/password/reset', wrap(async (req, res) => res.json(ctx.selfService.resetPassword(req))));

  // Automatic sign-out: "status" does not count as activity (see session.js), "ping" does
  r.get('/session/status', requireAuth, (req, res) => res.json(ctx.sessions.info(req)));
  r.post('/session/ping', requireAuth, (req, res) => res.json(ctx.sessions.info(req)));

  r.post('/auth/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  // Satisfaction survey: link from the "Resolved" mail, without sign-in (token = authorization)
  r.get('/public/rating/:token', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(ctx.survey.publicInfo(req.params.token)); });
  r.post('/public/rating/:token', (req, res) => res.json(ctx.survey.rateByToken(req.params.token, req.body.rating, req.body.comment)));

  // From here on signed in only
  r.use(requireAuth);
  r.use(createItilRoutes(ctx));

  // ---------- Own account ----------
  r.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/me', wrap(async (req, res) => {
    const u = req.user;
    // Validate everything first, then save
    let newHash = null;
    // Name and address: local accounts only (for AD/SSO they come from there and would be overwritten)
    let displayName = null;
    let email;
    if (req.body.displayName !== undefined || req.body.email !== undefined) {
      if (u.source !== 'local') throw new HttpError(400, 'err.managedExternally');
      if (req.body.displayName !== undefined) displayName = str(req.body.displayName, 120).trim() || null;
      if (req.body.email !== undefined) {
        email = normalizeEmail(str(req.body.email, 254));
        // Self-registered: the confirmed address is the sign-in name and decides which mails and
        // contact tickets belong to the account – only an admin may change it
        if (u.self_registered && email !== String(u.email || '').toLowerCase()) throw new HttpError(400, 'err.emailFixed');
        // New address = new matching of incoming mails → require the current password
        if (email !== String(u.email || '').toLowerCase()) {
          limiter.check(req.ip, u.username);
          if (!u.password_hash || !verifyPassword(str(req.body.currentPassword, 1024), u.password_hash)) { limiter.fail(req.ip, u.username); throw new HttpError(400, 'err.invalidLogin'); }
        } else email = undefined;
      }
    }
    if (req.body.newPassword !== undefined) {
      if (u.source !== 'local' || !u.password_hash) throw forbidden();
      limiter.check(req.ip, u.username);
      if (!verifyPassword(str(req.body.currentPassword, 1024), u.password_hash)) { limiter.fail(req.ip, u.username); throw new HttpError(400, 'err.invalidLogin'); }
      const pw = str(req.body.newPassword, 1024);
      if (pw.length < 10) throw new HttpError(400, 'err.passwordWeak');
      newHash = hashPassword(pw);
    }
    if (req.body.theme !== undefined && !['system', 'light', 'dark'].includes(req.body.theme)) throw new HttpError(400, 'err.badRequest', 'theme');
    db.transaction(() => {
      if (req.body.language !== undefined) {
        db.prepare('UPDATE users SET language=? WHERE id=?').run(req.body.language ? normalizeLang(req.body.language) : null, u.id);
      }
      if (req.body.theme !== undefined) {
        // NULL = system (follows the device)
        db.prepare('UPDATE users SET theme=? WHERE id=?').run(req.body.theme === 'system' ? null : req.body.theme, u.id);
      }
      if (displayName) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, u.id);
      if (email) {
        // Self-service must never merge an email contact: knowing the password of one's own account
        // does not prove ownership of the address. Accounts first (409 emailTaken as before),
        // then contacts – only an admin may link them (PATCH /users/:id merges).
        const others = db.prepare('SELECT source FROM users WHERE lower(email)=? AND id<>?').all(email, u.id);
        if (others.some((o) => o.source !== 'email')) throw new HttpError(409, 'err.emailTaken');
        if (others.length) throw new HttpError(409, 'err.emailKnownContact');
      }
      if (email !== undefined) users.setEmail(u.id, email);
      if (newHash) {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, u.id);
        // Password changed → end all other (possibly stolen) sessions
        db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(u.id, req.sessionId);
      }
    })();
    res.json({ user: publicUser(users.byId(u.id)) });
  }));

  // ---------- Two-factor in the profile ----------
  r.get('/me/mfa', (req, res) => res.json(mfa.status(req, req.user)));
  r.post('/me/mfa/setup', wrap(async (req, res) => res.json(await mfa.startSetup(req, req.user))));
  r.post('/me/mfa/enable', wrap(async (req, res) => res.json({ recoveryCodes: mfa.confirmSetup(req, req.user, str(req.body.code, 40)) })));
  r.post('/me/mfa/disable', wrap(async (req, res) => { mfa.disable(req, req.user, str(req.body.code, 40)); res.json({ ok: true }); }));
  r.post('/me/mfa/recovery', wrap(async (req, res) => res.json({ recoveryCodes: mfa.newRecoveryCodes(req, req.user, str(req.body.code, 40)) })));

  // ---------- Users ----------
  r.get('/users', requireRole('agent'), (req, res) => {
    const all = req.query.all === '1' && req.user.role === 'admin';
    const rows = all
      ? db.prepare('SELECT * FROM users ORDER BY active DESC, display_name').all()
      : db.prepare("SELECT * FROM users WHERE active=1 AND role IN ('agent','admin') ORDER BY display_name").all();
    res.json({ users: rows.map(all ? publicUser : userRef) });
  });

  // Search people (e.g. request participants): name/login name only, from 2 characters, at most 10 matches.
  // Users only find real accounts (no email contacts); only agents see addresses and login names.
  // Users do not match self-registered login names (= private address), so the search is no address oracle.
  // ---------- Search people (participants, owners) ----------
  const adPeopleOn = () => settings.get('ldap.enabled') && settings.get('ldap.peopleSearch') && !!settings.get('ldap.bindDn');
  const AD_TIMEOUT_MS = 5000;
  const withTimeout = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), AD_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  r.get('/people', wrap(async (req, res) => {
    const q = str(req.query.q, 100).trim();
    if (q.length < 2) return res.json({ people: [] });
    const agent = isAgent(req.user);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    let rows = db.prepare(`SELECT * FROM users WHERE active=1 ${agent ? '' : "AND source<>'email'"}
      AND (display_name LIKE ? ESCAPE '\\' OR (username LIKE ? ESCAPE '\\' ${agent ? '' : 'AND self_registered=0'}) ${agent ? "OR email LIKE ? ESCAPE '\\'" : ''})
      ORDER BY display_name LIMIT 10`).all(...(agent ? [like, like, like] : [like, like]));
    const out = { people: [] };
    const ad = [];
    // Agents: also search AD (read only; created only when added)
    if (agent && q.length >= 3 && req.query.ad !== '0' && adPeopleOn()) {
      try {
        const hits = await withTimeout(ctx.directory.search(settings.group('ldap'), q, { limit: 10 }));
        const byGuid = db.prepare("SELECT * FROM users WHERE source='ldap' AND external_id=?");
        for (const hit of hits) {
          const known = byGuid.get(hit.externalId);
          if (known && !known.active) continue; // disabled in Helfi.Space
          ad.push({ adId: hit.externalId, id: known ? known.id : undefined, displayName: hit.displayName, username: hit.username, email: hit.email || known?.email || '', source: 'ad' });
        }
        // Do not show the same person twice: existing AD account or email contact with the same address
        const ids = new Set(ad.map((a) => a.id).filter(Boolean));
        const mails = new Set(ad.map((a) => a.email.toLowerCase()).filter(Boolean));
        rows = rows.filter((u) => !ids.has(u.id) && !(u.source === 'email' && mails.has(String(u.email || '').toLowerCase())));
      } catch (e) {
        log.warn('People search in AD failed', { error: e.message });
        out.adError = true;
      }
    }
    // Login name only for agents (self-registered accounts: login name = private address)
    out.people = rows.map((u) => ({ id: u.id, displayName: u.display_name, username: agent ? u.username : undefined, email: agent ? (u.email || '') : undefined }));
    out.people.push(...ad);
    res.json(out);
  }));

  /** Create or update an AD person (by objectGUID or mail address) as a user. null = not in AD. */
  async function personFromAd({ adId, email }) {
    const cfg = settings.group('ldap');
    let info;
    try {
      info = await withTimeout(adId ? ctx.directory.byGuid(cfg, adId) : ctx.directory.byEmail(cfg, email));
    } catch (e) {
      log.warn('AD lookup failed when adding a participant', { error: e.message });
      if (adId) throw new HttpError(503, 'err.adUnavailable');
      return null; // by mail address: as an email contact, as before
    }
    if (!info || info.ambiguous) {
      if (adId) throw new HttpError(404, 'err.adPersonNotFound');
      return null;
    }
    const role = roleFromGroups(info.groups, cfg);
    let mail = '';
    try { mail = normalizeEmail(info.email || email || ''); } catch { /* invalid address in AD: import without address */ }
    if (!info.groups.user && role !== 'admin' && role !== 'agent') {
      // Not allowed to sign in according to groups: only as email contact (as with the sender lookup)
      if (!mail) throw new HttpError(400, 'err.adNotAllowed');
      return users.byEmail(mail) || users.contactForEmail(mail, info.displayName);
    }
    const u = users.upsertExternal({ source: 'ldap', username: info.username, displayName: info.displayName, email: mail, externalId: info.externalId, sid: info.sid, role });
    log.info(`Participant imported from AD: ${u.username}`);
    return u;
  }

  /**
   * Person for the reporter field (agents): { userId } | { adId } (from AD, created as a user
   * on first use) | { email, name? } (existing account, AD match by address or an email contact).
   */
  async function reporterFrom(choice) {
    if (!choice || typeof choice !== 'object') throw new HttpError(400, 'err.badRequest', 'reporter');
    let u = null;
    if (choice.userId !== undefined) {
      u = users.byId(int(choice.userId) || 0);
    } else if (typeof choice.adId === 'string' && choice.adId) {
      if (!adPeopleOn()) throw forbidden();
      if (!/^[0-9a-f]{32}$/i.test(choice.adId)) throw new HttpError(400, 'err.badRequest', 'adId');
      u = await personFromAd({ adId: choice.adId });
    } else if (typeof choice.email === 'string') {
      const e = normalizeEmail(str(choice.email, 254));
      if (!e) throw new HttpError(400, 'err.badRequest', 'email');
      const existing = users.byEmail(e);
      if (existing && existing.source !== 'email') u = existing;
      else {
        if (adPeopleOn()) u = await personFromAd({ email: e });
        if (!u) u = existing || users.contactForEmail(e, str(choice.name, 120).trim());
      }
    }
    if (!u || !u.active) throw new HttpError(400, 'err.reporterInvalid');
    return u;
  }

  r.post('/users', requireRole('admin'), wrap(async (req, res) => {
    const username = str(req.body.username, 64).trim();
    if (!/^[\p{L}\p{N}._@-]{2,64}$/u.test(username)) throw new HttpError(400, 'err.badRequest', 'username');
    const u = users.createLocal({
      username, displayName: str(req.body.displayName, 120).trim(), email: str(req.body.email, 254).trim(),
      role: oneOf(req.body.role, ['admin', 'agent', 'user'], 'user'), password: str(req.body.password, 1024),
    });
    res.status(201).json({ user: publicUser(u) });
  }));

  r.patch('/users/:id', requireRole('admin'), wrap(async (req, res) => {
    const u = users.byId(int(req.params.id));
    if (!u) throw notFound();
    const role = req.body.role !== undefined ? oneOf(req.body.role, ['admin', 'agent', 'user'], u.role) : u.role;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : u.active;
    if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && users.countActiveAdmins(u.id) === 0) {
      throw new HttpError(400, 'err.lastAdmin');
    }
    const roleLocked = req.body.roleLocked !== undefined ? (req.body.roleLocked ? 1 : 0) : (req.body.role !== undefined && role !== u.role ? 1 : u.role_locked);
    // Validate everything first, then save in one transaction (no partial save on errors)
    let newHash = null;
    let approvedNow = false;
    // Name and address only for local accounts (AD/SSO: come from there, email contacts: from mails)
    let email;
    if ((req.body.displayName !== undefined || req.body.email !== undefined) && u.source !== 'local') throw new HttpError(400, 'err.managedExternally');
    if (req.body.email !== undefined) email = normalizeEmail(str(req.body.email, 254));
    if (req.body.password) {
      if (u.source !== 'local') throw new HttpError(400, 'err.badRequest');
      const pw = str(req.body.password, 1024);
      if (pw.length < 10) throw new HttpError(400, 'err.passwordWeak');
      newHash = hashPassword(pw);
    }
    db.transaction(() => {
      // Activating or deactivating ends the wait for approval of a self-registered account
      if (req.body.active !== undefined) db.prepare('UPDATE users SET approval_pending=0 WHERE id=?').run(u.id);
      if (u.approval_pending && active) approvedNow = true;
      db.prepare('UPDATE users SET role=?, active=?, role_locked=?, display_name=? WHERE id=?').run(
        role, active, roleLocked,
        req.body.displayName !== undefined ? str(req.body.displayName, 120).trim() || u.display_name : u.display_name,
        u.id,
      );
      if (email !== undefined) users.setEmail(u.id, email);
      if (newHash) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, u.id);
    })();
    if (newHash || !active) sessions.destroyAllForUser(u.id);
    if (req.body.resetMfa) {
      mfa.adminReset(u.id);
      sessions.destroyAllForUser(u.id);
      log.info(`2FA of ${u.username} reset by ${req.user.username}`);
    }
    if (approvedNow) {
      log.info(`Self-registered account "${u.username}" approved by ${req.user.username}`);
      ctx.selfService.notifyApproved(users.byId(u.id));
    }
    res.json({ user: publicUser(users.byId(u.id)) });
  }));

  // ---------- Projects ----------
  r.get('/projects', (req, res) => {
    res.json({ projects: tickets.projects.list(req.query.all === '1' && isAgent(req.user)) });
  });
  r.post('/projects', requireRole('admin'), wrap(async (req, res) => {
    const p = tickets.projects.create({ key: req.body.key, name: req.body.name, description: req.body.description, leadId: int(req.body.leadId) });
    if (!settings.get('general.defaultProject')) settings.set('general.defaultProject', p.key);
    res.status(201).json({ project: p });
  }));
  r.patch('/projects/:id', requireRole('admin'), wrap(async (req, res) => {
    res.json({ project: tickets.projects.update(int(req.params.id), { name: req.body.name, description: req.body.description, leadId: req.body.leadId !== undefined ? int(req.body.leadId) : undefined, archived: req.body.archived }) });
  }));

  r.delete('/projects/:id', requireRole('admin'), wrap(async (req, res) => {
    const p = tickets.projects.get(int(req.params.id) || 0);
    if (!p) throw notFound();
    const body = req.body || {};
    // Tickets are never deleted: with tickets only together with moving them (otherwise archive)
    // First check whether deleting is allowed (like projects.remove), then back up – otherwise every rejection would leave a copy behind
    if (db.prepare('SELECT COUNT(*) n FROM projects WHERE id<>?').get(p.id).n === 0) throw new HttpError(400, 'err.lastProject');
    if (db.prepare('SELECT COUNT(*) n FROM tickets WHERE project_id=?').get(p.id).n > 0) {
      if (!body.moveTo) throw new HttpError(400, 'err.projectHasTickets');
      const target = tickets.projects.get(body.moveTo);
      if (!target || target.id === p.id) throw new HttpError(400, 'err.badRequest', 'moveTo');
      if (target.archived) throw new HttpError(400, 'err.projectArchived');
    }
    await backupDatabase(db, `vor-loeschen-${p.key}`);
    pruneBackups(settings.get('backup.keep'));
    const out = tickets.projects.remove(req.user, p.id, { moveTo: body.moveTo || null });
    // Repoint settings that refer to the project (to the target project or "default")
    for (const k of ['general.defaultProject', 'imap.project']) {
      if (String(settings.get(k)).toUpperCase() === p.key) settings.set(k, out.target || '');
    }
    log.info(`Project ${p.key} deleted by ${req.user.username}`, { moved: out.moved, target: out.target });
    res.json(out);
  }));

  // ---------- Saved filters / shared queues (agents) ----------
  const savedFilters = createSavedFilters(db, tickets);
  r.get('/filters', requireRole('agent'), (req, res) => res.json({ filters: savedFilters.list(req.user) }));
  r.post('/filters', requireRole('agent'), (req, res) => res.status(201).json({ filter: savedFilters.create(req.user, req.body || {}) }));
  r.post('/filters/order', requireRole('agent'), (req, res) => res.json({ filters: savedFilters.reorder(req.user, req.body?.ids, !!req.body?.shared) }));
  r.patch('/filters/:id', requireRole('agent'), (req, res) => res.json({ filter: savedFilters.update(req.user, req.params.id, req.body || {}) }));
  r.delete('/filters/:id', requireRole('agent'), (req, res) => res.json(savedFilters.remove(req.user, req.params.id)));

  // ---------- Components (per project) ----------
  const components = tickets.components;
  // Agents need the list for the ticket field and the filter; admins also see archived ones
  r.get('/projects/:id/components', requireRole('agent'), (req, res) => {
    res.json({ components: components.list(req.params.id, { includeArchived: req.query.all === '1' && req.user.role === 'admin' }) });
  });
  r.post('/projects/:id/components', requireRole('admin'), (req, res) => {
    const c = components.create(req.params.id, req.body || {});
    log.info(`Component "${c.name}" created by ${req.user.username}`);
    res.status(201).json({ component: c });
  });
  r.post('/projects/:id/components/order', requireRole('admin'), (req, res) => res.json({ components: components.reorder(req.params.id, req.body?.ids) }));
  r.post('/projects/:id/components/examples', requireRole('admin'), (req, res) => {
    const out = components.addExamples(req.params.id, req.body?.keys, req.body?.lang);
    log.info(`Example components taken over by ${req.user.username}`, { added: out.added.length, skipped: out.skipped.length });
    res.status(201).json(out);
  });
  r.post('/projects/:id/components/test', requireRole('admin'), (req, res) => res.json(components.test(req.params.id, req.body || {})));
  r.get('/components/examples', requireRole('admin'), (req, res) => res.json({ examples: components.examples() }));
  r.patch('/components/:id', requireRole('admin'), (req, res) => res.json({ component: components.update(req.params.id, req.body || {}) }));
  r.delete('/components/:id', requireRole('admin'), (req, res) => {
    const out = components.remove(req.params.id, req.user.id);
    log.info(`Component "${out.name}" deleted by ${req.user.username}`, { tickets: out.tickets });
    res.json(out);
  });

  // ---------- Tickets ----------
  r.get('/stats', requireRole('agent'), (req, res) => res.json(tickets.stats(req.user)));
  r.get('/queues', requireRole('agent'), (req, res) => {
    const project = req.query.project ? str(req.query.project, 20) : null;
    const counts = tickets.queueCounts(req.user, project);
    if (ctx.sla.enabled()) counts.slaRisk = ctx.sla.atRisk(project).length;
    counts.changes = db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.type='change' AND t.status<>'done' AND p.archived=0 ${project ? 'AND p.key=?' : ''}`).get(...(project ? [project.toUpperCase()] : [])).n;
    counts.approvals = ctx.approvals.pendingFor(req.user.id).length;
    counts.mentions = tickets.unseenMentionTickets(req.user).size;
    counts.problems = db.prepare(`SELECT COUNT(*) n FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.type='problem' AND t.status<>'done' AND p.archived=0 ${project ? 'AND p.key=?' : ''}`).get(...(project ? [project.toUpperCase()] : [])).n;
    res.json({ counts });
  });
  r.get('/summary', requireRole('agent'), (req, res) => res.json(tickets.summary(req.user, req.query.project ? str(req.query.project, 20) : null)));

  r.get('/tickets', (req, res) => {
    let list = tickets.list(req.user, req.query);
    const searchTerms = list.searchTerms;
    // SLA state for agents; filter "SLA at risk"
    if (isAgent(req.user) && ctx.sla.enabled()) {
      list = list.map((tk) => ({ ...tk, sla: ctx.sla.worst(ctx.sla.forRow(tickets.rawById(tk.id))) }));
      if (req.query.sla === 'risk') list = list.filter((tk) => ['warning', 'breached'].includes(tk.sla?.state));
    }
    // My open approvals
    if (req.query.approval === 'mine') {
      const ids = new Set(ctx.approvals.pendingFor(req.user.id));
      list = list.filter((tk) => ids.has(tk.id));
    }
    // Tickets with mentions of me that I have not opened since
    if (isAgent(req.user) && list.length) {
      const unseen = tickets.unseenMentionTickets(req.user, list.map((tk) => tk.id));
      if (unseen.size) list = list.map((tk) => (unseen.has(tk.id) ? { ...tk, mentionUnseen: true } : tk));
    }
    res.json({ tickets: list, ...(searchTerms ? { searchTerms } : {}) });
  });

  r.post('/tickets', wrap(async (req, res) => {
    if (!isAgent(req.user) && !settings.get('general.allowSelfService')) throw new HttpError(403, 'err.selfServiceOff');
    const projectId = req.body.projectId || settings.get('general.defaultProject') || undefined;
    // Agents may enter the ticket for someone else (reporter); users only for themselves
    let opts = {};
    if (req.body.reporter !== undefined && req.body.reporter !== null) {
      if (!isAgent(req.user)) throw forbidden();
      const rep = await reporterFrom(req.body.reporter);
      if (rep.id !== req.user.id) opts = { reporterId: rep.id, notifyReporter: req.body.notifyReporter !== false };
    }
    const t = tickets.create(req.user, { ...req.body, projectId }, opts);
    // Users get their own view (no internal fields such as the component or agents' addresses)
    res.status(201).json({ ticket: isAgent(req.user) ? t : tickets.ticketOut(tickets.rawById(t.id), false, req.user.id) });
  }));

  /**
   * Bulk actions (agents): the normal logic for each ticket (permissions, history, notifications).
   * changes: { status, assigneeId, priority, projectId } · comment: reply to reporter/participants
   * (placeholders replaced per ticket), or an internal note with internal: true ·
   * link: { kind, reverse, target } links every ticket with the target (reverse: target → ticket,
   * e.g. "is caused by IT-42"; an existing link counts as done). Order per ticket: link, comment,
   * changes. Tickets are never deleted. Errors on single tickets do not abort the rest.
   */
  r.post('/tickets/bulk', requireRole('agent'), wrap(async (req, res) => {
    const keys = [...new Set((Array.isArray(req.body.keys) ? req.body.keys : []).map((k) => str(k, 30)).filter(Boolean))];
    if (!keys.length || keys.length > MAX_BULK) throw new HttpError(400, 'err.badRequest', 'keys');
    const changes = {};
    const c = req.body.changes || {};
    for (const k of ['status', 'assigneeId', 'priority', 'projectId']) if (c[k] !== undefined) changes[k] = c[k];
    const comment = str(req.body.comment, 100000).trim();
    const internal = !!req.body.internal;
    // Tickets are never deleted (records) – not even via bulk action
    if (req.body.delete) throw new HttpError(400, 'err.ticketDeleteDisabled');
    let link = null;
    if (req.body.link) {
      const kind = str(req.body.link.kind, 20);
      if (!LINK_KINDS.includes(kind)) throw new HttpError(400, 'err.badRequest', 'link.kind');
      // Check the target once (exists, visible) – then every ticket is linked with it
      let target;
      try { target = tickets.ticketOut(tickets.load(req.user, str(req.body.link.target, 30).trim().toUpperCase())); } catch { throw new HttpError(400, 'err.linkTarget'); }
      link = { kind, reverse: !!req.body.link.reverse, target: target.key };
    }
    if (!comment && !link && !Object.keys(changes).length) throw new HttpError(400, 'err.badRequest');
    const lang = normalizeLang(req.user?.language || langFromHeader(req.get('accept-language')));
    const ok = [];
    const failed = [];
    for (const key of keys) {
      try {
        let current = key;
        if (link) {
          try {
            if (link.reverse) ctx.links.add(req.user, link.target, { kind: link.kind, target: key });
            else ctx.links.add(req.user, key, { kind: link.kind, target: link.target });
          } catch (e) {
            // Already linked (in either direction): nothing to do, the rest still applies
            if (!(e instanceof HttpError && e.code === 'err.linkExists')) throw e;
          }
        }
        if (comment) {
          const row = tickets.load(req.user, key);
          const tk = tickets.ticketOut(row);
          tickets.addComment(req.user, row.id, { body: fillPlaceholders(comment, tk, { displayName: req.user.display_name }), internal });
        }
        // With a reply no second "Resolved" mail – the reply already informs (an internal note does not)
        if (Object.keys(changes).length) current = tickets.update(req.user, key, changes, { quietResolved: !!comment && !internal }).key;
        ok.push(current);
      } catch (e) {
        failed.push({ key, error: e instanceof HttpError ? (hasKey(e.code) ? t(lang, e.code) : e.code) : 'error' });
      }
    }
    log.info(`Bulk action by ${req.user.username}: ${ok.length} ok, ${failed.length} failed`, { changes: Object.keys(changes), comment: comment ? (internal ? 'internal' : 'reply') : false, link: link ? `${link.reverse ? 'in' : 'out'}:${link.kind}` : false });
    res.json({ ok, failed });
  }));

  r.get('/tickets/:key', (req, res) => res.json({ ticket: tickets.detail(req.user, req.params.key) }));
  // People for @-mentions (agents; internal note → agents only)
  r.get('/tickets/:key/mention-candidates', requireRole('agent'), (req, res) => res.json({
    people: tickets.mentionCandidates(req.user, req.params.key, { q: str(req.query.q, 60), internal: req.query.internal === '1' }),
  }));

  // AI assistance (agents only, src/ai.js): suggestions only – nothing is sent or changed automatically
  r.get('/tickets/:key/ai/summary', requireRole('agent'), (req, res) => res.json({ summary: ctx.ai.storedSummary(req.user, req.params.key) }));
  r.post('/tickets/:key/ai/summary', requireRole('agent'), wrap(async (req, res) => res.json({ summary: await ctx.ai.summarize(req.user, req.params.key) })));
  r.post('/tickets/:key/ai/reply', requireRole('agent'), wrap(async (req, res) => res.json(await ctx.ai.suggestReply(req.user, req.params.key, req.body.draft))));
  // AI component suggestion: accept or dismiss
  r.post('/tickets/:key/component-suggestion/accept', requireRole('agent'), (req, res) => res.json({ ticket: ctx.aiClassifier.accept(req.user, req.params.key) }));
  r.post('/tickets/:key/component-suggestion/dismiss', requireRole('agent'), (req, res) => res.json(ctx.aiClassifier.dismiss(req.user, req.params.key)));
  r.post('/ai/rewrite', requireRole('agent'), wrap(async (req, res) => res.json(await ctx.ai.rewrite(req.user, req.body.text, str(req.body.mode, 20)))));
  // Knowledge articles: help writing (keeps the markup) and a draft from a ticket
  r.post('/ai/kb', requireRole('agent'), wrap(async (req, res) => res.json(await ctx.ai.kbAssist(req.user, {
    mode: str(req.body?.mode, 20), text: req.body?.text, title: req.body?.title, categories: req.body?.categories,
  }))));
  r.post('/tickets/:key/ai/kb-draft', requireRole('agent'), wrap(async (req, res) => res.json(await ctx.ai.kbDraft(req.user, req.params.key))));

  // Formatted version of an HTML mail – only in the isolated frame: no script, no foreign content
  r.get('/tickets/:key/mail-html', (req, res) => {
    const m = tickets.mailHtml(req.user, req.params.key, req.query.comment ? int(req.query.comment) || -1 : null);
    const lang = normalizeLang(req.user?.language || langFromHeader(req.get('accept-language')));
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('html').send(viewerDocument(m.html, { blocked: m.blocked, blockedText: t(lang, 'mail.blockedImages', { n: m.blocked }), quoteText: t(lang, 'mail.showQuoted'), lang }));
  });

  r.put('/tickets/:key/reporter', requireRole('agent'), wrap(async (req, res) => {
    tickets.load(req.user, req.params.key); // check access before any AD lookup
    const target = await reporterFrom(req.body.reporter);
    res.json({ ticket: tickets.setReporter(req.user, req.params.key, target, { notify: req.body.notify !== false }) });
  }));

  r.patch('/tickets/:key', wrap(async (req, res) => {
    res.json({ ticket: tickets.update(req.user, req.params.key, req.body) });
  }));

  // Tickets are never deleted (records). Resolve instead of delete; spam via sender rule "ignore".
  r.delete('/tickets/:key', (_req, _res) => { throw new HttpError(405, 'err.ticketDeleteDisabled'); });

  // ---------- Reports (all agents) ----------
  r.get('/reports', requireRole('agent'), (req, res) => res.json(reports.report(req.query)));

  // ---------- Canned responses (agents only) ----------
  r.get('/canned', requireRole('agent'), (req, res) => res.json({ responses: canned.list(req.user) }));
  r.post('/canned', requireRole('agent'), wrap(async (req, res) => res.status(201).json({ response: canned.create(req.user, req.body || {}) })));
  r.patch('/canned/:id', requireRole('agent'), wrap(async (req, res) => res.json({ response: canned.update(req.user, req.params.id, req.body || {}) })));
  r.delete('/canned/:id', requireRole('agent'), (req, res) => { canned.remove(req.user, req.params.id); res.json({ ok: true }); });

  // ---------- News ----------
  r.get('/news', (req, res) => res.json({ entries: ctx.news.list(req.user), version: ctx.news.version }));
  r.post('/news/seen', (req, res) => { ctx.news.markSeen(req.user); res.json({ ok: true }); });

  r.get('/tickets/:key/description-versions/:id', (req, res) => {
    res.json(tickets.descriptionVersion(req.user, req.params.key, req.params.id));
  });

  // ---------- Request participants ----------
  r.post('/tickets/:key/participants', wrap(async (req, res) => {
    let { userId, email } = req.body || {};
    const adId = typeof req.body?.adId === 'string' ? req.body.adId : '';
    if (adId || (email && typeof email === 'string')) {
      tickets.load(req.user, req.params.key); // check access first, then look up in AD
      if (adId && (!isAgent(req.user) || !adPeopleOn())) throw forbidden();
      if (adId && !/^[0-9a-f]{32}$/i.test(adId)) throw new HttpError(400, 'err.badRequest', 'adId');
      if (adId) userId = (await personFromAd({ adId })).id;
      else if (isAgent(req.user) && adPeopleOn()) {
        const e = normalizeEmail(email);
        const existing = users.byEmail(e);
        // Only look up if there is no real account with this address yet
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && (!existing || existing.source === 'email')) {
          const u = await personFromAd({ email: e });
          if (u) { userId = u.id; email = undefined; }
        }
      }
    }
    const out = tickets.addParticipant(req.user, req.params.key, { userId, email });
    res.status(out.added ? 201 : 200).json({ participants: out.participants });
  }));

  r.delete('/tickets/:key/participants/:userId', (req, res) => {
    res.json(tickets.removeParticipant(req.user, req.params.key, req.params.userId));
  });

  r.post('/tickets/:key/comments', wrap(async (req, res) => {
    // attachmentIds: own drafts of this ticket (uploaded with draft=file/1) that belong to this comment
    const ids = Array.isArray(req.body.attachmentIds) ? req.body.attachmentIds.slice(0, 20).map((x) => int(x)).filter(Boolean) : [];
    const c = tickets.addComment(req.user, req.params.key, { body: req.body.body, internal: !!req.body.internal, attachmentIds: ids, format: req.body.format === 'md' ? 'md' : 'text' });
    res.status(201).json({ comment: c });
  }));

  r.post('/tickets/:key/attachments', (req, res, next) => {
    upload.array('files', 10)(req, res, (err) => {
      if (err) {
        for (const f of req.files || []) fs.rmSync(f.path, { force: true });
        if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'err.fileTooLarge'));
        if (err.name === 'MulterError') return next(new HttpError(400, 'err.badRequest', err.code));
        return next(err);
      }
      try {
        const row = tickets.load(req.user, req.params.key);
        // draft=1: pasted image – invisible to others until the text with the image is saved.
        // draft=file: any file for a reply – invisible until a comment claims it via attachmentIds
        // (an internal note keeps it internal).
        const draft = req.body?.draft === '1' || req.body?.draft === 'file';
        // At most MAX_DRAFTS unsent uploads per person and ticket (they are removed after a day anyway)
        if (draft && tickets.pendingDrafts(row.id, req.user.id) + (req.files || []).length > MAX_DRAFTS) {
          for (const f of req.files || []) fs.rmSync(f.path, { force: true });
          throw new HttpError(400, 'err.tooManyDrafts', String(MAX_DRAFTS));
        }
        if (req.body?.draft === '1' && (req.files || []).some((f) => !/^image\/(png|jpeg|gif|webp)$/.test(f.mimetype))) {
          for (const f of req.files || []) fs.rmSync(f.path, { force: true });
          throw new HttpError(400, 'err.badRequest', 'draft');
        }
        const ids = (req.files || []).map((f) => tickets.addAttachment(row.id, {
          // Multer returns file names as latin1 – convert to UTF-8
          filename: Buffer.from(f.originalname, 'latin1').toString('utf8'), mime: f.mimetype, tmpPath: f.path, size: f.size,
        }, req.user.id, null, { draft }));
        res.status(201).json({ ids });
      } catch (e) {
        for (const f of req.files || []) fs.rmSync(f.path, { force: true });
        next(e);
      }
    });
  });

  r.get('/attachments/:id', (req, res) => {
    const a = tickets.attachmentFile(req.user, int(req.params.id));
    if (!fs.existsSync(a.path)) throw notFound();
    const inlineOk = /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
    res.setHeader('Content-Type', inlineOk ? a.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inlineOk && req.query.download !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    // Ticket files are never kept in the browser cache (shared devices)
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(a.path)
      .on('error', (e) => { log.warn('Attachment not readable', { error: e.message }); if (!res.headersSent) res.status(404); res.end(); })
      .pipe(res);
  });

  // Unsent upload of one's own (draft) – removed chip or discarded reply in the mobile UI
  r.delete('/attachments/:id/draft', (req, res) => {
    tickets.discardDraft(req.user, int(req.params.id));
    res.json({ ok: true });
  });

  r.delete('/attachments/:id', (req, res) => {
    tickets.deleteAttachment(req.user, int(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Administration ----------
  const admin = express.Router();
  admin.use(requireRole('admin'));

  // Own internet connection: currently resolved addresses (for checking in the UI)
  admin.get('/mfa/network', wrap(async (req, res) => res.json({
    own: await policy.ownAddresses(), levels: policy.levels(),
    trustProxy: String(config.trustProxy), proxyWarning: policy.proxyWarning(),
  })));

  admin.get('/settings', (req, res) => res.json({ settings: settings.publicView(), redirectUri: oidcAuth.redirectUri(), languages: LANGUAGES }));

  admin.put('/settings', wrap(async (req, res) => {
    const incoming = req.body?.settings || {};
    for (const k of Object.keys(incoming)) if (!(k in DEFAULTS)) delete incoming[k];
    for (const k of ['mfa.external', 'mfa.internal']) {
      if (incoming[k] !== undefined && !MFA_LEVELS.includes(incoming[k])) throw new HttpError(400, 'err.badRequest', k);
    }
    if (incoming['ldap.caPem'] !== undefined && incoming['ldap.caPem']) {
      incoming['ldap.caPem'] = ldap.mergePem('', incoming['ldap.caPem']);
      incoming['ldap.caInfo'] = JSON.stringify(ldap.splitPem(incoming['ldap.caPem']).map((p) => { const { pem, ...rest } = ldap.describeCert(p); return rest; }));
    }
    delete incoming['brand.logo']; // only via the dedicated upload
    if (incoming['brand.color'] !== undefined && incoming['brand.color'] !== '' && !isHexColor(incoming['brand.color'])) throw new HttpError(400, 'err.brandColor');
    if (incoming['brand.header'] !== undefined && !['light', 'color'].includes(incoming['brand.header'])) throw new HttpError(400, 'err.badRequest', 'brand.header');
    if (incoming['backup.keep'] !== undefined) incoming['backup.keep'] = clampBackupKeep(incoming['backup.keep']);
    if (incoming['register.passwordReset'] !== undefined && !RESET_MODES.includes(incoming['register.passwordReset'])) throw new HttpError(400, 'err.badRequest', 'register.passwordReset');
    for (const k of ['session.idleMinutes', 'session.adminIdleMinutes', 'session.externalIdleMinutes']) {
      if (incoming[k] !== undefined) incoming[k] = idleMinutes(incoming[k]);
    }
    if (incoming['ai.reasoning'] !== undefined && !REASONING.includes(incoming['ai.reasoning'])) throw new HttpError(400, 'err.badRequest', 'ai.reasoning');
    if (incoming['ai.classifyMode'] !== undefined && !CLASSIFY_MODES.includes(incoming['ai.classifyMode'])) throw new HttpError(400, 'err.badRequest', 'ai.classifyMode');
    for (const k of ['ai.summary', 'ai.reply', 'ai.rewrite', 'ai.classify', 'ai.kb']) if (incoming[k] !== undefined) incoming[k] = !!incoming[k];
    if (incoming['ai.baseUrl'] !== undefined && String(incoming['ai.baseUrl']).trim()) {
      let u = null;
      try { u = new URL(String(incoming['ai.baseUrl']).trim()); } catch { /* checked below */ }
      if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) throw new HttpError(400, 'err.badRequest', 'ai.baseUrl');
      incoming['ai.baseUrl'] = normalizeBaseUrl(incoming['ai.baseUrl']);
    }
    if (incoming['register.domains'] !== undefined) incoming['register.domains'] = parseDomains(incoming['register.domains']).join('\n');
    settings.setMany(incoming);
    if (incoming['backup.keep'] !== undefined) pruneBackups(incoming['backup.keep']);
    if (Object.keys(incoming).some((k) => k.startsWith('oidc.'))) oidcAuth.resetOidcCache();
    if (Object.keys(incoming).some((k) => k.startsWith('imap.'))) poller.start();
    if (Object.keys(incoming).some((k) => k.startsWith('ldap.'))) ctx.ldapCertWarning = null;
    if (incoming['mfa.ownAddresses'] !== undefined) await policy.refreshOwn().catch(() => {});
    log.info(`Settings changed by ${req.user.username}`, { keys: Object.keys(incoming) });
    res.json({ settings: settings.publicView() });
  }));

  const mergedGroup = (prefix, form) => settings.mergedGroup(prefix, form);

  admin.post('/ldap/fetch-cert', wrap(async (req, res) => {
    const cfg = mergedGroup('ldap', req.body.settings);
    if (!cfg.host) throw new HttpError(400, 'err.badRequest', 'host');
    try {
      const r1 = await ldap.fetchCertificateChain({ host: cfg.host, port: cfg.port, security: cfg.security, timeoutMs: cfg.timeoutMs });
      res.json({ ok: true, chain: r1.chain.map(({ pem, ...rest }) => rest), pem: r1.pem, protocol: r1.protocol });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  admin.post('/ldap/test', wrap(async (req, res) => {
    const cfg = mergedGroup('ldap', req.body.settings);
    const result = await ldap.testConnection(cfg, { username: str(req.body.username, 256), password: str(req.body.password, 1024) });
    res.json(result);
  }));

  admin.post('/oidc/test', wrap(async (req, res) => {
    const cfg = mergedGroup('oidc', req.body.settings);
    try {
      const issuerUrl = new URL(cfg.issuer);
    if (!/^https?:$/.test(issuerUrl.protocol)) throw new HttpError(400, 'err.badRequest', 'issuer');
    const r1 = await fetch(new URL('.well-known/openid-configuration', cfg.issuer.endsWith('/') ? cfg.issuer : cfg.issuer + '/'), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!r1.ok) throw new Error(`HTTP ${r1.status}`);
      const meta = await r1.json();
      res.json({ ok: true, issuer: meta.issuer, authorization_endpoint: meta.authorization_endpoint, redirectUri: oidcAuth.redirectUri() });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  admin.post('/imap/test', wrap(async (req, res) => res.json(await testImap(mergedGroup('imap', req.body.settings)))));

  admin.get('/ai/stats', (req, res) => res.json({ classify: ctx.aiClassifier.stats() }));
  admin.post('/ai/test', wrap(async (req, res) => {
    const cfg = mergedGroup('ai', req.body.settings);
    try {
      const u = new URL(cfg.baseUrl);
      if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'err.badRequest', 'baseUrl');
      res.json(await ctx.ai.test({
        baseUrl: normalizeBaseUrl(cfg.baseUrl), model: String(cfg.model || '').trim(), apiKey: cfg.apiKey || '',
        reasoning: REASONING.includes(cfg.reasoning) ? cfg.reasoning : 'low', timeoutMs: 60000,
      }));
    } catch (e) {
      res.json({ ok: false, error: e instanceof HttpError ? t(normalizeLang(req.user.language), e.code, { detail: e.detail ?? '' }) : e.message });
    }
  }));

  // Installed models of the AI server (form values; the stored key only for its own address)
  admin.post('/ai/models', wrap(async (req, res) => {
    const cfg = mergedGroup('ai', req.body.settings);
    try {
      res.json({ ok: true, ...(await listModels({ baseUrl: String(cfg.baseUrl || ''), apiKey: cfg.apiKey || '' })) });
    } catch (e) {
      res.json({ ok: false, error: e instanceof HttpError ? t(normalizeLang(req.user.language), e.code, { detail: e.detail ?? '' }) : e.message });
    }
  }));

  admin.post('/imap/poll', wrap(async (req, res) => {
    const result = await poller.pollOnce();
    res.json({ result, status: poller.status() });
  }));

  admin.post('/smtp/test', wrap(async (req, res) => {
    const cfg = mergedGroup('smtp', req.body.settings);
    const to = str(req.body.to, 254) || req.user.email;
    if (!to) throw new HttpError(400, 'err.badRequest', 'to');
    try {
      await mailer.test(cfg, to, normalizeLang(req.user.language, settings.get('general.defaultLanguage')));
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  // Upload (data URL, PNG or validated SVG) or remove the logo
  admin.put('/brand/logo', wrap(async (req, res) => {
    settings.set('brand.logo', saveLogo(req.body.data));
    log.info(`Logo changed by ${req.user.username}`);
    res.json({ logo: settings.get('brand.logo') });
  }));
  admin.delete('/brand/logo', (req, res) => {
    removeLogo();
    settings.set('brand.logo', '');
    log.info(`Logo removed by ${req.user.username}`);
    res.json({ logo: '' });
  });

  admin.get('/system', (req, res) => {
    const backups = listBackups().map(({ name, kind, size, time }) => ({ name, kind, size, time: new Date(time).toISOString() }));
    res.json({
      version: config.version,
      node: process.version,
      baseUrl: config.baseUrl,
      composeVersion: config.composeVersion,
      composeVersionExpected: COMPOSE_VERSION,
      dbSize: fs.statSync(paths.db).size,
      counts: {
        users: db.prepare("SELECT COUNT(*) n FROM users WHERE source<>'email'").get().n,
        contacts: db.prepare("SELECT COUNT(*) n FROM users WHERE source='email'").get().n,
        tickets: db.prepare('SELECT COUNT(*) n FROM tickets').get().n,
      },
      imap: poller.status(),
      backups,
      backupsSize: backups.reduce((n, b) => n + b.size, 0),
      backupKeep: settings.get('backup.keep'),
      warnings: adminWarnings(),
    });
  });

  admin.post('/backup', wrap(async (req, res) => {
    const file = await backupDatabase(db, 'manuell');
    pruneBackups(settings.get('backup.keep'));
    res.json({ ok: true, file: file.split('/').pop() });
  }));

  admin.delete('/backups/:name', (req, res) => {
    if (!deleteBackup(req.params.name)) throw new HttpError(404, 'err.notFound');
    log.info(`Backup ${req.params.name} deleted by ${req.user.username}`);
    res.json({ ok: true });
  });

  // ---------- Import from Jira ----------
  /** Validate connection data; it is never stored, only kept in memory for the running import */
  function jiraConn(body) {
    const c = body?.connection || {};
    const type = oneOf(c.type, ['cloud', 'server'], 'cloud');
    const baseUrl = str(c.baseUrl, 500).trim();
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new HttpError(400, 'err.badRequest', 'baseUrl');
    return {
      type, baseUrl,
      email: str(c.email, 254).trim(), token: str(c.token, 2000).trim(),
      username: str(c.username, 254).trim(), password: str(c.password, 1024),
      verifyTls: c.verifyTls !== false, caPem: str(c.caPem, 20000),
    };
  }
  const jiraFail = (res, e) => {
    if (e instanceof HttpError) throw e;
    log.warn('Jira import', { error: e.message });
    res.json({ ok: false, error: e.message });
  };

  admin.post('/import/jira/connect', wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await jiraImporter.connect(jiraConn(req.body))) }); } catch (e) { jiraFail(res, e); }
  }));
  admin.post('/import/jira/inspect', wrap(async (req, res) => {
    const keys = (Array.isArray(req.body.projects) ? req.body.projects : []).map((k) => str(k, 50)).slice(0, 200);
    try { res.json({ ok: true, ...(await jiraImporter.inspect(jiraConn(req.body), keys)) }); } catch (e) { jiraFail(res, e); }
  }));
  admin.post('/import/jira/start', wrap(async (req, res) => {
    const conn = jiraConn(req.body);
    // Importing again overwrites changed tickets → back up first (after checking that it starts at all)
    if (jiraImporter.status()?.state === 'running') throw new HttpError(409, 'err.importRunning');
    if (!Array.isArray(req.body.projects) || !req.body.projects.length) throw new HttpError(400, 'err.badRequest', 'projects');
    await backupDatabase(db, 'vor-import');
    pruneBackups(settings.get('backup.keep'));
    const job = jiraImporter.start(conn, {
      projects: req.body.projects, statusMap: req.body.statusMap || {}, typeMap: req.body.typeMap || {}, options: req.body.options || {},
    }, req.user.id);
    log.info(`Jira import started by ${req.user.username}`, { projects: job.projects.map((p) => p.key) });
    res.status(202).json({ job });
  }));
  // Blocked recipients (after non-delivery reports)
  admin.get('/mail/suppressions', (req, res) => res.json({ suppressions: suppressions.list() }));
  admin.delete('/mail/suppressions/:address', (req, res) => { suppressions.remove(req.params.address); res.json({ suppressions: suppressions.list() }); });

  admin.get('/import/status', (req, res) => res.json({ job: ctx.importer.status() }));
  admin.post('/import/cancel', (req, res) => res.json({ job: ctx.importer.cancel() }));

  // ---------- Import from Zammad, Znuny/OTRS, GLPI, Zendesk, Freshdesk and CSV files ----------
  // Connection data is never stored; an uploaded CSV file stays in memory only (latest one, 2 hours)
  let csvFile = null;
  const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV_BYTES, files: 1 } });
  const decodeText = (buf) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
  };
  const tlsConn = (c) => ({ verifyTls: c.verifyTls !== false, caPem: str(c.caPem, 20000) });
  const baseUrlOf = (c) => {
    const baseUrl = str(c.baseUrl, 500).trim();
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new HttpError(400, 'err.badRequest', 'baseUrl');
    return baseUrl;
  };
  function adapterFor(source, body) {
    const c = body?.connection || {};
    if (source === 'zammad') return zammadAdapter({ baseUrl: baseUrlOf(c), token: str(c.token, 2000).trim(), username: str(c.username, 254).trim(), password: str(c.password, 1024), ...tlsConn(c) });
    if (source === 'znuny') return znunyAdapter({ baseUrl: baseUrlOf(c), username: str(c.username, 254).trim(), password: str(c.password, 1024), ...tlsConn(c) });
    if (source === 'glpi') return glpiAdapter({ baseUrl: baseUrlOf(c), token: str(c.token, 2000).trim(), appToken: str(c.appToken, 2000).trim(), username: str(c.username, 254).trim(), password: str(c.password, 1024), ...tlsConn(c) });
    if (source === 'zendesk') return zendeskAdapter({ baseUrl: baseUrlOf(c), email: str(c.email, 254).trim(), token: str(c.token, 2000).trim(), ...tlsConn(c) });
    if (source === 'freshdesk') return freshdeskAdapter({ baseUrl: baseUrlOf(c), token: str(c.token, 2000).trim(), ...tlsConn(c) });
    if (source === 'csv') {
      if (!csvFile || csvFile.id !== str(c.uploadId, 64) || Date.now() - csvFile.at > 2 * 3600_000) throw new HttpError(400, 'err.importFileGone');
      const columns = Object.fromEntries(Object.entries(c.columns && typeof c.columns === 'object' ? c.columns : {}).map(([k, v]) => [str(k, 40), str(v, 200)]).filter(([, v]) => v));
      return csvAdapter({ text: csvFile.text, name: str(c.name, 60) || csvFile.name, columns });
    }
    throw notFound();
  }
  const SOURCES = ['zammad', 'znuny', 'glpi', 'zendesk', 'freshdesk', 'csv'];
  const sourceParam = (req) => { if (!SOURCES.includes(req.params.source)) throw notFound(); return req.params.source; };
  const importFail = (res, e) => {
    if (e instanceof HttpError) throw e;
    log.warn('Import', { error: e.message });
    res.json({ ok: false, error: e.message });
  };

  admin.post('/import/csv/upload', (req, res, next) => csvUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'err.fileTooLarge'));
    return next(new HttpError(400, 'err.badRequest', err.code));
  }), (req, res) => {
    if (!req.file) throw new HttpError(400, 'err.badRequest', 'file');
    const text = decodeText(req.file.buffer);
    let parsed;
    try { parsed = readCsv(text); } catch (e) { return res.json({ ok: false, error: e.message }); }
    const name = String(req.file.originalname || 'CSV').slice(0, 200).replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'CSV';
    csvFile = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), text, name, at: Date.now() };
    res.json({ ok: true, uploadId: csvFile.id, name, headers: parsed.headers, rows: parsed.records.length, suggested: suggestColumns(parsed.headers), preview: parsed.records.slice(0, 3), fields: Object.keys(CSV_FIELDS) });
  });
  admin.post('/import/:source/connect', wrap(async (req, res) => {
    const source = sourceParam(req);
    try { res.json({ ok: true, ...(await ctx.importer.connect(adapterFor(source, req.body), { type: source })) }); } catch (e) { importFail(res, e); }
  }));
  admin.post('/import/:source/inspect', wrap(async (req, res) => {
    const source = sourceParam(req);
    const keys = (Array.isArray(req.body.projects) ? req.body.projects : []).map((k) => str(k, 200)).slice(0, 500);
    try { res.json({ ok: true, ...(await ctx.importer.inspect(adapterFor(source, req.body), keys)) }); } catch (e) { importFail(res, e); }
  }));
  admin.post('/import/:source/start', wrap(async (req, res) => {
    const source = sourceParam(req);
    const adapter = adapterFor(source, req.body);
    if (ctx.importer.running()) throw new HttpError(409, 'err.importRunning');
    if (!Array.isArray(req.body.projects) || !req.body.projects.length) throw new HttpError(400, 'err.badRequest', 'projects');
    await backupDatabase(db, 'vor-import');
    pruneBackups(settings.get('backup.keep'));
    const job = ctx.importer.start(adapter, {
      projects: req.body.projects, statusMap: req.body.statusMap || {}, typeMap: req.body.typeMap || {}, options: req.body.options || {},
    }, req.user.id);
    log.info(`Import (${source}) started by ${req.user.username}`, { projects: job.projects.map((p) => p.key) });
    res.status(202).json({ job });
  }));

  r.use('/admin', admin);
  return r;
}
