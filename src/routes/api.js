// REST-API für die Oberfläche.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, paths, COMPOSE_VERSION } from '../config.js';
import { HttpError, notFound, forbidden, str, oneOf, int } from '../lib/http.js';
import { verifyPassword, hashPassword, safeEqual } from '../lib/crypto.js';
import { requireAuth, requireRole, isAgent } from '../auth/session.js';
import { publicUser, userRef, roleFromGroups, normalizeEmail } from '../users.js';
import * as ldap from '../auth/ldap.js';
import * as oidcAuth from '../auth/oidc.js';
import { parseNetworks } from '../auth/network.js';
import { testImap } from '../mail/imap.js';
import { normalizeLang, LANGUAGES } from '../i18n.js';
import { DEFAULTS } from '../settings.js';
import { backupDatabase } from '../db.js';
import { log } from '../lib/log.js';

const DUMMY_HASH = hashPassword('helfi-dummy-kennwort');

export function createApi(ctx) {
  const { db, settings, sessions, users, tickets, mailer, poller, limiter, setup, jiraImporter, policy, mfa, canned, reports, suppressions } = ctx;
  const r = express.Router();
  // Zwischenablage im Datenordner: gleiches Dateisystem wie die Anhänge (kein EXDEV im Container)
  const uploadTmp = path.join(paths.attachments, '.tmp');
  // Reste abgebrochener Uploads beim Start entfernen
  fs.rmSync(uploadTmp, { recursive: true, force: true });
  fs.mkdirSync(uploadTmp, { recursive: true });
  const upload = multer({ dest: uploadTmp, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- Öffentlich ----------
  r.get('/bootstrap', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    res.json({
      app: { title: settings.get('general.title'), version: config.version },
      setupRequired: userCount === 0,
      user: req.user ? publicUser(req.user) : null,
      auth: {
        ldap: settings.get('ldap.enabled'),
        oidc: settings.get('oidc.enabled') ? { label: settings.get('oidc.buttonLabel'), autoRedirect: settings.get('oidc.autoRedirect') } : null,
      },
      allowSelfService: settings.get('general.allowSelfService'),
      defaultLanguage: settings.get('general.defaultLanguage'),
      mfa: { mode: settings.get('mfa.mode'), internal: policy.isInternal(req), enabled: !!req.user?.totp_enabled },
      warnings: req.user?.role === 'admin' ? adminWarnings() : [],
    });
  });

  function adminWarnings() {
    const w = [];
    if (config.composeVersion && config.composeVersion < COMPOSE_VERSION) w.push({ code: 'composeOutdated', have: config.composeVersion, want: COMPOSE_VERSION });
    if (!config.composeVersion) w.push({ code: 'composeUnknown', want: COMPOSE_VERSION });
    if (ctx.ldapCertWarning) w.push(ctx.ldapCertWarning);
    const ps = poller.status();
    if (settings.get('imap.enabled') && ps.lastError) w.push({ code: 'imapError', message: ps.lastError });
    if (!config.baseUrl.startsWith('https://')) w.push({ code: 'noHttps' });
    if (policy.proxyWarning()) w.push({ code: 'proxyUntrusted' });
    const nets = parseNetworks(settings.get('mfa.internalNetworks'));
    if (nets.invalid.length) w.push({ code: 'networksInvalid', message: nets.invalid.join(', ') });
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
    log.info(`Ersteinrichtung abgeschlossen, lokaler Admin "${user.username}" angelegt`);
    // Der Einrichtungscode aus dem Protokoll gilt als zweiter Faktor
    sessions.create(res, user.id, req.ip, 'local', { mfa: true });
    res.json({ user: publicUser(user) });
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const username = str(req.body.username, 256).trim();
    const password = str(req.body.password, 1024);
    limiter.check(req.ip, username);
    if (!username || !password) throw new HttpError(401, 'err.invalidLogin');

    // 1. Lokales Konto (z. B. Notfall-Admin)
    const local = users.byName(username);
    // Gleiche Antwortzeit, ob es das lokale Konto gibt oder nicht (keine Namenserkennung über die Zeit)
    if (!(local && local.source === 'local' && local.password_hash)) verifyPassword(password, DUMMY_HASH);
    if (local && local.source === 'local' && local.password_hash) {
      if (!verifyPassword(password, local.password_hash)) { limiter.fail(req.ip, username); throw new HttpError(401, 'err.invalidLogin'); }
      if (!local.active) throw new HttpError(403, 'err.accountDisabled');
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
        log.error('AD-Anmeldung: Verbindungsproblem', { error: e.message });
        // Lokale Konten funktionieren weiterhin – darauf hinweisen
        throw new HttpError(503, 'err.ldapUnavailable');
      }
      if (!info) { limiter.fail(req.ip, username); throw new HttpError(401, 'err.invalidLogin'); }
      const role = roleFromGroups(info.groups, cfg);
      if (!info.groups.user && role !== 'admin' && role !== 'agent') throw new HttpError(403, 'err.notInGroup');
      const u = users.upsertExternal({ source: 'ldap', username: info.username, displayName: info.displayName, email: info.email, externalId: info.externalId, role });
      if (!u.active) throw new HttpError(403, 'err.accountDisabled');
      const r2 = mfa.afterPrimary(req, res, u, 'ldap');
      if (r2.done) limiter.success(req.ip, username);
      return res.json(r2.done ? { user: publicUser(u) } : { mfa: r2.step });
    }

    limiter.fail(req.ip, username);
    throw new HttpError(401, 'err.invalidLogin');
  }));

  // Zweiter Schritt der Anmeldung (ohne volle Sitzung, mit Cookie helfi_mfa)
  r.post('/auth/mfa/enroll', wrap(async (req, res) => res.json(await mfa.enrollInfo(req))));
  r.post('/auth/mfa', wrap(async (req, res) => {
    const out = mfa.verify(req, res, str(req.body.code, 40));
    res.json({ user: publicUser(out.user), recoveryCodes: out.recoveryCodes, usedRecovery: out.usedRecovery });
  }));

  r.post('/auth/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  // Ab hier nur angemeldet
  r.use(requireAuth);

  // ---------- Eigenes Konto ----------
  r.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/me', wrap(async (req, res) => {
    const u = req.user;
    // Erst alles prüfen, dann speichern
    let newHash = null;
    // Name und Adresse: nur lokale Konten (bei AD/SSO kommen sie von dort und würden überschrieben)
    let displayName = null;
    let email;
    if (req.body.displayName !== undefined || req.body.email !== undefined) {
      if (u.source !== 'local') throw new HttpError(400, 'err.managedExternally');
      if (req.body.displayName !== undefined) displayName = str(req.body.displayName, 120).trim() || null;
      if (req.body.email !== undefined) {
        email = normalizeEmail(str(req.body.email, 254));
        // Neue Adresse = neue Zuordnung eingehender Mails → aktuelles Kennwort verlangen
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
    db.transaction(() => {
      if (req.body.language !== undefined) {
        db.prepare('UPDATE users SET language=? WHERE id=?').run(req.body.language ? normalizeLang(req.body.language) : null, u.id);
      }
      if (displayName) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, u.id);
      if (email !== undefined) users.setEmail(u.id, email);
      if (newHash) {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(newHash, u.id);
        // Kennwort geändert → alle anderen (evtl. gestohlenen) Sitzungen beenden
        db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(u.id, req.sessionId);
      }
    })();
    res.json({ user: publicUser(users.byId(u.id)) });
  }));

  // ---------- Zwei-Faktor im Profil ----------
  r.get('/me/mfa', (req, res) => res.json(mfa.status(req, req.user)));
  r.post('/me/mfa/setup', wrap(async (req, res) => res.json(await mfa.startSetup(req, req.user))));
  r.post('/me/mfa/enable', wrap(async (req, res) => res.json({ recoveryCodes: mfa.confirmSetup(req, req.user, str(req.body.code, 40)) })));
  r.post('/me/mfa/disable', wrap(async (req, res) => { mfa.disable(req, req.user, str(req.body.code, 40)); res.json({ ok: true }); }));
  r.post('/me/mfa/recovery', wrap(async (req, res) => res.json({ recoveryCodes: mfa.newRecoveryCodes(req, req.user, str(req.body.code, 40)) })));

  // ---------- Benutzer ----------
  r.get('/users', requireRole('agent'), (req, res) => {
    const all = req.query.all === '1' && req.user.role === 'admin';
    const rows = all
      ? db.prepare('SELECT * FROM users ORDER BY active DESC, display_name').all()
      : db.prepare("SELECT * FROM users WHERE active=1 AND role IN ('agent','admin') ORDER BY display_name").all();
    res.json({ users: rows.map(all ? publicUser : userRef) });
  });

  // Personen suchen (z. B. Anfrage-Teilnehmer): nur Name/Anmeldename, ab 2 Zeichen, höchstens 10 Treffer.
  // Benutzer finden nur echte Konten (keine E-Mail-Kontakte); Adressen sehen nur Bearbeiter.
  r.get('/people', (req, res) => {
    const q = str(req.query.q, 100).trim();
    if (q.length < 2) return res.json({ people: [] });
    const agent = isAgent(req.user);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = db.prepare(`SELECT * FROM users WHERE active=1 ${agent ? '' : "AND source<>'email'"}
      AND (display_name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' ${agent ? "OR email LIKE ? ESCAPE '\\'" : ''})
      ORDER BY display_name LIMIT 10`).all(...(agent ? [like, like, like] : [like, like]));
    res.json({ people: rows.map((u) => ({ id: u.id, displayName: u.display_name, username: u.username, email: agent ? (u.email || '') : undefined })) });
  });

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
    // Erst alles prüfen, dann in einer Transaktion speichern (kein halbes Speichern bei Fehlern)
    let newHash = null;
    // Name und Adresse nur bei lokalen Konten (AD/SSO: kommen von dort, E-Mail-Kontakte: aus Mails)
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
      log.info(`2FA von ${u.username} zurückgesetzt durch ${req.user.username}`);
    }
    res.json({ user: publicUser(users.byId(u.id)) });
  }));

  // ---------- Projekte ----------
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
    // Erst prüfen (wirft bei fehlender Entscheidung), dann sichern, dann löschen
    if (!body.moveTo && !(body.deleteTickets && String(body.confirmKey || '').trim().toUpperCase() === p.key)
      && db.prepare('SELECT COUNT(*) n FROM tickets WHERE project_id=?').get(p.id).n > 0) throw new HttpError(400, 'err.projectHasTickets');
    await backupDatabase(db, `vor-loeschen-${p.key}`);
    const out = tickets.projects.remove(req.user, p.id, { moveTo: body.moveTo || null, deleteTickets: !!body.deleteTickets, confirmKey: body.confirmKey });
    // Einstellungen, die auf das Projekt zeigen, umstellen (auf das Zielprojekt bzw. „Standard“)
    for (const k of ['general.defaultProject', 'imap.project']) {
      if (String(settings.get(k)).toUpperCase() === p.key) settings.set(k, out.target || '');
    }
    log.info(`Projekt ${p.key} gelöscht von ${req.user.username}`, { moved: out.moved, deleted: out.deleted, target: out.target });
    res.json(out);
  }));

  // ---------- Tickets ----------
  r.get('/stats', requireRole('agent'), (req, res) => res.json(tickets.stats(req.user)));

  r.get('/tickets', (req, res) => {
    res.json({ tickets: tickets.list(req.user, req.query) });
  });

  r.post('/tickets', wrap(async (req, res) => {
    if (!isAgent(req.user) && !settings.get('general.allowSelfService')) throw new HttpError(403, 'err.selfServiceOff');
    const projectId = req.body.projectId || settings.get('general.defaultProject') || undefined;
    const t = tickets.create(req.user, { ...req.body, projectId });
    res.status(201).json({ ticket: t });
  }));

  r.get('/tickets/:key', (req, res) => res.json({ ticket: tickets.detail(req.user, req.params.key) }));

  r.patch('/tickets/:key', wrap(async (req, res) => {
    res.json({ ticket: tickets.update(req.user, req.params.key, req.body) });
  }));

  r.delete('/tickets/:key', requireRole('admin'), (req, res) => {
    tickets.remove(req.user, req.params.key);
    res.json({ ok: true });
  });

  // ---------- Berichte (alle Bearbeiter) ----------
  r.get('/reports', requireRole('agent'), (req, res) => res.json(reports.report(req.query)));

  // ---------- Antwortvorlagen (nur Bearbeiter) ----------
  r.get('/canned', requireRole('agent'), (req, res) => res.json({ responses: canned.list(req.user) }));
  r.post('/canned', requireRole('agent'), wrap(async (req, res) => res.status(201).json({ response: canned.create(req.user, req.body || {}) })));
  r.patch('/canned/:id', requireRole('agent'), wrap(async (req, res) => res.json({ response: canned.update(req.user, req.params.id, req.body || {}) })));
  r.delete('/canned/:id', requireRole('agent'), (req, res) => { canned.remove(req.user, req.params.id); res.json({ ok: true }); });

  // ---------- Anfrage-Teilnehmer ----------
  r.post('/tickets/:key/participants', wrap(async (req, res) => {
    const out = tickets.addParticipant(req.user, req.params.key, { userId: req.body.userId, email: req.body.email });
    res.status(out.added ? 201 : 200).json({ participants: out.participants });
  }));

  r.delete('/tickets/:key/participants/:userId', (req, res) => {
    res.json(tickets.removeParticipant(req.user, req.params.key, req.params.userId));
  });

  r.post('/tickets/:key/comments', wrap(async (req, res) => {
    const c = tickets.addComment(req.user, req.params.key, { body: req.body.body, internal: !!req.body.internal });
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
        const ids = (req.files || []).map((f) => tickets.addAttachment(row.id, {
          // Multer liefert Dateinamen als latin1 – in UTF-8 umwandeln
          filename: Buffer.from(f.originalname, 'latin1').toString('utf8'), mime: f.mimetype, tmpPath: f.path, size: f.size,
        }, req.user.id));
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
    fs.createReadStream(a.path)
      .on('error', (e) => { log.warn('Anhang nicht lesbar', { error: e.message }); if (!res.headersSent) res.status(404); res.end(); })
      .pipe(res);
  });

  r.delete('/attachments/:id', (req, res) => {
    tickets.deleteAttachment(req.user, int(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Administration ----------
  const admin = express.Router();
  admin.use(requireRole('admin'));

  admin.get('/settings', (req, res) => res.json({ settings: settings.publicView(), redirectUri: oidcAuth.redirectUri(), languages: LANGUAGES }));

  admin.put('/settings', wrap(async (req, res) => {
    const incoming = req.body?.settings || {};
    for (const k of Object.keys(incoming)) if (!(k in DEFAULTS)) delete incoming[k];
    if (incoming['ldap.caPem'] !== undefined && incoming['ldap.caPem']) {
      incoming['ldap.caPem'] = ldap.mergePem('', incoming['ldap.caPem']);
      incoming['ldap.caInfo'] = JSON.stringify(ldap.splitPem(incoming['ldap.caPem']).map((p) => { const { pem, ...rest } = ldap.describeCert(p); return rest; }));
    }
    settings.setMany(incoming);
    if (Object.keys(incoming).some((k) => k.startsWith('oidc.'))) oidcAuth.resetOidcCache();
    if (Object.keys(incoming).some((k) => k.startsWith('imap.'))) poller.start();
    if (Object.keys(incoming).some((k) => k.startsWith('ldap.'))) ctx.ldapCertWarning = null;
    log.info(`Einstellungen geändert von ${req.user.username}`, { keys: Object.keys(incoming) });
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

  admin.get('/system', (req, res) => {
    const backups = fs.existsSync(paths.backups)
      ? fs.readdirSync(paths.backups).filter((f) => f.endsWith('.sqlite')).sort().reverse().slice(0, 30)
        .map((f) => ({ name: f, size: fs.statSync(`${paths.backups}/${f}`).size }))
      : [];
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
      warnings: adminWarnings(),
    });
  });

  admin.post('/backup', wrap(async (req, res) => {
    const file = await backupDatabase(db, 'manuell');
    res.json({ ok: true, file: file.split('/').pop() });
  }));

  // ---------- Import aus Jira ----------
  /** Verbindungsdaten prüfen; sie werden nie gespeichert, nur für den laufenden Import im Speicher gehalten */
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
    log.warn('Jira-Import', { error: e.message });
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
    const job = jiraImporter.start(jiraConn(req.body), {
      projects: req.body.projects, statusMap: req.body.statusMap || {}, typeMap: req.body.typeMap || {}, options: req.body.options || {},
    }, req.user.id);
    log.info(`Jira-Import gestartet von ${req.user.username}`, { projects: job.projects.map((p) => p.key) });
    res.status(202).json({ job });
  }));
  // Gesperrte Empfänger (nach Unzustellbarkeitsberichten)
  admin.get('/mail/suppressions', (req, res) => res.json({ suppressions: suppressions.list() }));
  admin.delete('/mail/suppressions/:address', (req, res) => { suppressions.remove(req.params.address); res.json({ suppressions: suppressions.list() }); });

  admin.get('/import/status', (req, res) => res.json({ job: jiraImporter.status() }));
  admin.post('/import/cancel', (req, res) => res.json({ job: jiraImporter.cancel() }));

  r.use('/admin', admin);
  return r;
}
